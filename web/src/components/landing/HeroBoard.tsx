"use client";

import { useEffect, useState } from "react";
import { Providers } from "@/components/app/Providers";
import { useLive, useTape } from "@/lib/useUkiyo";
import { CURATORS, pct, total } from "@/lib/data";
import { CHAIN_LABEL, DEP, compactUsd, short, usd } from "@/lib/chain";

interface Row {
  name: string;
  sub: string;
  edge: string;
  value: number;
  color: number;
}

/** Product card for the hero: the live vault ranking if a deployment answers, else the backtest's full-year ranking. */
function Board() {
  const { data: live, isError } = useLive();
  const { data: tape } = useTape();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 4000);
    return () => clearTimeout(t);
  }, []);

  const useLiveData = !!live && live.vaults.some((v) => v.liquidity > 0n);
  let rows: Row[];
  if (useLiveData) {
    rows = [...live!.vaults]
      .sort((a, b) => b.edge - a.edge)
      .map((v) => ({ name: v.name, sub: v.style, edge: usd(v.edge), value: v.edge, color: v.i + 1 }));
  } else {
    const e = total("5bps", "edge");
    rows = CURATORS.map((c, i) => ({ name: c.short, sub: c.style, edge: pct(e[i]), value: e[i], color: i + 1 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const last = tape?.[0];
  const loading = !useLiveData && !isError && !timedOut && !!DEP;

  return (
    <div className="board-card">
      <div className="board-top">
        <div className="pair">
          <span className="coin btc">₿</span>
          <span className="coin usd">$</span>
          <b>tBTC / tUSD</b>
          <span className="muted">5 bps</span>
        </div>
        <span className="status">
          <span className={`dot ${useLiveData ? "live" : ""}`} />
          {useLiveData ? `Live · ${CHAIN_LABEL} · block #${live!.block}` : loading ? "Connecting…" : "BTC/USD 2024 replay"}
        </span>
      </div>
      <div className="board-sub">
        <span>Curators ranked by Edge</span>
        <span className="muted">{useLiveData ? `hook ${short(DEP!.hook)}` : "full year, backtest"}</span>
      </div>
      <ol className="board-rows">
        {rows.map((r, k) => (
          <li key={r.name}>
            <span className={`rank ${k === 0 ? "first" : ""}`}>{k + 1}</span>
            <div className="nm">
              <b>{r.name}</b>
              <span>{r.sub}</span>
            </div>
            <div className="bar">
              <div
                style={{
                  width: `${(Math.abs(r.value) / max) * 100}%`,
                  background: r.value >= 0 ? `var(--s${r.color})` : "var(--bad)",
                }}
              />
            </div>
            <b className={`num ${r.value >= 0 ? "pos" : "neg"}`}>{r.edge}</b>
          </li>
        ))}
      </ol>
      <div className="board-foot">
        {useLiveData ? (
          <>
            <div><span>TVL</span><b>{compactUsd(live!.tvl)}</b></div>
            <div><span>tBTC</span><b>{usd(live!.price)}</b></div>
            <div><span>Last swap</span><b>{last ? <span className={`badge ${last.arb ? "arb" : "user"}`}>{last.arb ? "ARB" : "USER"}</span> : "—"}</b></div>
          </>
        ) : (
          <>
            <div><span>Weekly error</span><b>12 bps</b></div>
            <div><span>Correlation</span><b>0.999</b></div>
            <div><span>Order</span><b>6 / 6 right</b></div>
          </>
        )}
      </div>
    </div>
  );
}

export function HeroBoard() {
  return (
    <Providers>
      <Board />
    </Providers>
  );
}
