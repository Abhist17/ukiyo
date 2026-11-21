import raw from "@/data/btc2024.json";
import { pairAgreement, pct, ranks } from "./math";

export { pairAgreement, pct, ranks };

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

export function bps(v: number): string {
  return (v < 0 ? "−" : "") + Math.round(Math.abs(v)).toLocaleString("en-US") + " bps";
}
