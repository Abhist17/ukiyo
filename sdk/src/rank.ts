import type { Row } from "./client.ts";

/** What to rank curators by. */
export type RankBy = "edge" | "index" | "tstat" | "fees";

/**
 * How each yardstick scores a row. `fees` is what fee-APR dashboards rank by (every fee, arbitrage's included), kept so
 * the disagreement with Edge can be shown; `index` is the size-neutral Edge return, the fair one across vault sizes.
 */
export const METRICS: Record<RankBy, { label: string; score: (r: Row) => bigint }> = {
  edge: { label: "Edge", score: (r) => r.edge },
  index: { label: "Edge index", score: (r) => (r.isVault ? r.edgeIndex : 0n) },
  tstat: { label: "skill t-stat", score: (r) => (r.isVault ? r.edgeTStat : 0n) },
  fees: { label: "fee income", score: (r) => r.ledger.userFees + r.ledger.arbFees },
};

/** Rows best first by a yardstick; ties keep sleeve order. */
export function rank(rows: readonly Row[], by: RankBy = "edge"): Row[] {
  const s = METRICS[by].score;
  return [...rows].sort((a, b) => {
    const d = s(b) - s(a);
    return d > 0n ? 1 : d < 0n ? -1 : a.sleeveId - b.sleeveId;
  });
}

/** Each sleeve's position (1 = best) under a yardstick, by sleeve id. */
export function positions(rows: readonly Row[], by: RankBy): Map<number, number> {
  return new Map(rank(rows, by).map((r, i) => [r.sleeveId, i + 1]));
}

/** Sleeves that fee income ranks higher than Edge does: where a fee-APR dashboard would mislead. */
export function misranked(rows: readonly Row[]): { row: Row; feeRank: number; edgeRank: number }[] {
  const e = positions(rows, "edge");
  const f = positions(rows, "fees");
  return rows
    .map((row) => ({ row, feeRank: f.get(row.sleeveId)!, edgeRank: e.get(row.sleeveId)! }))
    .filter((x) => x.feeRank < x.edgeRank)
    .sort((a, b) => a.feeRank - b.feeRank);
}
