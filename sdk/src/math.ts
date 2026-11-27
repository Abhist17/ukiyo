// Exact bigint ports of the Solidity maths Ukiyo books with: EdgeMath, plus the pieces of Uniswap v4's FullMath,
// TickMath and ProtocolFeeLibrary it relies on. Same inputs give the same wei as the hook, including rounding, which
// test/EdgeMathVectors.t.sol checks on the Solidity side against vectors this file produced (sdk/test/vectors.json).

/** 2^96, the fixed-point base of `sqrtPriceX96`. */
export const Q96 = 1n << 96n;
/** Uniswap v4 fee unit: hundredths of a basis point, 1e6 = 100%. */
export const PIPS = 1_000_000n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const MAX_UINT256 = (1n << 256n) - 1n;

/** A result Solidity would revert on (overflow, division by zero, out-of-range tick). */
export class MathRevert extends Error {}

function fit(r: bigint): bigint {
  if (r > MAX_UINT256) throw new MathRevert("uint256 overflow");
  return r;
}

/** FullMath.mulDiv: floor(a * b / d), reverting where Solidity would. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new MathRevert("division by zero");
  return fit((a * b) / d);
}

/** FullMath.mulDivRoundingUp: ceil(a * b / d). */
export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new MathRevert("division by zero");
  const p = a * b;
  return fit(p / d + (p % d === 0n ? 0n : 1n));
}

/** Clamp a square-root price into a sleeve's range. */
export function clip(s: bigint, lower: bigint, upper: bigint): bigint {
  return s < lower ? lower : s > upper ? upper : s;
}

function clippedMove(s0: bigint, s1: bigint, lower: bigint, upper: bigint): [bigint, bigint] {
  const a = clip(s0, lower, upper);
  const b = clip(s1, lower, upper);
  return [a, b > a ? b - a : a - b];
}

/**
 * Rebalancing loss of a sleeve when the price moves between two marks: `l * (c1 - c0)^2 / c0`, rounded UP.
 * This is the arbitrage-loss term: what arbitrage takes from a position when the fair price moves.
 */
export function rebalancingLoss(l: bigint, s0: bigint, s1: bigint, lower: bigint, upper: bigint): bigint {
  const [c0, d] = clippedMove(s0, s1, lower, upper);
  if (d === 0n) return 0n;
  return mulDivRoundingUp(l, mulDivRoundingUp(d, d, c0), Q96);
}

/** Price-impact credit for user flow: the same closed form from the post-arbitrage mark to the close, rounded DOWN. */
export function impactCredit(l: bigint, sPost: bigint, sClose: bigint, lower: bigint, upper: bigint): bigint {
  const [c0, d] = clippedMove(sPost, sClose, lower, upper);
  if (d === 0n) return 0n;
  return mulDiv(l, mulDiv(d, d, c0), Q96);
}

/** ProtocolFeeLibrary.calculateSwapFee: `protocolFee + lpFee - protocolFee * lpFee / 1e6` (12-bit protocol fee). */
export function calculateSwapFee(protocolFee: number, lpFee: number): bigint {
  const p = BigInt(protocolFee & 0xfff);
  const f = BigInt(lpFee & 0xffffff);
  return p + f - (p * f) / PIPS;
}

/** The LPs' fee per unit of a swap's net input, as [numerator, denominator] (see EdgeMath.lpFeeRate). */
export function lpFeeRate(lpFee: number, protocolFee: number): [bigint, bigint] {
  const total = protocolFee === 0 ? BigInt(lpFee) : calculateSwapFee(protocolFee, lpFee);
  if (total >= PIPS) return [0n, 1n];
  return [total - BigInt(protocolFee), PIPS - total];
}

/** Value a token0 amount in token1 at a square-root price, rounded DOWN. */
export function token0ToToken1(amount0: bigint, s: bigint): bigint {
  return mulDiv(mulDiv(amount0, s, Q96), s, Q96);
}

/**
 * LP fee a sleeve earns from one swap that moves the price from `s0` to `s1`, in token1, rounded DOWN. Its share of
 * the swap's input is exact from the price path; a token0 fee is valued at `s1`.
 */
export function swapFee(
  l: bigint,
  s0: bigint,
  s1: bigint,
  lower: bigint,
  upper: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (numerator === 0n) return 0n;
  const c0 = clip(s0, lower, upper);
  const c1 = clip(s1, lower, upper);
  if (c0 === c1) return 0n;
  if (c1 > c0) return mulDiv(mulDiv(l, c1 - c0, Q96), numerator, denominator);
  const net0 = mulDiv(mulDiv(l, c0 - c1, c1), Q96, c0);
  return token0ToToken1(mulDiv(net0, numerator, denominator), s1);
}

// TickMath's Q128.128 factors 1/sqrt(1.0001^(2^i)), i = 1..19 (bit 0 is handled first).
const TICK_FACTORS: bigint[] = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** TickMath.getSqrtPriceAtTick: sqrt(1.0001^tick) * 2^96, exactly as v4 computes it. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new MathRevert("tick must be an integer");
  const abs = Math.abs(tick);
  if (abs > MAX_TICK) throw new MathRevert("invalid tick");
  let price = abs & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (let i = 0; i < TICK_FACTORS.length; i++) if (abs & (2 << i)) price = (price * TICK_FACTORS[i]) >> 128n;
  if (tick > 0) price = MAX_UINT256 / price;
  return (price + (1n << 32n) - 1n) >> 32n;
}

/** Price of token0 in token1 units (decimals applied) from a sqrt price, as a float for display. */
export function sqrtToPrice(sqrtPriceX96: bigint, decimals0 = 18, decimals1 = 18): number {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  return r * r * 10 ** (decimals0 - decimals1);
}

/** The sqrt price (Q64.96) of a token1-per-token0 price, for what-if maths. Float-accurate, not exact. */
export function priceToSqrt(price: number, decimals0 = 18, decimals1 = 18): bigint {
  if (!(price > 0)) throw new MathRevert("price must be positive");
  const raw = price / 10 ** (decimals0 - decimals1);
  // split so the float keeps its 53 bits of precision before scaling by 2^96
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 48)) << 48n;
}
