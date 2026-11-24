/** What the narration needs to know about one curator (a subset of VaultLive). */
export interface CuratorLine {
  name: string;
  edge: number;
  edgeReturn: number;
  edgeIndexed: boolean;
  tStat: number;
  edgeEpochs: number;
  hasSkill: boolean;
  onProbation: boolean;
  userFees: number;
  userImpact: number;
  arbLoss: number;
  arbFees: number;
}

/** A return as a signed percentage, with more digits when it is small. */
export function signedPct(r: number): string {
  const p = r * 100;
  const digits = p !== 0 && Math.abs(p) < 0.1 ? 3 : 2;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(digits)}%`;
}

/**
 * The scoreboard in plain words, from the same numbers the table shows: who leads on size-neutral Edge and whether
 * the skill test backs it, whether fee income would rank differently and why, who is on probation, and where the
 * money went. Deterministic, so it never says more than the numbers do.
 */
export function narrate(vaults: CuratorLine[], money: (v: number) => string): string[] {
  if (vaults.length === 0) return [];
  const out: string[] = [];
  const indexed = vaults.filter((v) => v.edgeIndexed);
  if (indexed.length === 0) {
    out.push("No epoch with capital has settled yet, so there is no Edge return to rank; the board fills in as the first epochs settle.");
  } else {
    const lead = [...indexed].sort((a, b) => b.edgeReturn - a.edgeReturn)[0];
    const t = lead.tStat.toFixed(1);
    const skill =
      lead.edgeEpochs < 2
        ? "too early for the skill test"
        : lead.hasSkill
          ? `and its skill test passes (t = ${t}): the Edge is statistically clear of zero`
          : `but its skill test says it could still be luck (t = ${t}, skill needs 2)`;
    out.push(`${lead.name} leads with ${signedPct(lead.edgeReturn)} Edge return, ${skill}.`);

    const feesOf = (v: CuratorLine) => v.userFees + v.arbFees;
    const feeTop = [...vaults].sort((a, b) => feesOf(b) - feesOf(a))[0];
    if (feeTop.name !== lead.name && feesOf(feeTop) > 0) {
      out.push(
        `Ranked by fee income, ${feeTop.name} would be first with ${money(feesOf(feeTop))}, but arbitrage took ${money(feeTop.arbLoss)} from it, so its Edge is ${money(feeTop.edge)}.`,
      );
    }
  }

  const benched = vaults.filter((v) => v.onProbation).map((v) => v.name);
  if (benched.length) {
    out.push(`${benched.join(" and ")} ${benched.length > 1 ? "are" : "is"} on probation after a drawdown and cannot rebalance for now.`);
  }

  const fees = vaults.reduce((a, v) => a + v.userFees, 0);
  const impact = vaults.reduce((a, v) => a + v.userImpact, 0);
  const loss = vaults.reduce((a, v) => a + v.arbLoss, 0);
  if (fees + impact + loss > 0) {
    out.push(`Across all curators, users paid ${money(fees)} in fees and left ${money(impact)} of price impact; arbitrage took ${money(loss)}.`);
  }
  return out;
}
