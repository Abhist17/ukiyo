"use client";

import { useEffect, useRef, useState } from "react";
import type { Live } from "@/lib/useUkiyo";
import { tickToPrice, usd } from "@/lib/chain";

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

const BUCKETS = 72;

/**
 * Liquidity by price, read from the sleeves: each curator's position is liquidity spread evenly over its range, so
 * stacking the sleeves gives the pool's depth. Swaps trade against whatever sits at the current price.
 */
export function LiquidityChart({ live }: { live: Live }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 190;
  const pad = { l: 8, r: 8, t: 14, b: 24 };
  const lo = live.price * 0.82;
  const hi = live.price * 1.18;
  const step = (hi - lo) / BUCKETS;
  const ranges = live.vaults.map((v) => {
    const a = tickToPrice(v.tickLower);
    const b = tickToPrice(v.tickUpper);
    return { a: Math.min(a, b), b: Math.max(a, b), l: Number(v.liquidity) };
  });
  // stacked liquidity per bucket, sleeve by sleeve
  const stacks = Array.from({ length: BUCKETS }, (_, k) => {
    const mid = lo + (k + 0.5) * step;
    return ranges.map((r) => (mid >= r.a && mid < r.b ? r.l : 0));
  });
  const max = Math.max(1, ...stacks.map((s) => s.reduce((a, b) => a + b, 0)));
  const bw = (W - pad.l - pad.r) / BUCKETS;
  const y = (v: number) => (v / max) * (H - pad.t - pad.b);
  const xPrice = (p: number) => pad.l + ((p - lo) / (hi - lo)) * (W - pad.l - pad.r);
  const activeNow = ranges.filter((r) => live.price >= r.a && live.price < r.b).length;

  return (
    <div ref={ref} className="chart">
      <svg width={W} height={H} role="img" aria-label="Liquidity by price, stacked by curator"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(BUCKETS - 1, Math.floor((e.clientX - r.left - pad.l) / bw))));
        }}
        onPointerLeave={() => setHover(null)}>
        {stacks.map((s, k) => {
          let base = H - pad.b;
          return (
            <g key={k} opacity={hover === null || hover === k ? 1 : 0.55}>
              {s.map((l, i) => {
                if (!l) return null;
                const h = y(l);
                base -= h;
                return (
                  <rect key={i} x={pad.l + k * bw + 1} y={base} width={Math.max(1, bw - 2)} height={Math.max(0, h - 1)}
                    rx="1.5" fill={`var(--s${i + 1})`} />
                );
              })}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--line)" />
        <line x1={xPrice(live.price)} x2={xPrice(live.price)} y1={4} y2={H - pad.b} stroke="var(--ink)" strokeDasharray="3 3" />
        <g className="axis">
          <text x={xPrice(live.price)} y={11} textAnchor="middle" fontWeight={600}>{usd(live.price)}</text>
          <text x={pad.l} y={H - 6}>{usd(lo)}</text>
          <text x={W - pad.r} y={H - 6} textAnchor="end">{usd(hi)}</text>
        </g>
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(W - 210, Math.max(0, pad.l + hover * bw - 100)), top: 20 }}>
          <div className="t-head">{usd(lo + hover * step)} – {usd(lo + (hover + 1) * step)}</div>
          {stacks[hover].every((l) => l === 0) && <div className="muted">No liquidity here</div>}
          {stacks[hover].map((l, i) =>
            l ? (
              <div className="t-row" key={i}>
                <span className="chip" style={{ background: `var(--s${i + 1})` }} />
                {live.vaults[i].name}
                <span className="num">{((l / max) * 100).toFixed(0)}%</span>
              </div>
            ) : null,
          )}
        </div>
      )}
      <p className="fine">
        {activeNow} of {live.vaults.length} sleeves are active at the current price. Bars show each sleeve&apos;s
        liquidity spread over its range, as a share of the deepest price level.
      </p>
    </div>
  );
}
