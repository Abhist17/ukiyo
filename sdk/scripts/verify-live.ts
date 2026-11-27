// Verifies the live deployment against this repository, from public chain data only:
//
//   1. Code: every deployed contract's runtime bytecode equals what `forge build` produces here (immutables masked).
//   2. Reads: the Lens reports exactly what the hook does, and every sleeve's Edge = fees + impact − loss.
//   3. Classification: for every swap in the window, the hook's arbitrage/user call matches the transaction's real tip
//      against the threshold (or a vault trading for itself).
//   4. Books: an independent replay of recent blocks, from prices and liquidity alone, reproduces each sleeve's
//      ledger change to the wei (user fees, arbitrage fees, impact credit, arbitrage loss).
//
// Run from sdk/ after `forge build` at the root:  npm run verify:live
// (RPC_URL to override; BLOCKS=N classification window, default 2000; REPLAY=N blocks replayed, default 40)
import { readFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, parseAbiItem, type Address, type Hex, type Log } from "viem";
import { unichainSepolia } from "viem/chains";
import { factoryAbi, hookAbi, lensAbi } from "../src/abi.ts";
import { createUkiyo } from "../src/client.ts";
import { DEPLOYMENTS } from "../src/deployments.ts";
import { getSqrtPriceAtTick, impactCredit, lpFeeRate, rebalancingLoss, swapFee } from "../src/math.ts";

const dep = DEPLOYMENTS[unichainSepolia.id];
// Not the chain's default RPC: its rate limit is per IP, and the replay bot (or the app) may be using it from this
// machine. publicnode keeps ~10,000 blocks of state, enough for the window below.
const rpc = process.env.RPC_URL ?? "https://unichain-sepolia-rpc.publicnode.com";
const WINDOW = BigInt(process.env.BLOCKS ?? 2000);
// gentle on the public RPC (its rate limit is per IP, and the replay bot may share it): batched, slow retries, pauses
const client = createPublicClient({ chain: unichainSepolia, transport: http(rpc, { batch: { batchSize: 20 }, retryCount: 6, retryDelay: 1500 }) });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPLAY = Number(process.env.REPLAY ?? 40);
const ukiyo = createUkiyo({ client });

let failures = 0;
const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
};
const check = (cond: boolean, msg: string) => (cond ? ok(msg) : bad(msg));

// ---------------------------------------------------------------------------------------------------------------
console.log("1. Deployed code is this repository's code");
function artifact(path: string): { code: string; masks: { start: number; length: number }[] } {
  const j = JSON.parse(readFileSync(new URL(`../../out/${path}`, import.meta.url), "utf8"));
  const masks = Object.values(j.deployedBytecode.immutableReferences ?? {}).flat() as { start: number; length: number }[];
  return { code: j.deployedBytecode.object.slice(2), masks };
}
function mask(code: string, masks: { start: number; length: number }[]) {
  const b = code.split("");
  for (const m of masks) for (let k = m.start * 2; k < (m.start + m.length) * 2; k++) b[k] = "0";
  return b.join("");
}
const factoryVaults = (
  await Promise.all(
    Array.from({ length: 8 }, (_, k) =>
      client.readContract({ address: dep.factory!, abi: factoryAbi, functionName: "vaults", args: [BigInt(k)] }).catch(() => null),
    ),
  )
).filter((a): a is Address => !!a);
const targets: [string, Address, string][] = [
  ["UkiyoHook", dep.hook, "UkiyoHook.sol/UkiyoHook.json"],
  ["UkiyoLens", dep.lens!, "UkiyoLens.sol/UkiyoLens.json"],
  ["UkiyoFactory", dep.factory!, "UkiyoFactory.sol/UkiyoFactory.json"],
  ["UkiyoSkillRouter", dep.skillRouter!, "UkiyoSkillRouter.sol/UkiyoSkillRouter.json"],
  ...dep.vaults.map((v) => [`UkiyoVault ${v.symbol}`, v.address, "UkiyoVault.sol/UkiyoVault.json"] as [string, Address, string]),
  ...factoryVaults.map((a, k) => [`UkiyoVault (launched #${k})`, a, "UkiyoVault.sol/UkiyoVault.json"] as [string, Address, string]),
];
for (const [name, address, path] of targets) {
  const live = ((await client.getCode({ address })) ?? "0x").slice(2).toLowerCase();
  const a = artifact(path);
  const same = live.length === a.code.length && mask(live, a.masks) === mask(a.code.toLowerCase(), a.masks);
  check(same, `${name} ${address}: ${live.length / 2} bytes, ${same ? "identical" : "DIFFERENT"} (${a.masks.length} immutables masked)`);
}

