"use client";

import { useState } from "react";
import { CURATORS, METRICS, type Tier, pairAgreement, ranks, total } from "@/lib/data";

/**
 * Bump chart, kept quiet on purpose: every curator is a thin grey curve through its rank under five yardsticks, and
 * only two carry colour — the curator the truth ranks first (Ukiyo's vermilion) and the one fee income wrongly
 * crowns. Between Ukiyo Edge and true hedged P&L every curve runs flat.
 */
export function RankShift({ tier }: { tier: Tier }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = METRICS.map((m) => total(tier, m.key));
  const rk = totals.map(ranks);
  const truth = totals[totals.length - 1];
  const agree = totals.map((t) => pairAgreement(t, truth));
  const n = METRICS.length;
  const edgeCol = METRICS.findIndex((m) => m.key === "edge");

  const best = rk[n - 1].indexOf(1); // the truth's #1
  const feeKing = rk[0].indexOf(1); // fee income's #1
  const story = new Map<number, string>([[best, "var(--seal)"]]);
  if (feeKing !== best) story.set(feeKing, "var(--story-2)");

  const W = 880;
  const H = 400;
  const padL = 150;
  const padR = 150;
  const top = 96;
  const bottom = 28;
  const rowH = (H - top - bottom) / (CURATORS.length - 1);
  const x = (j: number) => padL + (j * (W - padL - padR)) / (n - 1);
  const y = (rank: number) => top + (rank - 1) * rowH;
  const curve = (pts: [number, number][]) =>
    pts
      .map(([px, py], k) => {
        if (k === 0) return `M${px} ${py}`;
        const [qx, qy] = pts[k - 1];
        const dx = (px - qx) / 2;
        return `C${qx + dx} ${qy} ${px - dx} ${py} ${px} ${py}`;
      })
      .join(" ");

  const colourOf = (i: number) => (hover === i ? story.get(i) ?? "var(--ink)" : hover === null ? story.get(i) : undefined);
  const order = CURATORS.map((_, i) => i).sort((a, b) => (colourOf(a) ? 1 : 0) - (colourOf(b) ? 1 : 0)); // colour on top

  return (
    <div className="rankshift">
      <div className="scroll-x">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 660, width: "100%" }} role="img"
          aria-label="Each curator's rank under five yardsticks; only Ukiyo Edge matches true hedged P&L">
          {/* Edge and the truth share a soft band: the part of the chart where nothing crosses */}
          <rect x={x(edgeCol) - 28} y={top - 84} width={x(n - 1) - x(edgeCol) + 56} height={H - top + 84 - 6} rx="16"
            fill="var(--seal)" fillOpacity="0.06" />

          {METRICS.map((m, j) => {
            const isEdge = m.key === "edge";
            const isTruth = j === n - 1;
            return (
              <g key={m.key}>
                <text x={x(j)} y={top - 62} textAnchor="middle" fontSize="13" fontWeight={600}
                  fill={isEdge ? "var(--seal)" : "var(--ink)"}>{m.label}</text>
                {isTruth ? (
                  <text x={x(j)} y={top - 40} textAnchor="middle" fontSize="11" fill="var(--muted)">the answer key</text>
                ) : (
                  <g>
                    <text x={x(j)} y={top - 40} textAnchor="middle" fontSize="12" fontWeight={600}
                      fill={isEdge ? "var(--seal)" : "var(--ink-2)"} fontFamily="var(--mono)">
                      {Math.round(agree[j] * 100)}%
                    </text>
                    <rect x={x(j) - 22} y={top - 32} width="44" height="3" rx="1.5" fill="var(--grid)" />
                    <rect x={x(j) - 22} y={top - 32} width={44 * agree[j]} height="3" rx="1.5"
                      fill={isEdge ? "var(--seal)" : "var(--muted)"} />
                  </g>
                )}
                <line x1={x(j)} x2={x(j)} y1={top - 14} y2={H - bottom + 10} stroke="var(--grid)" />
              </g>
            );
          })}

          {order.map((i) => {
            const pts = rk.map((r, j) => [x(j), y(r[i])] as [number, number]);
            const c = colourOf(i);
            const dim = hover !== null && hover !== i;
            return (
              <g key={CURATORS[i].name} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                style={{ cursor: "default", transition: "opacity 150ms" }} opacity={dim ? 0.25 : 1}>
                <path d={curve(pts)} fill="none" stroke="transparent" strokeWidth="18" />
                <path className="rs-line" pathLength={1} d={curve(pts)} fill="none" stroke={c ?? "var(--rank-grey)"}
                  strokeWidth={c ? 3 : 1.5} strokeLinecap="round" />
                {pts.map(([px, py], k) => (
                  <circle key={k} cx={px} cy={py} r={c ? 5 : 3.5} fill={c ?? "var(--rank-grey)"}
                    stroke="var(--rank-bg)" strokeWidth="2" />
                ))}
                <text x={pts[0][0] - 16} y={pts[0][1] + 4} textAnchor="end" fontSize="12.5"
                  fill={c ? "var(--ink)" : "var(--muted)"} fontWeight={c ? 600 : 400}>
                  {CURATORS[i].short}
                  <tspan fill="var(--muted)" fontFamily="var(--mono)" fontWeight={400}>{`  #${rk[0][i]}`}</tspan>
                </text>
                <text x={pts[n - 1][0] + 16} y={pts[n - 1][1] + 4} fontSize="12.5"
                  fill={c ? "var(--ink)" : "var(--muted)"} fontWeight={c ? 600 : 400}>
                  <tspan fill="var(--muted)" fontFamily="var(--mono)" fontWeight={400}>{`#${rk[n - 1][i]}  `}</tspan>
                  {CURATORS[i].short}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="rankshift-key">
        <span><i style={{ background: "var(--seal)" }} />{CURATORS[best].short}: the true #1, and Edge&apos;s #1</span>
        {feeKing !== best && (
          <span>
            <i style={{ background: "var(--story-2)" }} />
            {CURATORS[feeKing].short}: #1 by fee income, really #{rk[n - 1][feeKing]}
          </span>
        )}
        <span className="muted">Percentages: share of curator pairs each yardstick orders like the truth. Hover any line.</span>
      </div>
    </div>
  );
}
