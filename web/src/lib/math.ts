// Pure scoring and price maths, free of app imports so the unit tests (test/*.test.mts) can load it directly.

/** Rank per item, 1 = highest value. */
export function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const r = new Array<number>(values.length);
  order.forEach(([, i], pos) => (r[i] = pos + 1));
  return r;
}

/** Share of item pairs that two scorings put in the same order (1 = identical ranking, 0 = reversed). */
export function pairAgreement(a: number[], b: number[]): number {
  let same = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      n++;
      if (Math.sign(a[i] - a[j]) === Math.sign(b[i] - b[j])) same++;
    }
  return same / n;
}

/** bps → signed percent, e.g. 2428 → "+24.3%". */
export function pct(bps: number, digits = 1): string {
  const v = bps / 100;
  const s = Math.abs(v).toFixed(digits);
  return (v > 0 ? "+" : v < 0 ? "−" : "") + s + "%";
}

/** Quote per base from a pool's Q64.96 sqrt price; `baseIs0` says whether the base token is token0. */
export function sqrtToPrice(sqrtPriceX96: bigint, baseIs0: boolean): number {
  const p = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return baseIs0 ? p : 1 / p;
}

/** Quote per base at a tick. */
export function tickToQuote(tick: number, baseIs0: boolean): number {
  const p = 1.0001 ** tick;
  return baseIs0 ? p : 1 / p;
}

/** The tick (rounded down, pool orientation) of a quote-per-base price. */
export function quoteToTick(price: number, baseIs0: boolean): number {
  return Math.floor(Math.log(baseIs0 ? price : 1 / price) / Math.log(1.0001));
}