// ---------------------------------------------------------------------------------------------------------------
console.log("\n2. The Lens agrees with the hook, and Edge = user fees + user impact − arbitrage loss");
const head = (await client.getBlockNumber()) - 2n;
const board = await ukiyo.scoreboard(head);
for (const r of board.rows) {
  const id = BigInt(r.sleeveId);
  const [ledger, edge, s] = await Promise.all([
    client.readContract({ address: dep.hook, abi: hookAbi, functionName: "ledger", args: [id], blockNumber: head }),
    client.readContract({ address: dep.hook, abi: hookAbi, functionName: "edge", args: [id], blockNumber: head }),
    client.readContract({ address: dep.hook, abi: hookAbi, functionName: "sleeve", args: [id], blockNumber: head }),
  ]);
  const same =
    ledger.userFees === r.ledger.userFees && ledger.userImpact === r.ledger.userImpact && ledger.arbLoss === r.ledger.arbLoss &&
    ledger.arbFees === r.ledger.arbFees && edge === r.edge && s.liquidity === r.liquidity && s.tickLower === r.tickLower;
  check(same && edge === ledger.userFees + ledger.userImpact - ledger.arbLoss, `${r.name}: Lens = hook, Edge identity holds`);
}

// ---------------------------------------------------------------------------------------------------------------
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const meta = await ukiyo.poolMeta();
const from = head - WINDOW + 1n;
const hookLogs: Log[] = [];
const swapLogs: Log[] = [];
for (let f = from; f <= head; f += 1000n) {
  const t = f + 999n < head ? f + 999n : head;
  const [h, s] = await Promise.all([
    client.getLogs({ address: dep.hook, fromBlock: f, toBlock: t }),
    client.getLogs({ address: meta.poolManager, event: SWAP, args: { id: meta.poolId }, fromBlock: f, toBlock: t }),
  ]);
  hookLogs.push(...h);
  swapLogs.push(...s);
}
type Ev = { block: bigint; index: number; tx: Hex; name: string; args: Record<string, unknown> };
const events: Ev[] = [];
for (const l of hookLogs) {
  try {
    const e = decodeEventLog({ abi: hookAbi, data: l.data, topics: l.topics });
    events.push({ block: l.blockNumber!, index: l.logIndex!, tx: l.transactionHash!, name: e.eventName, args: e.args as Record<string, unknown> });
  } catch {
    // ownership or other admin events
  }
}
for (const l of swapLogs as (Log & { args: Record<string, unknown> })[])
  events.push({ block: l.blockNumber!, index: l.logIndex!, tx: l.transactionHash!, name: "Swap", args: l.args });
events.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));

console.log(`\n3. Every swap's classification matches its real tip (blocks ${from}–${head})`);
const threshold = await client.readContract({ address: dep.hook, abi: hookAbi, functionName: "priorityFeeThreshold", blockNumber: head });
const classified = events.filter((e) => e.name === "SwapClassified");
const managers = new Set(dep.vaults.map((v) => v.address.toLowerCase()).concat(factoryVaults.map((a) => a.toLowerCase())));
let tipOk = 0;
let callOk = 0;
const txs = [...new Set(classified.map((e) => e.tx))];
const baseFees = new Map<bigint, Promise<bigint>>();
const baseFee = (n: bigint) => {
  if (!baseFees.has(n)) baseFees.set(n, client.getBlock({ blockNumber: n }).then((b) => b.baseFeePerGas ?? 0n));
  return baseFees.get(n)!;
};
for (let i = 0; i < txs.length; i += 10) {
  await pause(400);
  await Promise.all(
    txs.slice(i, i + 10).map(async (hash) => {
      const rc = await client.getTransactionReceipt({ hash });
      const base = await baseFee(rc.blockNumber);
      const tip = rc.effectiveGasPrice > base ? rc.effectiveGasPrice - base : 0n;
      const mine = events.filter((e) => e.tx === hash);
      for (let k = 0; k < mine.length; k++) {
        if (mine[k].name !== "SwapClassified") continue;
        const swap = mine.slice(k + 1).find((e) => e.name === "Swap");
        const sender = String(swap?.args.sender ?? "").toLowerCase();
        if (mine[k].args.priorityFeePerGas === tip) tipOk++;
        else bad(`${hash}: hook saw tip ${mine[k].args.priorityFeePerGas}, receipt says ${tip}`);
        const want = tip >= threshold || managers.has(sender);
        if (mine[k].args.isArbitrage === want) callOk++;
        else bad(`${hash}: booked ${mine[k].args.isArbitrage ? "arbitrage" : "user"}, rule says ${want ? "arbitrage" : "user"}`);
      }
    }),
  );
}
const arbN = classified.filter((e) => e.args.isArbitrage).length;
check(tipOk === classified.length && callOk === classified.length && classified.length > 0,
  `${classified.length} swaps in ${txs.length} transactions: every tip matches the receipt, every call follows the rule (${arbN} arbitrage, ${classified.length - arbN} user)`);

