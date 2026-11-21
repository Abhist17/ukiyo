"use client";

import { useEffect, useState } from "react";
import { CURATORS, pairAgreement, pct, ranks, total, type MetricKey } from "@/lib/data";

const VIEWS: { key: MetricKey; label: string; note: string }[] = [
  { key: "fees", label: "Fee APR", note: "crowns the curator trading most against arbitrageurs" },
  { key: "hodl", label: "Beat HODL", note: "crowns whoever the price happened to favour" },
  { key: "edge", label: "Ukiyo Edge", note: "matches each curator's true hedged P&L" },
];

const ROW = 52;

/**
 * The hero's one idea, interactive: the same six curators re-sort as the yardstick changes, and each row says
 * whether that rank is the true one. Cycles on its own until someone picks a yardstick.
 */
export function HeroRank() {
  const [v, setV] = useState(0);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setV((x) => (x + 1) % VIEWS.length), 2600);
    return () => clearInterval(id);
  }, [auto]);

  const truth = total("5bps", "truth");
  const trueRank = ranks(truth);
  const view = VIEWS[v];
  const vals = total("5bps", view.key);
  const r = ranks(vals);
  const agree = pairAgreement(vals, truth);
  const isEdge = view.key === "edge";

  return (
    <div className="hr-card">
      <div className="hr-top">
        <div>
          <b>Six curators · BTC/USD 2024</b>
          <span>Rank them by</span>
        </div>
        <div className="hr-seg" role="tablist" aria-label="Yardstick">
          {VIEWS.map((x, i) => (
            <button key={x.key} role="tab" aria-selected={i === v} className={x.key === "edge" ? "edge" : ""}
              onClick={() => { setAuto(false); setV(i); }}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <ol className="hr-list" style={{ height: ROW * CURATORS.length }}>
        {CURATORS.map((c, i) => {
          const right = r[i] === trueRank[i];
          return (
            <li key={c.name} style={{ transform: `translateY(${(r[i] - 1) * ROW}px)` }} className={r[i] === 1 ? "top" : ""}>
              <span className="hr-rank">{r[i]}</span>
              <span className="hr-name">
                <b>{c.short}</b>
                <small>{c.style}</small>
              </span>
              <span className="hr-val">{pct(vals[i], view.key === "fees" ? 0 : 1)}</span>
              <span className={`hr-check ${right ? "ok" : "no"}`}>{right ? "✓ true rank" : `✗ really #${trueRank[i]}`}</span>
            </li>
          );
        })}
      </ol>
      <div className="hr-foot">
        <div className="hr-agree">
          <span>Orders curator pairs like the truth</span>
          <div className="hr-bar">
            <div style={{ width: `${agree * 100}%` }} className={isEdge ? "edge" : ""} />
          </div>
          <b className={isEdge ? "edge" : ""}>{Math.round(agree * 100)}%</b>
        </div>
        <p>
          <b>{view.label}</b> {view.note}.
        </p>
      </div>
    </div>
  );
}
