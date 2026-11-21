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
      <div className="range-band" style={{ left: `${x(a)}%`, width: `${Math.max(1.5, x(b) - x(a))}%`, background: `var(--s${v.i + 1})` }} />
      <div className="range-now" />
      <span className={`range-tag ${inRange ? "in" : "out"}`}>{inRange ? "In range" : "Out of range"}</span>
    </div>
  );
}

/** Curator vaults ranked live by Edge, with the selected vault's deposit and redeem panel beside them. */
export function VaultsTab({ live }: { live: Live }) {
  const [sel, setSel] = useState(0);
  const [by, setBy] = useState<"edge" | "fees">("edge");
  // what most dashboards rank by: every fee the sleeve earned, arbitrage fees included
  const feesOf = (v: VaultLive) => v.userFees + v.arbFees;
  const score = (v: VaultLive) => (by === "edge" ? v.edge : feesOf(v));
  const ranked = [...live.vaults].sort((a, b) => score(b) - score(a));
  const edgeRank = new Map([...live.vaults].sort((a, b) => b.edge - a.edge).map((v, k) => [v.i, k + 1]));
  const feeTop = [...live.vaults].sort((a, b) => feesOf(b) - feesOf(a))[0];
  const edgeTop = [...live.vaults].sort((a, b) => b.edge - a.edge)[0];
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
            <h2>Curators, ranked by {by === "edge" ? "Edge" : "fee income"}</h2>
            <div className="seg" role="group" aria-label="Rank by">
              <button aria-pressed={by === "edge"} onClick={() => setBy("edge")}>Ukiyo Edge</button>
              <button aria-pressed={by === "fees"} onClick={() => setBy("fees")}>Fee income</button>
            </div>
          </div>
          <div className="scroll-x">
            <table className="vt">
              <thead>
                <tr>
                  <th className="l">#</th>
                  <th className="l">Vault</th>
                  <th>{by === "fees" ? "Fees earned" : "Edge"}</th>
                  {by === "fees" && <th>Edge</th>}
                  <th>Edge / TVL</th>
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
                      {by === "fees" && edgeRank.get(v.i) !== r + 1 && (
                        <span className="rank-was" title="Rank by Edge">Edge #{edgeRank.get(v.i)}</span>
                      )}
                    </td>
                    <td className="l">
                      <div className="who">
                        <span className="chip" style={{ background: `var(--s${v.i + 1})` }} />
                        <div>
                          <b>{v.name}</b>
                          <span>{v.style}</span>
                        </div>
                      </div>
                    </td>
                    {by === "fees" && <td className="num strong">{usd(feesOf(v))}</td>}
                    <td className={`num ${by === "edge" ? "strong" : ""} ${v.edge >= 0 ? "pos" : "neg"}`}>{usd(v.edge)}</td>
                    <td className="num">{v.tvl ? `${((v.edge / v.tvl) * 1e4).toFixed(1)} bps` : "—"}</td>
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
              Fee income puts <b>{feeTop.name}</b> first. Edge, which subtracts what arbitrage took, puts{" "}
              <b>{edgeTop.name}</b> first.
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