// ---------------------------------------------------------------------------------------------------------------
console.log("\n4. Independent replay of the books, block by block");
const blocks = [...new Set(events.filter((e) => e.name === "BlockMarked").map((e) => e.block))].slice(-REPLAY);
const [num, den] = lpFeeRate(meta.lpFee, 0);
let replayed = 0;
let sleeveChecks = 0;
const skipped: Record<string, number> = {};
const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
for (const n of blocks) {
  await pause(300);
  const inBlock = events.filter((e) => e.block === n);
  if (inBlock.some((e) => e.name === "SpikeNetted")) { skip("spike netted"); continue; }
  if (inBlock.some((e) => e.name === "SleeveLiquidityModified" || e.name === "SleeveRangeSet")) { skip("liquidity changed in the block"); continue; }
  const swaps = inBlock.filter((e) => e.name === "Swap");
  if (swaps.some((s) => Number(s.args.fee) !== meta.lpFee)) { skip("protocol fee on"); continue; }
  const read = <T,>(functionName: string, args: unknown[] = [], blockNumber = n - 1n) =>
    client.readContract({ address: dep.hook, abi: hookAbi, functionName, args, blockNumber } as never) as Promise<T>;
  const [markPrev, closePrev, pending, count] = await Promise.all([
    read<bigint>("lastPostMark"), read<bigint>("sqrtPriceX96"), read<boolean>("impactPending"), read<bigint>("sleeveCount"),
  ]);
  if (!pending || markPrev === 0n) { skip("no previous mark"); continue; }
  const markN = inBlock.find((e) => e.name === "BlockMarked")!.args.sqrtPostMarkX96 as bigint;
  // pair each Swap with the SwapClassified the hook emitted just before it
  const calls: boolean[] = [];
  let last: boolean | undefined;
  for (const e of inBlock) {
    if (e.name === "SwapClassified") last = e.args.isArbitrage as boolean;
    else if (e.name === "Swap") calls.push(last!);
  }
  let blockOk = true;
  let blockChecked = false;
  for (let i = 0n; i < count; i++) {
    const [s, dual, before, after] = await Promise.all([
      read<{ tickLower: number; tickUpper: number; liquidity: bigint; anchoredLiquidity: bigint }>("sleeve", [i]),
      read<bigint>("dualLiquidity", [i]),
      read<{ userFees: bigint; userImpact: bigint; arbLoss: bigint; arbFees: bigint }>("ledger", [i]),
      read<{ userFees: bigint; userImpact: bigint; arbLoss: bigint; arbFees: bigint }>("ledger", [i], n),
    ]);
    if (s.anchoredLiquidity !== 0n || dual !== 0n) { skip("sleeve with anchored liquidity"); continue; }
    const l = s.liquidity;
    const lo = getSqrtPriceAtTick(s.tickLower);
    const hi = getSqrtPriceAtTick(s.tickUpper);
    const want = { userFees: 0n, userImpact: 0n, arbLoss: 0n, arbFees: 0n };
    if (l > 0n) {
      want.userImpact = impactCredit(l, markPrev, closePrev, lo, hi);
      want.arbLoss = rebalancingLoss(l, markPrev, markN, lo, hi);
      let price = closePrev;
      swaps.forEach((sw, k) => {
        const next = sw.args.sqrtPriceX96 as bigint;
        const fee = swapFee(l, price, next, lo, hi, num, den);
        if (calls[k]) want.arbFees += fee;
        else want.userFees += fee;
        price = next;
      });
    }
    const got = {
      userFees: after.userFees - before.userFees,
      userImpact: after.userImpact - before.userImpact,
      arbLoss: after.arbLoss - before.arbLoss,
      arbFees: after.arbFees - before.arbFees,
    };
    const same = (Object.keys(want) as (keyof typeof want)[]).every((k) => want[k] === got[k]);
    blockChecked = true;
    sleeveChecks++;
    if (!same) {
      blockOk = false;
      bad(`block ${n} sleeve ${i}: replay ${JSON.stringify(want, (_, v) => (typeof v === "bigint" ? v.toString() : v))} vs hook ${JSON.stringify(got, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    }
  }
  if (blockChecked && blockOk) replayed++;
}
check(replayed > 0 && failures === 0,
  `${replayed} blocks, ${sleeveChecks} sleeve-blocks replayed from prices and liquidity alone: every ledger change matches the hook to the wei`);
if (Object.keys(skipped).length) console.log(`    not replayed (rules this simple replay leaves to the Solidity tests): ${JSON.stringify(skipped)}`);

console.log(failures === 0 ? "\n\x1b[32mLive deployment verified.\x1b[0m" : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
