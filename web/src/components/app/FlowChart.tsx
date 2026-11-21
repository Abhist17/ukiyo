"use client";

import { useEffect, useRef, useState } from "react";
import type { Live, TapeRow } from "@/lib/useUkiyo";
import { compactUsd, usd, gwei } from "@/lib/chain";

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}


/** Every recent swap as a bar (size, coloured by how the hook classified it), with the pool price beneath. */
export function FlowChart({ rows }: { rows: TapeRow[] }) {
  const [ref, W] = useWidth();
  const [hi, setHi] = useState<number | null>(null);
  const list = [...rows].reverse(); // oldest first
  const H = 170;
  const PH = 70;
  const pad = { l: 56, r: 10, t: 8, b: 6 };
  if (list.length === 0) return <p className="fine">Waiting for swaps…</p>;
  const n = list.length;
  const bw = (W - pad.l - pad.r) / n;
  const maxUsd = Math.max(...list.map((r) => r.usd));
  const y = (v: number) => Math.sqrt(v / maxUsd) * (H - pad.t - pad.b); // area-true-ish: big arbs don't flatten users
  const prices = list.map((r) => r.price);
  const pLo = Math.min(...prices);
  const pHi = Math.max(...prices);
  const py = (p: number) => 8 + (1 - (p - pLo) / (pHi - pLo || 1)) * (PH - 20);
  const x = (k: number) => pad.l + k * bw + bw / 2;
  const sel = hi !== null ? list[hi] : undefined;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHi(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left - pad.l) / bw))));
  };

  return (
    <div ref={ref} className="chart">
      <svg width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHi(null)} role="img"
        aria-label="Recent swaps by size, coloured arbitrage or user">
        <g className="axis">
          <text x={pad.l - 8} y={pad.t + 10} textAnchor="end">{compactUsd(maxUsd)}</text>
          <text x={pad.l - 8} y={H - pad.b} textAnchor="end">$0</text>
        </g>
        {list.map((r, k) => (
          <rect key={r.tx + k} x={pad.l + k * bw + Math.min(1, bw * 0.15)} width={Math.max(1, bw - Math.min(2, bw * 0.3))}
            y={H - pad.b - y(r.usd)} height={Math.max(1, y(r.usd))} rx={Math.min(2, bw / 3)}
            fill={r.arb ? "var(--bad)" : "var(--good)"} opacity={hi === null || hi === k ? 0.9 : 0.35} />
        ))}
      </svg>
      <svg width={W} height={PH} onPointerMove={onMove} onPointerLeave={() => setHi(null)} role="img" aria-label="Pool price">
        <path d={list.map((r, k) => `${k ? "L" : "M"}${x(k).toFixed(1)} ${py(r.price).toFixed(1)}`).join(" ")}
          fill="none" stroke="var(--indigo)" strokeWidth="2" />
        <g className="axis">
          <text x={pad.l - 8} y={py(pHi) + 4} textAnchor="end">{compactUsd(pHi)}</text>
          <text x={pad.l - 8} y={py(pLo) + 4} textAnchor="end">{compactUsd(pLo)}</text>
        </g>
        {hi !== null && <line x1={x(hi)} x2={x(hi)} y1={0} y2={PH} stroke="var(--ink-2)" strokeOpacity="0.4" />}
      </svg>
      {sel && (
        <div className="tooltip" style={{ left: x(hi!) > W * 0.6 ? x(hi!) - 220 : x(hi!) + 12, top: 8 }}>
          <div className="t-head">
            Block #{sel.block.toString()} <span className={`badge ${sel.arb ? "arb" : "user"}`}>{sel.arb ? "ARB" : "USER"}</span>
          </div>
          <div className="t-row">{sel.buyBtc ? "Buy" : "Sell"} tBTC<span className="num">{usd(sel.usd)}</span></div>
          <div className="t-row">Priority fee<span className="num">{gwei(sel.tip)}</span></div>
          <div className="t-row">Price after<span className="num">{usd(sel.price)}</span></div>
        </div>
      )}
    </div>
  );
}

/** The classifier, as it stands: the threshold, what arbitrage and users bid recently, and the latest block's order. */
export function ClassifierNow({ live, rows }: { live: Live; rows: TapeRow[] }) {
  const arb = rows.filter((r) => r.arb);
  const user = rows.filter((r) => !r.arb);
  const maxTip = (rs: TapeRow[]) => rs.reduce((m, r) => (r.tip > m ? r.tip : m), 0n);
  const minTip = (rs: TapeRow[]) => (rs.length ? rs.reduce((m, r) => (r.tip < m ? r.tip : m), rs[0].tip) : 0n);
  const vol = (rs: TapeRow[]) => rs.reduce((a, r) => a + r.usd, 0);
  const lastBlock = rows[0]?.block;
  const inBlock = rows.filter((r) => r.block === lastBlock).reverse();
  const share = vol(arb) / (vol(arb) + vol(user) || 1);

  return (
    <div className="classifier">
      <div className="cls-gauge">
        <div className="cls-bar">
          <div className="cls-fill" style={{ width: `${share * 100}%` }} />
        </div>
        <div className="cls-legend">
          <span>{(share * 100).toFixed(0)}% of recent volume is arbitrage</span>
          <span className="muted">{rows.length} swaps</span>
        </div>
      </div>
      <dl className="cls-stats">
        <div><dt>Threshold</dt><dd>{gwei(live.threshold)}</dd></div>
        <div><dt>Lowest arbitrage tip</dt><dd className="neg">{arb.length ? gwei(minTip(arb)) : "—"}</dd></div>
        <div><dt>Highest user tip</dt><dd className="pos">{user.length ? gwei(maxTip(user)) : "—"}</dd></div>
      </dl>
      {lastBlock !== undefined && (
        <div className="cls-block">
          <span className="label-sm">Latest block #{lastBlock.toString()}, in order</span>
          <div className="cls-seq">
            {inBlock.map((r, k) => (
              <span key={r.tx + k} className={`badge ${r.arb ? "arb" : "user"}`} title={`${usd(r.usd)} · tip ${gwei(r.tip)}`}>
                {r.arb ? "ARB" : "USER"} {compactUsd(r.usd)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
