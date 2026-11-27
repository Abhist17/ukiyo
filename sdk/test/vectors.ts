// The vector set shared with Foundry (see scripts/vectors.ts). Deterministic: a fixed seed, so the file only changes
// when the maths or this generator does.
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  MathRevert,
  getSqrtPriceAtTick,
  impactCredit,
  lpFeeRate,
  rebalancingLoss,
  swapFee,
} from "../src/math.ts";

/** xorshift64*, so every run draws the same numbers. */
function rng(seed: bigint) {
  let x = seed;
  const M = (1n << 64n) - 1n;
  return () => {
    x ^= x >> 12n;
    x ^= (x << 25n) & M;
    x ^= x >> 27n;
    return (x * 2685821657736338717n) & M;
  };
}

export function vectors() {
  const next = rng(0x5eed_0f_0c11ce5n);
  const int = (lo: number, hi: number) => lo + Number(next() % BigInt(hi - lo + 1));
  const bits = (n: number) => {
    let v = 0n;
    for (let i = 0; i < n; i += 64) v = (v << 64n) | next();
    return v & ((1n << BigInt(n)) - 1n);
  };

  const ticks = [MIN_TICK, MIN_TICK + 1, -1, 0, 1, MAX_TICK - 1, MAX_TICK];
  for (let i = 0; i < 120; i++) ticks.push(int(MIN_TICK, MAX_TICK));
  const tickSqrt = ticks.map((t) => getSqrtPriceAtTick(t).toString());

  const fees: [number, number][] = [[500, 0], [3000, 0], [100, 0], [10000, 0], [500, 100], [3000, 1000], [500, 1000], [999_999, 0], [1_000_000, 0], [0, 0]];
  const feeRates = fees.map(([lp, p]) => lpFeeRate(lp, p).map(String));

  const c = { l: [] as string[], s0: [] as string[], s1: [] as string[], lower: [] as string[], upper: [] as string[], fee: [] as number[], loss: [] as string[], credit: [] as string[], swapFee: [] as string[] };
  const priceNear = (tick: number) => {
    // a price between ticks, so the vectors are not only tick-aligned
    const t = Math.max(MIN_TICK, Math.min(MAX_TICK - 1, tick));
    const a = getSqrtPriceAtTick(t);
    const b = getSqrtPriceAtTick(t + 1);
    return a + (b - a) * BigInt(int(0, 1000)) / 1000n;
  };
  while (c.l.length < 400) {
    const tickA = int(-400_000, 399_000);
    const tickB = int(tickA + 1, Math.min(tickA + int(2, 200_000), 400_000));
    const lower = getSqrtPriceAtTick(tickA);
    const upper = getSqrtPriceAtTick(tickB);
    // prices inside, below and above the range
    const span = Math.floor((tickB - tickA) / 4);
    const s0 = priceNear(int(tickA - span, tickB + span));
    const s1 = c.l.length % 7 === 0 ? s0 : priceNear(int(tickA - span, tickB + span));
    if (s0 < MIN_SQRT_PRICE || s1 < MIN_SQRT_PRICE || s0 >= MAX_SQRT_PRICE || s1 >= MAX_SQRT_PRICE) continue;
    const l = bits(int(20, 110)) + 1n;
    const fee = c.l.length % fees.length;
    const [num, den] = lpFeeRate(...fees[fee]);
    try {
      const out = [rebalancingLoss(l, s0, s1, lower, upper), impactCredit(l, s0, s1, lower, upper), swapFee(l, s0, s1, lower, upper, num, den)];
      c.l.push(l.toString());
      c.s0.push(s0.toString());
      c.s1.push(s1.toString());
      c.lower.push(lower.toString());
      c.upper.push(upper.toString());
      c.fee.push(fee);
      c.loss.push(out[0].toString());
      c.credit.push(out[1].toString());
      c.swapFee.push(out[2].toString());
    } catch (e) {
      if (!(e instanceof MathRevert)) throw e; // Solidity would revert too; such inputs are not vectors
    }
  }
  return {
    ticks: { tick: ticks, sqrtPriceX96: tickSqrt },
    feeRates: { lpFee: fees.map((f) => f[0]), protocolFee: fees.map((f) => f[1]), numerator: feeRates.map((r) => r[0]), denominator: feeRates.map((r) => r[1]) },
    cases: c,
  };
}
