"use client";

import { useState } from "react";
import type { Live, VaultLive } from "@/lib/useUkiyo";
import { compactUsd, tickToPrice, usd } from "@/lib/chain";
import { VaultPanel } from "./VaultPanel";
import { LiquidityChart } from "./LiquidityChart";

/** Range bar: where the sleeve sits around the current price (window ±30%). */
function RangeBar({ v, price }: { v: VaultLive; price: number }) {
  const a = Math.min(tickToPrice(v.tickLower), tickToPrice(v.tickUpper));
  const b = Math.max(tickToPrice(v.tickLower), tickToPrice(v.tickUpper));
  const lo = price * 0.7;
  const hi = price * 1.3;
  const x = (p: number) => Math.max(0, Math.min(100, ((p - lo) / (hi - lo)) * 100));
  const inRange = price >= a && price < b;
  return (
    <div className="range" title={`${usd(a)} – ${usd(b)}`}>
      <div className="range-band" style={{ left: `${x(a)}%`, width: `${Math.max(1.5, x(b) - x(a))}%`, background: `var(--s${(v.i % 6) + 1})` }} />
      <div className="range-now" />
      <span className={`range-tag ${inRange ? "in" : "out"}`}>{inRange ? "In range" : "Out of range"}</span>
    </div>
  );
}

/** Edge return as a signed percentage, or a dash before any epoch with capital has settled. */
const pct = (v: VaultLive) =>
  v.edgeIndexed ? `${v.edgeReturn >= 0 ? "+" : ""}${(v.edgeReturn * 100).toFixed(v.edgeReturn !== 0 && Math.abs(v.edgeReturn) < 0.001 ? 4 : 2)}%` : "—";

/** The skill test under a vault's Edge return: its t-statistic, and whether that clears 2 (skill) or not yet. */
function Skill({ v }: { v: VaultLive }) {
  if (v.edgeEpochs < 2) return <span className="skill" title="The skill test needs two settled epochs">testing…</span>;
  const t = Math.abs(v.tStat) >= 99 ? (v.tStat > 0 ? "> 99" : "< −99") : v.tStat.toFixed(1);
  return (
    <span className={`skill ${v.hasSkill ? "yes" : ""}`}
      title={`t-statistic of ${v.edgeEpochs} epochs' Edge returns. At 2 or more, the Edge is statistically clear of zero; below, a few lucky epochs could explain it.`}>
      t {t} · {v.hasSkill ? "skill" : v.tStat <= -2 ? "losing" : "could be luck"}
    </span>
  );
}

