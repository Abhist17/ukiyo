// Ukiyo replay bot: drives real BTC/USD 2024 prices through the deployed hook-exclusive pool, one hour of 2024 per
// step, so the scoreboard has live activity to measure.
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
// Env: RPC_URL, PRIVATE_KEY (deployer = arbitrageur = curator), STEP_MS (default 4000), START_HOUR (default: resume).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
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
// median user trade in USD; keep it a few percent of the pool's active depth (the backtest's pool is deeper)
const USER_MEDIAN_USD = Number(process.env.USER_MEDIAN_USD ?? 45_000);
// anvil's first four well-known dev keys; never used anywhere but a local chain
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const MIN_SQRT = 4295128740n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

const pc = createPublicClient({ transport: http(RPC) });
const chainId = await pc.getChainId();
const chain = [unichainSepolia, baseSepolia].find((c) => c.id === chainId) ?? foundry;
const dep = JSON.parse(readFileSync(new URL(`../src/deployments/${chainId}.json`, import.meta.url), "utf8"));
const closes: number[] = JSON.parse(
  readFileSync(new URL("../src/data/btc2024_hourly.json", import.meta.url), "utf8"),
).close;
const STATE = new URL(`./.bot-state-${chainId}.json`, import.meta.url);

// accept the key with or without its 0x prefix, as forge does
const envKey = process.env.PRIVATE_KEY?.trim();
const mainKey = (envKey ? (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as Hex : undefined) ??
  (chainId === 31337 ? ANVIL_KEYS[0] : undefined);
if (!mainKey) throw new Error("set PRIVATE_KEY");
// Users need their own accounts so their swaps land in the same block as the arbitrage, ordered by priority fee.
const userKeys: Hex[] =
  chainId === 31337 ? ANVIL_KEYS.slice(1) : [1, 2, 3].map((i) => keccak256(encodePacked(["bytes32", "uint256"], [mainKey, BigInt(i)])));
const main = createWalletClient({ account: privateKeyToAccount(mainKey), chain, transport: http(RPC) });
const users = userKeys.map((k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) }));

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

/** Swap through the test router. Exact input; `limit` caps how far the price moves. */
function swap(w: (typeof users)[number], zeroForOne: boolean, amountIn: bigint, limit: bigint, tip: bigint, maxFee: bigint) {
  return w.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "swap",
    args: [
      key,
      { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
    // estimated, not fixed: a large swap crossing several sleeve boundaries needs more, and a swap that would revert
    // fails here with its reason instead of on-chain
  });
}

/** Box-Muller lognormal: median `m`. */
const lognormal = (m: number, s: number) => m * Math.exp(s * Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random()));

async function step(h: number) {
  const ext = closes[h % closes.length];
  const block = await pc.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  // every send of a step goes out together so they share a block; the priority fee then puts the arbitrage first
  const pending: Promise<Hex>[] = [];

  // 1. arbitrage, top of block: move the pool to within one fee-width of the external price
  const p = await poolPrice();
  let arb = "";
  if (p < ext / (1 + FEE) || p > ext / (1 - FEE)) {
    const up = p < ext; // pool too cheap: buy tBTC with tUSD
    const target = up ? ext / (1 + FEE) : ext / (1 - FEE);
    const buyBtcIs1to0 = btcIs0; // buying token0 means paying token1 (oneForZero)
    const zeroForOne = up ? !buyBtcIs1to0 : buyBtcIs1to0;
    const tip = threshold * 3n;
    pending.push(swap(main, zeroForOne, parseEther("1000000000"), sqrtLimit(target), tip, base * 2n + tip));
    arb = `${up ? "↑" : "↓"} ${p.toFixed(0)}→${target.toFixed(0)}`;
  }

  // 2. user flow, no priority fee
  const n = Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) {
    const usd = Math.min(lognormal(USER_MEDIAN_USD, 0.9), USER_MEDIAN_USD * 9);
    const sellBtc = Math.random() < 0.5;
    const zeroForOne = sellBtc === btcIs0;
    const amount = parseEther((sellBtc ? usd / ext : usd).toFixed(12));
    pending.push(swap(users[i], zeroForOne, amount, zeroForOne ? MIN_SQRT : MAX_SQRT, 0n, base * 2n + 1n));
  }
  const hashes = await Promise.all(pending);
  const receipts = await Promise.all(hashes.map((hash) => pc.waitForTransactionReceipt({ hash })));
  const blocks = new Set(receipts.map((r) => r.blockNumber));
  const failedTx = receipts.filter((r) => r.status !== "success");
  const failed = failedTx.length;
  for (const r of failedTx) console.log(`  reverted ${r.transactionHash} gas ${r.gasUsed}`);

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
    const outside = away > halfNow; // a one-sided range sits just outside the price on purpose
    let half = 0;
    if (v.name.includes("Tight") && outside) half = 150;
    if (v.name.includes("Vol") && h % 24 === 0 && h >= 168) {
      // width: 3 sigma of daily moves, from the last week of hourly closes
      const w = closes.slice(h - 168, h);
      const r = w.slice(1).map((x, k) => Math.log(x / w[k]));
      const sd = Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length) * Math.sqrt(24);
      const want = Math.max(60, Math.round((3 * sd) / 1e-4));
      if (outside || Math.abs(want - halfNow) / halfNow > 0.3) half = want;
    }
    if (half) {
      // A vault never swaps. If it holds mostly one token (the price ran through its range), a symmetric range could
      // not be funded, so it places the range on the side that token can fill, like a range order, and waits for the
      // price to come back to it.
      const [h0, h1] = await pc.readContract({ address: v.address, abi: vaultAbi, functionName: "holdings" });
      const [b, u] = btcIs0 ? [h0, h1] : [h1, h0];
      const btcVal = Number(formatEther(b)) * price;
      const usdVal = Number(formatEther(u));
      const usdShare = usdVal / (btcVal + usdVal || 1);
      // token1 funds ranges below the current tick, token0 ranges above it
      const onlyToken1 = btcIs0 ? usdShare > 0.85 : usdShare < 0.15;
      const onlyToken0 = btcIs0 ? usdShare < 0.15 : usdShare > 0.85;
      let lo = floorT(tick - half);
      let hi = ceilT(tick + half);
      if (onlyToken1) [lo, hi] = [floorT(tick) - 2 * half, floorT(tick)];
      if (onlyToken0) [lo, hi] = [ceilT(tick + 1), ceilT(tick + 1) + 2 * half];
      lo = floorT(lo);
      hi = ceilT(hi);
      await pc.waitForTransactionReceipt({
        hash: await main.writeContract({ address: v.address, abi: vaultAbi, functionName: "rebalance", args: [lo, hi], gas: 3_000_000n }),
      });
      console.log(`  ${v.name} rebalanced to [${lo}, ${hi}]`);
    }
  }
}

await setup();
let h = process.env.START_HOUR ? Number(process.env.START_HOUR) : existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")).hour : 0;
console.log(`replaying BTC/USD 2024 from hour ${h} on chain ${chainId}, one hour per ${STEP_MS} ms`);
for (;;) {
  const t0 = Date.now();
  try {
    await step(h);
    h++;
    writeFileSync(STATE, JSON.stringify({ hour: h }));
  } catch (e) {
    console.error(`h${h} failed:`, (e as Error).message.split("\n")[0]);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, STEP_MS - (Date.now() - t0))));
}
