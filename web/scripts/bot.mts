// Ukiyo replay bot: drives real BTC/USD 2024 prices through the deployed hook-exclusive pool, one hour of 2024 per
// step, so the scoreboard has live activity to measure. After 31 Dec it runs back through the year, then forwards again,
// so the price path never jumps.
//
// Each step, in one block:
//   1. an arbitrageur moves the pool to the hour's Bitstamp close, stopping one fee-width short, and bids a priority
//      fee above the hook's threshold (so the hook classifies it as arbitrage);
//   2. zero to three users swap random sizes in random directions with no priority fee (user flow).
// Then the curators act (the tight chaser recentres when the price leaves its range; the vol-adaptive curator resizes
// its range to recent volatility once a day) and any vault whose epoch is over is settled.
//
//   node scripts/bot.mts                         # anvil, default keys
//   RPC_URL=https://sepolia.unichain.org PRIVATE_KEY=0x... node scripts/bot.mts
//
// Env: RPC_URL, PRIVATE_KEY (deployer = arbitrageur = curator), STEP_MS (default 4000), START_HOUR (default: resume),
// RPC_FALLBACK (comma-separated RPCs tried when RPC_URL fails; publicnode by default on Unichain Sepolia).
//
// It exits (code 1) after MAX_FAILS failed steps in a row or a step that hangs past STEP_TIMEOUT_MS, so that a
// supervisor (scripts/ukiyo-bot.service) restarts it with fresh clients: a restart is what clears a wedged nonce.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  keccak256,
  encodeFunctionData,
  encodePacked,
  parseEther,
  maxUint256,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry, unichainSepolia } from "viem/chains";
import { hookAbi, vaultAbi, tokenAbi, routerAbi } from "../src/lib/abi.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const STEP_MS = Number(process.env.STEP_MS ?? 4000);
// median user trade in USD
const USER_MEDIAN_USD = Number(process.env.USER_MEDIAN_USD ?? 30_000);
// most user swaps per step; with the median size this sets user volume per replayed hour, ~4-5% of the pool's value as
// in the backtest, where users (not arbitrageurs) pay most of the fees
const USER_SWAPS_MAX = Number(process.env.USER_SWAPS_MAX ?? 8);
// Users set a slippage limit like real traders: together they move the price at most this far from the post-arbitrage
// price in either direction (a swap that would start past its limit simply reverts, as a real one would). This keeps
// the test pool in the backtest's regime of small user trades. Without it, thin active liquidity let three swaps move
// the price ~3.5% an hour, and whenever they spilled into a block of their own (Unichain makes one a second), the hook
// rightly marked after the first of them and charged the reversal to the curators.
const USER_MAX_MOVE_BPS = Number(process.env.USER_MAX_MOVE_BPS ?? 60);
// anvil's first four well-known dev keys; never used anywhere but a local chain
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];

// Poll for receipts at about the block time (viem's default is 4 s; Unichain makes a block every second, and a step
// waits for several receipts in turn).
const POLL_MS = Number(process.env.POLL_MS ?? 750);
// the public RPC rate-limits by IP, so reads and sends fall back to a second provider instead of failing the step
const RPCS = [
  RPC,
  ...(process.env.RPC_FALLBACK ?? (RPC.includes("sepolia.unichain.org") ? "https://unichain-sepolia-rpc.publicnode.com" : ""))
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
];
const transport = () => (RPCS.length > 1 ? fallback(RPCS.map((u) => http(u))) : http(RPC));
const pc = createPublicClient({ transport: transport(), pollingInterval: POLL_MS });
// Sends a step's signed transactions in one JSON-RPC batch, so the sequencer receives them together.
const burst = createPublicClient({ transport: http(RPC, { batch: { wait: 20 } }) });
const chainId = await pc.getChainId();
const chain = [unichainSepolia, baseSepolia].find((c) => c.id === chainId) ?? foundry;
const dep = JSON.parse(readFileSync(new URL(`../src/deployments/${chainId}.json`, import.meta.url), "utf8"));
const closes: number[] = JSON.parse(
  readFileSync(new URL("../src/data/btc2024_hourly.json", import.meta.url), "utf8"),
).close;
/**
 * The external price at replay hour `h`. Past the end of the year the replay runs backwards through it, then forwards
 * again, so the path stays continuous: wrapping from 31 Dec (~$93k) to 1 Jan (~$42k) would move the pool 55% in one
 * block, an arbitrage loss no curator could manage and a cliff in every chart.
 */
