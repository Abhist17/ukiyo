"use client";

import { useEffect, useRef, useState } from "react";
import type { Live } from "@/lib/useUkiyo";
import { useAccountability, useEdgeHistory, useTape } from "@/lib/useUkiyo";
import { DEP, EXPLORER, compactUsd, short, usd, gwei } from "@/lib/chain";
import { ClassifierNow, FlowChart } from "./FlowChart";

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Cumulative Edge per vault at each settled epoch, ending at the live value. */
function EdgeChart({ live }: { live: Live }) {
  const { data } = useEdgeHistory();
  const [ref, W] = useWidth();
  const [hi, setHi] = useState<number | null>(null);
  const H = 260;
  const pad = { l: 64, r: 12, t: 12, b: 24 };
  const series = (data ?? live.vaults.map(() => [])).map((pts, i) => [...pts, { block: live.block, edge: live.vaults[i]?.edge ?? 0 }]);
  const b0 = Number(DEP!.deployBlock);
  const b1 = Math.max(b0 + 1, Number(live.block));
  const all = series.flat().map((p) => p.edge).concat(0);
  const lo = Math.min(...all);
  const hiV = Math.max(...all);
  const span = hiV - lo || 1;
  const x = (block: number) => pad.l + ((block - b0) / (b1 - b0)) * (W - pad.l - pad.r);
  // value of a step series at a block: the last point at or before it
  const at = (s: { block: bigint; edge: number }[], block: number) => {
    let v = 0;
    for (const p of s) if (Number(p.block) <= block) v = p.edge;
    return v;
  };
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
  const ticks = [lo, lo + span / 2, hiV];

  return (
    <div ref={ref} className="chart">
      <svg width={W} height={H} role="img" aria-label="Cumulative Edge per vault by epoch"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = (e.clientX - r.left - pad.l) / (W - pad.l - pad.r);
          setHi(Math.round(b0 + Math.max(0, Math.min(1, f)) * (b1 - b0)));
        }}
        onPointerLeave={() => setHi(null)}>
        <g className="axis">
          {ticks.map((v) => (
            <g key={v}>
              <line className="gridline" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end">{compactUsd(v)}</text>
            </g>
          ))}
          <line className="zeroline" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
          <text x={pad.l} y={H - 6}>block {b0}</text>
          <text x={W - pad.r} y={H - 6} textAnchor="end">now · {b1}</text>
        </g>
        {series.map((s, i) => (
          <path key={i} fill="none" stroke={`var(--s${i + 1})`} strokeWidth="2" strokeLinejoin="round"
            d={s.map((p, k) => `${k ? "L" : "M"}${x(Number(p.block)).toFixed(1)} ${y(p.edge).toFixed(1)}`).join(" ")} />
        ))}
        {hi !== null && <line x1={x(hi)} x2={x(hi)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-2)" strokeOpacity="0.4" />}
      </svg>
      {hi !== null && (
        <div className="tooltip" style={{ left: x(hi) > W * 0.6 ? x(hi) - 210 : x(hi) + 12, top: 8 }}>
          <div className="t-head">Block #{hi}</div>
          {live.vaults.map((v, i) => (
            <div className="t-row" key={v.address}>
              <span className="chip" style={{ background: `var(--s${i + 1})` }} />
              {v.name}
              <span className="num">{usd(at(series[i], hi))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pool-level analytics: Edge over time, how each Edge is built, and how flow splits between arbitrage and users. */
export function AnalyticsTab({ live }: { live: Live }) {
  const tape = useTape();
  const acct = useAccountability();
  const rows = tape.data ?? [];
  const maxAbs = Math.max(1, ...live.vaults.map((v) => Math.max(v.userFees + v.userImpact, v.arbLoss, v.arbFees)));

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h2>Edge over time</h2>
          <div className="legend-inline">
            {live.vaults.map((v, i) => (
              <span key={v.address}><span className="chip" style={{ background: `var(--s${i + 1})` }} />{v.name}</span>
            ))}
          </div>
        </div>
        <EdgeChart live={live} />
        <p className="fine">Settled epochs (each vault&apos;s EpochSettled events) joined to the live value from the hook.</p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Every swap, as the hook saw it</h2>
          <div className="legend-inline">
            <span><span className="badge arb">ARB</span> pays a priority fee, fee not counted</span>
            <span><span className="badge user">USER</span> no tip, fee counts toward Edge</span>
          </div>
        </div>
        <FlowChart rows={rows} />
        <p className="fine">Last {rows.length} swaps, oldest on the left; bar height grows with the square root of size so small user trades stay visible.</p>
      </div>

      <div className="app-grid even">
        <div className="panel">
          <div className="panel-head">
            <h2>What each Edge is made of</h2>
          </div>
          {live.vaults.map((v, i) => (
            <div className="decomp" key={v.address}>
              <div className="decomp-name">
                <span className="chip" style={{ background: `var(--s${i + 1})` }} />
                <b>{v.name}</b>
                <span className={`num ${v.edge >= 0 ? "pos" : "neg"}`}>{usd(v.edge)}</span>
              </div>
              <div className="bars">
                <div className="bar-row"><span>User fees + impact</span>
                  <div className="track"><div className="fill pos" style={{ width: `${((v.userFees + v.userImpact) / maxAbs) * 100}%` }} /></div>
                  <span className="num">{usd(v.userFees + v.userImpact)}</span></div>
                <div className="bar-row"><span>Arbitrage loss</span>
                  <div className="track"><div className="fill neg" style={{ width: `${(v.arbLoss / maxAbs) * 100}%` }} /></div>
                  <span className="num">{usd(-v.arbLoss)}</span></div>
                <div className="bar-row dim"><span>Arb fees (not counted)</span>
                  <div className="track"><div className="fill hatch" style={{ width: `${(v.arbFees / maxAbs) * 100}%` }} /></div>
                  <span className="num">{usd(v.arbFees)}</span></div>
              </div>
            </div>
          ))}
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h2>Classifier right now</h2>
              <span className="muted sm">priority fee decides</span>
            </div>
            <ClassifierNow live={live} rows={rows} />
            <p className="fine">
              A swap is arbitrage when its priority fee is at least {gwei(live.threshold)}. Under
              priority ordering arbitrageurs bid for the top of the block; when in doubt the hook calls a swap arbitrage,
              so Edge is never overstated.
            </p>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>Curator accountability</h2>
              <span className="muted sm">paid in Edge, held to it</span>
            </div>
            <table className="acct">
              <thead>
                <tr><th className="l">Vault</th><th>Fees earned</th><th>Bond paid out</th><th>Bond left</th></tr>
              </thead>
              <tbody>
                {live.vaults.map((v, i) => (
                  <tr key={v.address}>
                    <td className="l"><span className="chip" style={{ background: `var(--s${i + 1})` }} /> {v.name}</td>
                    <td className="num">{usd(acct.data?.[i].feesPaid ?? 0)}</td>
                    <td className="num neg">{usd(acct.data?.[i].penalties ?? 0)}</td>
                    <td className="num">{usd(v.bond)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine">
              Curators earn {live.vaults[0]?.feeBps / 100}% of Edge above each vault&apos;s high-water mark, paid in
              shares. A curator whose epoch loses more than its LVR budget pays the difference to depositors from its
              bond.
            </p>
          </div>
          <div className="panel">
            <div className="panel-head"><h2>Contracts</h2></div>
            <dl className="contracts">
              {[
                ["Hook", DEP!.hook],
                ["PoolManager", DEP!.poolManager],
                ["Swap router", DEP!.router],
                ...live.vaults.map((v) => [`${v.name} vault`, v.address] as [string, string]),
              ].map(([k, a]) => (
                <div key={a}>
                  <dt>{k}</dt>
                  <dd>{EXPLORER ? <a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noreferrer">{short(a)}</a> : <span className="mono">{short(a)}</span>}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
