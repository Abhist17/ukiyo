"use client";

import { useState } from "react";
import { CURATORS, METRICS, type Tier, pairAgreement, ranks, total } from "@/lib/data";

/**
 * Bump chart: the same six curators ranked by five yardsticks. Lines cross wherever a yardstick disagrees with the
 * one to its right; between Ukiyo Edge and true hedged P&L they should run flat.
 */
export function RankShift({ tier }: { tier: Tier }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = METRICS.map((m) => total(tier, m.key));
  const rk = totals.map(ranks);
  const truth = totals[totals.length - 1];
  const agree = totals.map((t) => pairAgreement(t, truth));

  const W = 860;
  const H = 360;
  const padL = 128;
  const padR = 128;
  const top = 64;
  const rowH = (H - top - 24) / (CURATORS.length - 1);
  const x = (j: number) => padL + (j * (W - padL - padR)) / (METRICS.length - 1);
  const y = (rank: number) => top + (rank - 1) * rowH;
  const n = METRICS.length;

  return (
    <div className="scroll-x">
      <svg viewBox={`0 0 ${W} ${H + 8}`} style={{ minWidth: 640, width: "100%" }} role="img"
        aria-label="Rank of each curator under five metrics">
        {/* the Edge → truth segment is the one that should be flat */}
        <rect x={x(n - 2) - 18} y={top - 52} width={x(n - 1) - x(n - 2) + 36} height={H - top + 64} rx="12"
          fill="var(--seal)" fillOpacity="0.06" stroke="var(--seal)" strokeOpacity="0.25" strokeDasharray="3 4" />
        {METRICS.map((m, j) => (
          <g key={m.key}>
            <text x={x(j)} y={top - 34} textAnchor="middle" fontSize="13" fontWeight={600}
              fill={m.key === "edge" ? "var(--seal)" : "var(--ink)"}>
              {m.label}
            </text>
            <text x={x(j)} y={top - 17} textAnchor="middle" fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">
              {j === n - 1 ? "the truth" : `${Math.round(agree[j] * 100)}% pairs right`}
            </text>
            <line x1={x(j)} x2={x(j)} y1={top - 6} y2={H - 18} stroke="var(--grid)" />
          </g>
        ))}
        {CURATORS.map((c, i) => {
          const pts = rk.map((r, j) => [x(j), y(r[i])]);
          const dim = hover !== null && hover !== i;
          return (
            <g key={c.name} opacity={dim ? 0.15 : 1} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ cursor: "default", transition: "opacity 120ms" }}>
              <path d={pts.map((p, k) => `${k ? "L" : "M"}${p[0]} ${p[1]}`).join(" ")} fill="none"
                stroke="transparent" strokeWidth="16" />
              <path d={pts.map((p, k) => `${k ? "L" : "M"}${p[0]} ${p[1]}`).join(" ")} fill="none"
                stroke={`var(--s${i + 1})`} strokeWidth={hover === i ? 3.5 : 2.5} strokeLinejoin="round" />
              {pts.map((p, k) => (
                <g key={k}>
                  <circle cx={p[0]} cy={p[1]} r="11" fill={`var(--s${i + 1})`} stroke="var(--card)" strokeWidth="2" />
                  <text x={p[0]} y={p[1] + 4} textAnchor="middle" fontSize="11" fontWeight={700} fill="#fff"
                    fontFamily="var(--mono)">
                    {rk[k][i]}
                  </text>
                </g>
              ))}
              <text x={pts[0][0] - 20} y={pts[0][1] + 4} textAnchor="end" fontSize="13" fill="var(--ink-2)">
                {c.short}
              </text>
              <text x={pts[n - 1][0] + 20} y={pts[n - 1][1] + 4} fontSize="13" fill="var(--ink-2)">
                {c.short}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