const closeAt = (h: number) => {
  const n = closes.length;
  const i = ((h % (2 * n)) + 2 * n) % (2 * n);
  return closes[i < n ? i : 2 * n - 1 - i];
};
const STATE = new URL(`./.bot-state-${chainId}.json`, import.meta.url);

// accept the key with or without its 0x prefix, as forge does
const envKey = process.env.PRIVATE_KEY?.trim();
const mainKey = (envKey ? (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as Hex : undefined) ??
  (chainId === 31337 ? ANVIL_KEYS[0] : undefined);
if (!mainKey) throw new Error("set PRIVATE_KEY");
// Users need their own accounts so their swaps land in the same block as the arbitrage, ordered by priority fee.
const userKeys: Hex[] =
  chainId === 31337 ? ANVIL_KEYS.slice(1) : [1, 2, 3].map((i) => keccak256(encodePacked(["bytes32", "uint256"], [mainKey, BigInt(i)])));
const main = createWalletClient({ account: privateKeyToAccount(mainKey), chain, transport: transport(), pollingInterval: POLL_MS });
const users = userKeys.map((k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: transport(), pollingInterval: POLL_MS }));

const hook = dep.hook as Address;
const router = dep.router as Address;
const threshold = BigInt(dep.threshold);
const FEE = dep.fee / 1e6;
const key = {
  currency0: dep.token0 as Address,
  currency1: dep.token1 as Address,
  fee: dep.fee,
  tickSpacing: dep.tickSpacing,
  hooks: hook,
} as const;
const btcIs0 = (dep.btc as string).toLowerCase() === (dep.token0 as string).toLowerCase();
const vaults: { address: Address; name: string }[] = dep.vaults;

/** Pool price as tUSD per tBTC. */
async function poolPrice(): Promise<number> {
  const s = await pc.readContract({ address: hook, abi: hookAbi, functionName: "sqrtPriceX96" });
  const p = (Number(s) / 2 ** 96) ** 2; // token1 per token0
  return btcIs0 ? p : 1 / p;
}

/** sqrt price limit for a tUSD-per-tBTC price. */
function sqrtLimit(usdPerBtc: number): bigint {
  const p = btcIs0 ? usdPerBtc : 1 / usdPerBtc;
  return BigInt(Math.round(Math.sqrt(p) * 2 ** 48)) * 2n ** 48n;
}

const tickOf = (usdPerBtc: number) => Math.floor(Math.log(btcIs0 ? usdPerBtc : 1 / usdPerBtc) / Math.log(1.0001));
const floorT = (t: number) => Math.floor(t / dep.tickSpacing) * dep.tickSpacing;
const ceilT = (t: number) => Math.ceil(t / dep.tickSpacing) * dep.tickSpacing;

/** Mint test tokens and approve the router once per account; top up gas on testnets. */
async function setup() {
  for (const w of [main, ...users]) {
    const me = w.account.address;
    if (chainId !== 31337) {
      const bal = await pc.getBalance({ address: me });
      if (w !== main && bal < parseEther("0.001")) {
        const h = await main.sendTransaction({ to: me, value: parseEther("0.003") });
        await pc.waitForTransactionReceipt({ hash: h });
        console.log("funded", me);
      }
    }
    for (const t of [dep.token0, dep.token1] as Address[]) {
      const allowance = await pc.readContract({ address: t, abi: tokenAbi, functionName: "allowance", args: [me, router] });
      if (allowance < 2n ** 200n) {
        await pc.waitForTransactionReceipt({
          hash: await w.writeContract({ address: t, abi: tokenAbi, functionName: "mint", args: [me, parseEther("1000000000")] }),
        });
        await pc.waitForTransactionReceipt({
          hash: await w.writeContract({ address: t, abi: tokenAbi, functionName: "approve", args: [router, maxUint256] }),
        });
      }
    }
  }
}

/**
 * A swap through the test router, signed locally (exact input; `limit` caps how far the price moves). Signing first
 * and sending a step's transactions in one batch makes them reach the sequencer together; sent one request each, with
 * nonce lookups on the way, the arbitrage and the users kept landing in different blocks.
 */
function signSwap(w: (typeof users)[number], zeroForOne: boolean, amountIn: bigint, limit: bigint, tip: bigint, maxFee: bigint, nonce: number) {
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "swap",
    args: [
      key,
      { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });
  return w.account.signTransaction({
    chainId,
    type: "eip1559",
    to: router,
    data,
    nonce,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
    // Fixed and generous: an estimate is taken against the state before this block's arbitrage, but the swap runs
    // after it and may pay for the hook's per-block bookkeeping, so estimates ran out of gas. Only gas used is paid.
    gas: 1_500_000n,
  });
}

