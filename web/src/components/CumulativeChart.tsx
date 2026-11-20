"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CURATORS, METRICS, type MetricKey, type Tier, WEEKS, cumulative, metric, pct } from "@/lib/data";
import { linePath } from "@/lib/path";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Nice round tick step for a range. */
function step(range: number, target: number) {
  const raw = range / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

/**
 * The year week by week: running total per curator for the chosen metric, with the true hedged P&L dashed underneath
 * when Edge is shown, and the BTC price on its own small chart (never a second axis) sharing the hover.
 */
export function CumulativeChart({ tier }: { tier: Tier }) {
  const [key, setKey] = useState<MetricKey>("edge");
  const [shown, setShown] = useState<boolean[]>(CURATORS.map(() => true));
  const [overlay, setOverlay] = useState(true);
  const [hi, setHi] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();

  const data = useMemo(() => cumulative(tier, key), [tier, key]);
  const truth = useMemo(() => cumulative(tier, "truth"), [tier]);
  const withTruth = key === "edge" && overlay;

  const H = 300;
  const padL = 52;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const n = data.length;
  const vis = CURATORS.map((_, i) => i).filter((i) => shown[i]);
  const all = [0, ...data.flatMap((r) => vis.map((i) => r[i])), ...(withTruth ? truth.flatMap((r) => vis.map((i) => r[i])) : [])];
  let lo = Math.min(...all);
  let hiV = Math.max(...all);
  const st = step(hiV - lo || 100, 5);
  lo = Math.floor(lo / st) * st;
  hiV = Math.ceil(hiV / st) * st;
  const x = (k: number) => padL + (k / (n - 1)) * (width - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hiV - lo)) * (H - padT - padB);
  const ticks: number[] = [];
  for (let v = lo; v <= hiV + 1e-9; v += st) ticks.push(v);

  // BTC strip
  const SH = 84;
  const prices = [WEEKS[0].btcOpen, ...WEEKS.map((w) => w.btcClose)];
  const pLo = Math.min(...prices);
  const pHi = Math.max(...prices);
  const py = (p: number) => 8 + (1 - (p - pLo) / (pHi - pLo)) * (SH - 22);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.round(((e.clientX - r.left - padL) / (width - padL - padR)) * (n - 1));
    setHi(Math.max(0, Math.min(n - 1, k)));
  };

  const label = (k: number) => (k === 0 ? "1 Jan 2024" : `week ${k} · to ${fmtDate(WEEKS[k - 1].start, 7)}`);
  const tipLeft = hi === null ? 0 : x(hi) > width * 0.6 ? x(hi) - 214 : x(hi) + 14;

  return (
    <div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Metric">
          {METRICS.map((m) => (
            <button key={m.key} aria-pressed={key === m.key} onClick={() => setKey(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
        {key === "edge" && (
          <label style={{ fontSize: 14, color: "var(--ink-2)", display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
            Show true P&amp;L (dashed)
          </label>
        )}
      </div>
      <p className="chart-sub">{metric(key).note}. Running total over 2024, % of position value.</p>
      <div className="legend" role="group" aria-label="Curators">
        {CURATORS.map((c, i) => (
          <button key={c.name} aria-pressed={shown[i]}
            onClick={() => setShown((s) => s.map((v, j) => (j === i ? !v : v)))}>
            <span className="chip" style={{ background: `var(--s${i + 1})` }} />
            {c.short}
          </button>
        ))}
      </div>

      <div className="chart" ref={ref}>
        <svg width={width} height={H} onPointerMove={onMove} onPointerLeave={() => setHi(null)}
          role="img" aria-label={`Running ${metric(key).label} per curator over 2024`} style={{ touchAction: "pan-y" }}>
          <g className="axis">
            {ticks.map((v) => (
              <g key={v}>
                <line className={v === 0 ? "zeroline" : "gridline"} x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end">{pct(v, 0)}</text>
              </g>
            ))}
            {MONTHS.map((m, k) => {
              const wk = (k * 52) / 12;
              if (width < 520 && k % 2) return null;
              return <text key={m} x={x(wk)} y={H - 6} textAnchor="start">{m}</text>;
            })}
          </g>
          {withTruth && vis.map((i) => (
            <path key={`t${i}`} d={linePath(truth.map((r, k) => [x(k), y(r[i])]))} fill="none"
              stroke={`var(--s${i + 1})`} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
          ))}
          {vis.map((i) => (
            <path key={i} d={linePath(data.map((r, k) => [x(k), y(r[i])]))} fill="none" stroke={`var(--s${i + 1})`}
              strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hi !== null && (
            <g>
              <line x1={x(hi)} x2={x(hi)} y1={padT} y2={H - padB} stroke="var(--ink-2)" strokeOpacity="0.5" />
              {vis.map((i) => (
                <circle key={i} cx={x(hi)} cy={y(data[hi][i])} r="4.5" fill={`var(--s${i + 1})`}
                  stroke="var(--card)" strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>
        {hi !== null && (
          <div className="tooltip" style={{ left: tipLeft, top: 8 }}>
            <div className="t-head">{label(hi)}</div>
            {vis.slice().sort((a, b) => data[hi][b] - data[hi][a]).map((i) => (
              <div className="t-row" key={i}>
                <span className="chip" style={{ background: `var(--s${i + 1})` }} />
                {CURATORS[i].short}
                <span className="num">{pct(data[hi][i])}</span>
                {withTruth && <span className="num muted" style={{ paddingLeft: 6 }}>({pct(truth[hi][i])})</span>}
              </div>
            ))}
            {withTruth && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>(true hedged P&amp;L)</div>}
          </div>
        )}

        <p className="label-sm" style={{ margin: "14px 0 4px" }}>BTC/USD, the replayed price</p>
        <svg width={width} height={SH} onPointerMove={onMove} onPointerLeave={() => setHi(null)}
          role="img" aria-label="BTC/USD weekly close in 2024" style={{ touchAction: "pan-y" }}>
          <path d={`${linePath(prices.map((p, k) => [x(k), py(p)]))} L${x(n - 1)} ${SH - 14} L${x(0)} ${SH - 14} Z`}
            fill="var(--indigo)" fillOpacity="0.1" />
          <path d={linePath(prices.map((p, k) => [x(k), py(p)]))} fill="none" stroke="var(--indigo)" strokeWidth="2" />
          <g className="axis">
            <text x={padL - 8} y={py(pHi) + 4} textAnchor="end">{`$${Math.round(pHi / 1000)}k`}</text>
            <text x={padL - 8} y={py(pLo) + 4} textAnchor="end">{`$${Math.round(pLo / 1000)}k`}</text>
          </g>
          {hi !== null && (
            <g>
              <line x1={x(hi)} x2={x(hi)} y1={4} y2={SH - 14} stroke="var(--ink-2)" strokeOpacity="0.5" />
              <circle cx={x(hi)} cy={py(prices[hi])} r="4.5" fill="var(--indigo)" stroke="var(--card)" strokeWidth="2" />
              <text x={x(hi) + (x(hi) > width * 0.8 ? -8 : 8)} y={SH - 2} fontSize="11" fontFamily="var(--mono)"
                fill="var(--ink-2)" textAnchor={x(hi) > width * 0.8 ? "end" : "start"}>
                ${Math.round(prices[hi]).toLocaleString("en-US")}
              </text>
            </g>
          )}
        </svg>
      </div>

      <details className="table-view">
        <summary>Show as a table</summary>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Week from</th>
                {CURATORS.map((c) => <th key={c.name}>{c.short}</th>)}
              </tr>
            </thead>
            <tbody>
              {WEEKS.map((w, k) => (
                <tr key={w.start}>
                  <td>{w.start}</td>
                  {CURATORS.map((c, i) => <td key={c.name}>{pct(data[k + 1][i])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function fmtDate(iso: string, plusDays: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
