"use client";

import { Providers } from "@/components/app/Providers";
import { useLive } from "@/lib/useUkiyo";
import { useVaultLogs } from "@/lib/logs";
import { CHAIN, DEP, EXPLORER, compactUsd, short, usd } from "@/lib/chain";

/** The landing page's live band: what the deployed hook has measured so far, read straight from the chain. */
function Numbers() {
  const { data: live } = useLive();
  const { data: logs } = useVaultLogs();
  if (!live || !DEP || CHAIN.id === 31337) return null;
  const arbLoss = live.vaults.reduce((s, v) => s + v.arbLoss, 0);
  const arbFees = live.vaults.reduce((s, v) => s + v.arbFees, 0);
  const userFees = live.vaults.reduce((s, v) => s + v.userFees, 0);
  const bonds = live.vaults.reduce((s, v) => s + v.bond, 0);
  const swaps = logs?.logs.filter((l) => l.name === "SwapClassified") ?? [];
  const arb = swaps.filter((l) => l.args.isArbitrage).length;
  const hookLink = EXPLORER ? `${EXPLORER}/address/${DEP.hook}` : undefined;

  return (
    <section className="l-live">
      <div className="wrap">
        <a className="l-kicker live-link" href={hookLink} target="_blank" rel="noreferrer">
          <span className="dot live" /> Live from the hook on {CHAIN.name} · {short(DEP.hook)} ↗
        </a>
        <div className="big-num live">{usd(arbLoss)}</div>
        <p className="big-cap">
          of arbitrage loss measured and charged to curators, block by block, plus <b>{usd(arbFees)}</b> of arbitrage
          fees the hook refused to count as income.
        </p>
        <div className="num-row">
          <div>
            {/* the swap history loads in 1,000-block chunks: show a placeholder, never a false zero */}
            <b>{logs ? swaps.length.toLocaleString("en-US") : "…"}</b>
            <span>{logs ? `swaps classified (${arb.toLocaleString("en-US")} arbitrage)` : "reading swap history"}</span>
          </div>
          <div><b>{usd(userFees)}</b><span>user fees credited</span></div>
          <div><b>{compactUsd(live.tvl)}</b><span>in curator vaults</span></div>
          <div><b>{compactUsd(bonds)}</b><span>posted as LVR bonds</span></div>
        </div>
        <p className="fine-c">Test tokens on a public testnet, driven by a bot replaying BTC/USD 2024.</p>
      </div>
    </section>
  );
}

export function LiveNumbers() {
  return (
    <Providers>
      <Numbers />
    </Providers>
  );
}