/** The next nonce of each wallet, read once per step so signing needs no further round trips. */
const nonceOf = (w: (typeof users)[number]) => pc.getTransactionCount({ address: w.account.address, blockTag: "pending" });

/** Box-Muller lognormal: median `m`. */
const lognormal = (m: number, s: number) => m * Math.exp(s * Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random()));

async function step(h: number) {
  const ext = closeAt(h);
  const block = await pc.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  // every send of a step goes out together so they share a block; the priority fee then puts the arbitrage first
  const signed: Promise<Hex>[] = [];
  const [mainNonce, ...userNonces] = await Promise.all([main, ...users.slice(0, 2)].map(nonceOf));

  // 1. arbitrage, top of block: move the pool to within one fee-width of the external price
  const p = await poolPrice();
  let post = p; // where the arbitrage leaves the price: the reference for the users' slippage limits
  let arb = "";
  if (p < ext / (1 + FEE) || p > ext / (1 - FEE)) {
    const up = p < ext; // pool too cheap: buy tBTC with tUSD
    const target = up ? ext / (1 + FEE) : ext / (1 - FEE);
    const buyBtcIs1to0 = btcIs0; // buying token0 means paying token1 (oneForZero)
    const zeroForOne = up ? !buyBtcIs1to0 : buyBtcIs1to0;
    const tip = threshold * 3n;
    signed.push(signSwap(main, zeroForOne, parseEther("1000000000"), sqrtLimit(target), tip, base * 2n + tip, mainNonce));
    arb = `${up ? "↑" : "↓"} ${p.toFixed(0)}→${target.toFixed(0)}`;
    post = target;
  }

  // 2. user flow, no priority fee: up to USER_SWAPS_MAX random orders, combined into one swap for the buyers and one for
  // the sellers (from two different wallets). Few transactions per step matter on Unichain: a burst that a block
  // boundary cuts leaves a block that opens with a user swap, which the hook marks after (see the README).
  const n = 1 + Math.floor(Math.random() * USER_SWAPS_MAX);
  const usdBy = { buy: 0, sell: 0 };
  for (let i = 0; i < n; i++) usdBy[Math.random() < 0.5 ? "sell" : "buy"] += Math.min(lognormal(USER_MEDIAN_USD, 0.9), USER_MEDIAN_USD * 9);
  const m = USER_MAX_MOVE_BPS / 1e4;
  (["buy", "sell"] as const).forEach((side, w) => {
    const usd = usdBy[side];
    if (usd === 0) return;
    const sellBtc = side === "sell";
    const zeroForOne = sellBtc === btcIs0;
    const amount = parseEther((sellBtc ? usd / ext : usd).toFixed(12));
    const limit = sqrtLimit(sellBtc ? post * (1 - m) : post * (1 + m));
    signed.push(signSwap(users[w], zeroForOne, amount, limit, 0n, base * 2n + 1n, userNonces[w]));
  });
  const raws = await Promise.all(signed);
  const hashes = await Promise.all(raws.map((serializedTransaction) => burst.sendRawTransaction({ serializedTransaction })));
  const receipts = await Promise.all(hashes.map((hash) => pc.waitForTransactionReceipt({ hash })));
  const blocks = new Set(receipts.map((r) => r.blockNumber));
  const failedTx = receipts.filter((r) => r.status !== "success");
  const failed = failedTx.length;
  // a user swap that would start past its slippage limit reverts by design; it is counted, not logged one by one

  // 3. curators
  const after = await poolPrice();
  const tick = tickOf(after);
  await curate(h, tick, after);

  // 4. settle finished epochs
  const now = (await pc.getBlock()).timestamp;
  for (const v of vaults) {
    const end = await pc.readContract({ address: v.address, abi: vaultAbi, functionName: "epochEndsAt" });
    if (now >= end) {
      await pc.waitForTransactionReceipt({ hash: await main.writeContract({ address: v.address, abi: vaultAbi, functionName: "settleEpoch", gas: 3_000_000n }) });
      console.log(`  settled ${v.name}`);
    }
  }

  const edges = await Promise.all(
    vaults.map((_, i) => pc.readContract({ address: hook, abi: hookAbi, functionName: "edge", args: [BigInt(i)] })),
  );
  console.log(
    `h${h} ext ${ext} pool ${after.toFixed(0)} ${arb || "no arb"} · ${n} user · ${blocks.size} block(s)${failed ? ` · ${failed} FAILED` : ""}` +
      ` · edge $${edges.map((e) => Number(formatEther(e)).toFixed(0)).join(" / $")}`,
  );
}