/** Curator vaults ranked live by Edge return, with the selected vault's deposit and redeem panel beside them. */
export function VaultsTab({ live }: { live: Live }) {
  const [sel, setSel] = useState(0);
  const [by, setBy] = useState<"return" | "edge" | "fees">("return");
  // what most dashboards rank by: every fee the sleeve earned, arbitrage fees included
  const feesOf = (v: VaultLive) => v.userFees + v.arbFees;
  const score = (v: VaultLive) => (by === "return" ? v.edgeReturn : by === "edge" ? v.edge : feesOf(v));
  const ranked = [...live.vaults].sort((a, b) => score(b) - score(a));
  const byReturn = [...live.vaults].sort((a, b) => b.edgeReturn - a.edgeReturn);
  const edgeRank = new Map(byReturn.map((v, k) => [v.i, k + 1]));
  const feeTop = [...live.vaults].sort((a, b) => feesOf(b) - feesOf(a))[0];
  const edgeTop = byReturn[0];
  const heading = by === "return" ? "Edge return" : by === "edge" ? "Edge in dollars" : "fee income";
  const fees = live.vaults.reduce((s, v) => s + v.userFees, 0);
  const arbLoss = live.vaults.reduce((s, v) => s + v.arbLoss, 0);
  const arbFees = live.vaults.reduce((s, v) => s + v.arbFees, 0);
  const vault = live.vaults[sel];
  const bonds = live.vaults.reduce((s, v) => s + v.bond, 0);

  return (
    <>
      <div className="kpis">
        <div className="kpi accent">
          <span>Total Edge</span>
          <b className={live.edge >= 0 ? "pos" : "neg"}>{usd(live.edge)}</b>
          <small>user fees + user impact − arbitrage loss</small>
        </div>
        <div className="kpi">
          <span>Total value locked</span>
          <b>{compactUsd(live.tvl)}</b>
          <small>{live.vaults.length} vaults · {compactUsd(bonds)} in curator bonds</small>
        </div>
        <div className="kpi">
          <span>User fees</span>
          <b>{usd(fees)}</b>
          <small>counted toward Edge</small>
        </div>
        <div className="kpi">
          <span>Arbitrage loss</span>
          <b className="neg">{usd(-arbLoss)}</b>
          <small>{usd(arbFees)} arb fees not counted</small>
        </div>
      </div>

      <div className="app-grid">
        <div className="stack">
        <div className="panel">
          <div className="panel-head">
            <h2>Curators, ranked by {heading}</h2>
            <div className="seg" role="group" aria-label="Rank by">
              <button aria-pressed={by === "return"} onClick={() => setBy("return")} title="Edge over the capital that earned it, compounded each epoch">Edge return</button>
              <button aria-pressed={by === "edge"} onClick={() => setBy("edge")}>Edge $</button>
              <button aria-pressed={by === "fees"} onClick={() => setBy("fees")}>Fee income</button>
            </div>
          </div>
          <div className="scroll-x">
            <table className="vt">
              <thead>
                <tr>
                  <th className="l">#</th>
                  <th className="l">Vault</th>
                  {by === "fees" && <th>Fees earned</th>}
                  <th title="Edge over the capital that earned it, compounded each epoch: skill per dollar">Edge return</th>
                  <th>Edge</th>
                  <th>User fees</th>
                  <th>Impact</th>
                  <th>Arb loss</th>
                  <th>TVL</th>
                  <th>Terms</th>
                  <th className="l">Range</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((v, r) => (
                  <tr key={v.address} className={v.i === sel ? "sel" : ""} onClick={() => setSel(v.i)} tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setSel(v.i)}>
                    <td className="l">
                      <span className={`rank ${r === 0 ? "first" : ""}`}>{r + 1}</span>
                      {by !== "return" && edgeRank.get(v.i) !== r + 1 && (
                        <span className="rank-was" title="Rank by Edge return">Edge #{edgeRank.get(v.i)}</span>
                      )}
                    </td>
                    <td className="l">
                      <div className="who">
                        <span className="chip" style={{ background: `var(--s${(v.i % 6) + 1})` }} />
                        <div>
                          <b>
                            {v.name}
                            {v.onProbation && <em className="tag warn" title="Its Edge index fell past the probation drawdown: it cannot rebalance for a few epochs">probation</em>}
                            {v.launched && <em className="tag" title="Launched by its curator through the factory">open launch</em>}
                          </b>
                          <span>{v.style}</span>
                        </div>
                      </div>
                    </td>
                    {by === "fees" && <td className="num strong">{usd(feesOf(v))}</td>}
                    <td className={`num ${by === "return" ? "strong" : ""} ${!v.edgeIndexed ? "" : v.edgeReturn >= 0 ? "pos" : "neg"}`}>
                      {pct(v)}
                      <Skill v={v} />
                    </td>
                    <td className={`num ${by === "edge" ? "strong" : ""} ${v.edge >= 0 ? "pos" : "neg"}`}>{usd(v.edge)}</td>
                    <td className="num">{usd(v.userFees)}</td>
                    <td className="num">{usd(v.userImpact)}</td>
                    <td className="num neg">{usd(-v.arbLoss)}</td>
                    <td className="num">{compactUsd(v.tvl)}</td>
                    <td className="terms">
                      <span title="Performance fee on Edge above the high-water mark">{v.feeBps / 100}% fee</span>
                      <span title="LVR bond and the per-epoch loss budget it covers beyond">
                        {v.bond > 0 ? `${compactUsd(v.bond)} bond` : "no bond"}
                      </span>
                    </td>
                    <td className="l">
                      <RangeBar v={v} price={live.price} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {by === "fees" && feeTop && edgeTop && feeTop.i !== edgeTop.i && (
            <p className="callout">
              Fee income puts <b>{feeTop.name}</b> first. Edge return, which subtracts what arbitrage took and divides by
              the capital at work, puts <b>{edgeTop.name}</b> first.
            </p>
          )}
          {by === "edge" && (
            <p className="callout">
              Dollars of Edge grow with a vault&apos;s size. Edge return divides each epoch&apos;s Edge by the capital that
              earned it, so a small vault and a large one with the same skill score the same.
            </p>
          )}
          <p className="fine">
            Arbitrage fees ({usd(arbFees)} so far) are shown in Analytics but never count: pool-marked LVR already nets
            them out, so counting them would overstate every curator.
          </p>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Liquidity, read from the sleeves</h2>
            <span className="muted sm">each curator&apos;s range, stacked</span>
          </div>
          <LiquidityChart live={live} />
        </div>
        </div>
        {vault && <VaultPanel v={vault} live={live} />}
      </div>
    </>
  );
}
