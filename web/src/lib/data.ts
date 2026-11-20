import raw from "@/data/btc2024.json";

/** Pool fee tier of the replay. 5 bps is the demo tier: it tolerates a ~25%-error classifier. */
export type Tier = "5bps" | "30bps";
export const TIERS: Tier[] = ["5bps", "30bps"];

/** The five ways to score a curator. Order is the order of the rank-shift chart, worst yardstick first. */
export type MetricKey = "fees" | "hodl" | "naive" | "edge" | "truth";

export interface Metric {
  key: MetricKey;
  label: string;
  /** One line on what the number rewards. */
  note: string;
}

export const METRICS: Metric[] = [
  { key: "fees", label: "Fee income", note: "Rewards volume, including the arbitrage volume that costs LPs money" },
  { key: "hodl", label: "vs HODL", note: "Rewards being on the right side of the price" },
  { key: "naive", label: "Fees − pool LVR", note: "The obvious on-chain formula: counts arbitrage fees as income" },
  { key: "edge", label: "Ukiyo Edge", note: "User fees + user impact − arbitrage loss, computed in the hook" },
  { key: "truth", label: "True hedged P&L", note: "Fees − true LVR, known only to the simulator" },
];

export const metric = (k: MetricKey) => METRICS.find((m) => m.key === k)!;

export interface Curator {
  name: string;
  short: string;
  style: string;
}

type Series = Record<string, number[][]>;
interface TierData {
  series: Series;
  error: Record<"edge" | "naive", { mae: number; rmse: number; corr: number; bias: number }>;
}

const data = raw as unknown as {
  source: string;
  curators: Curator[];
  weeks: { start: string; btcOpen: number; btcClose: number }[];
  tiers: Record<Tier, TierData>;
};

export const CURATORS = data.curators;
export const WEEKS = data.weeks;
export const SOURCE = data.source;
export const error = (tier: Tier) => data.tiers[tier].error;

/** Weekly values, `[week][curator]`, in bps of the start-of-week value. */
export const weekly = (tier: Tier, key: string): number[][] => data.tiers[tier].series[key];

/** Full-year total per curator, in bps (the sum of weekly bps, as the backtest reports it). */
export function total(tier: Tier, key: string): number[] {
  const w = weekly(tier, key);
  return CURATORS.map((_, i) => w.reduce((s, row) => s + row[i], 0));
}

/** Rank per curator, 1 = highest value. */
export function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const r = new Array<number>(values.length);
  order.forEach(([, i], pos) => (r[i] = pos + 1));
  return r;
}

/** Running total per curator, `[week 0..n][curator]`, starting at zero. */
export function cumulative(tier: Tier, key: string): number[][] {
  const w = weekly(tier, key);
  const out: number[][] = [CURATORS.map(() => 0)];
  for (const row of w) out.push(row.map((v, i) => out[out.length - 1][i] + v));
  return out;
}

/** Mean over all weeks and curators. */
export function mean(tier: Tier, key: string): number {
  const w = weekly(tier, key);
  return w.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0) / (w.length * CURATORS.length);
}

/** Share of curator pairs that two rankings put in the same order. */
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

export function bps(v: number): string {
  return (v < 0 ? "−" : "") + Math.round(Math.abs(v)).toLocaleString("en-US") + " bps";
}