/** Curator strategies, run as the vaults' curator. */
async function curate(h: number, tick: number, price: number) {
  for (const [i, v] of vaults.entries()) {
    const s = await pc.readContract({ address: hook, abi: hookAbi, functionName: "sleeve", args: [BigInt(i)] });
    // how far the price is outside the range, in ticks (0 inside)
    const away = tick < s.tickLower ? s.tickLower - tick : tick >= s.tickUpper ? tick - s.tickUpper + 1 : 0;
    const halfNow = (s.tickUpper - s.tickLower) / 2;
    const outside = away > halfNow; // well outside: more than half the range's width away
    let half = 0;
    if (v.name.includes("Tight") && outside) half = 150;
    if (v.name.includes("Vol") && h % 24 === 0 && h >= 168) {
      // width: 3 sigma of daily moves, from the last week of hourly closes
      const w = Array.from({ length: 168 }, (_, k) => closeAt(h - 168 + k));
      const r = w.slice(1).map((x, k) => Math.log(x / w[k]));
      const sd = Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length) * Math.sqrt(24);
      const want = Math.max(60, Math.round((3 * sd) / 1e-4));
      if (outside || Math.abs(want - halfNow) / halfNow > 0.3) half = want;
    }
    if (half && (await pc.readContract({ address: v.address, abi: vaultAbi, functionName: "onProbation" }))) {
      // the vault stopped this curator after a drawdown of its Edge index: it holds still until probation is served
      console.log(`  ${v.name} wants to rebalance but is on probation`);
      half = 0;
    }
    if (half) {
      // Recentre around the price. If the vault holds mostly one token (the price ran through its range), swap the
      // excess toward a 50/50 value mix first with rebalanceWithSwap: the vault's swap is capped at a 1% price move
      // and booked as arbitrage by the hook, so it never flatters this curator's Edge.
      const [h0, h1] = await pc.readContract({ address: v.address, abi: vaultAbi, functionName: "holdings" });
      const [b, u] = btcIs0 ? [h0, h1] : [h1, h0];
      const btcVal = Number(formatEther(b)) * price;
      const usdVal = Number(formatEther(u));
      const total = btcVal + usdVal;
      const lo = floorT(tick - half);
      const hi = ceilT(tick + half);
      let hash: Hex;
      if (total > 0 && Math.abs(usdVal / total - 0.5) > 0.15) {
        const sellUsd = usdVal > btcVal;
        const excessUsd = Math.abs(usdVal - btcVal) / 2;
        const amountIn = parseEther((sellUsd ? excessUsd : excessUsd / price).toFixed(12));
        const zeroForOne = sellUsd ? !btcIs0 : btcIs0; // selling token0 = zeroForOne
        hash = await main.writeContract({
          address: v.address,
          abi: vaultAbi,
          functionName: "rebalanceWithSwap",
          args: [lo, hi, zeroForOne, amountIn],
          gas: 4_000_000n,
        });
      } else {
        hash = await main.writeContract({ address: v.address, abi: vaultAbi, functionName: "rebalance", args: [lo, hi], gas: 3_000_000n });
      }
      await pc.waitForTransactionReceipt({ hash });
      console.log(`  ${v.name} rebalanced to [${lo}, ${hi}]`);
    }
  }
}

await setup();
let h = process.env.START_HOUR ? Number(process.env.START_HOUR) : existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")).hour : 0;
console.log(`replaying BTC/USD 2024 (forwards, then backwards) from hour ${h} on chain ${chainId}, one hour per ${STEP_MS} ms`);
const MAX_FAILS = Number(process.env.MAX_FAILS ?? 12);
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 180_000);
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection, exiting for a clean restart:", (e as Error)?.message?.split("\n")[0]);
  process.exit(1);
});
let fails = 0;
for (;;) {
  const t0 = Date.now();
  try {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      step(h),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`step hung for ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer));
    h++;
    fails = 0;
    writeFileSync(STATE, JSON.stringify({ hour: h }));
  } catch (e) {
    if (++fails >= MAX_FAILS || (e as Error).message.startsWith("step hung")) {
      console.error(`h${h} failed ${fails} time(s) in a row (${(e as Error).message.split("\n")[0]}); exiting so the supervisor restarts it fresh`);
      process.exit(1);
    }
    // viem's first line is generic ("Transaction creation failed."); the cause is in `details`
    const err = e as Error & { details?: string; shortMessage?: string };
    console.error(`h${h} failed:`, err.shortMessage ?? err.message.split("\n")[0], err.details ? `(${err.details})` : "");
  }
  await new Promise((r) => setTimeout(r, Math.max(0, STEP_MS - (Date.now() - t0))));
}
