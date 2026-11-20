"use client";

import { useTape } from "@/lib/useUkiyo";
import { EXPLORER, compactUsd, usd } from "@/lib/chain";

/** Live tape of pool swaps, each tagged with how the hook classified it. */
export function Tape({ rows = 14 }: { rows?: number }) {
  const { data } = useTape();
  const list = data?.slice(0, rows) ?? [];
  return (
    <div className="tape">
      <div className="tape-head">
        <span>Block</span>
        <span>Flow</span>
        <span>Side</span>
        <span className="r">Size</span>
        <span className="r">Price</span>
      </div>
      {list.length === 0 && <p className="fine" style={{ padding: "8px 0" }}>Waiting for swaps…</p>}
      {list.map((t) => (
        <a key={t.tx} className="tape-row" href={EXPLORER ? `${EXPLORER}/tx/${t.tx}` : undefined} target="_blank" rel="noreferrer">
          <span className="mono muted">#{t.block.toString()}</span>
          <span><span className={`badge ${t.arb ? "arb" : "user"}`}>{t.arb ? "ARB" : "USER"}</span></span>
          <span className={t.buyBtc ? "pos" : "neg"}>{t.buyBtc ? "Buy" : "Sell"} tBTC</span>
          <span className="r num">{compactUsd(t.usd)}</span>
          <span className="r num">{usd(t.price)}</span>
        </a>
      ))}
    </div>
  );
}
