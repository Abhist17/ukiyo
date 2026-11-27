"use client";

import { ReadProviders } from "@/components/ReadProviders";
import { useLive } from "@/lib/useUkiyo";
import { CHAIN, DEP, EXPLORER, compactUsd, short, usd } from "@/lib/chain";

/** The landing page's live band: what the deployed hook has measured so far, read straight from the chain. */
function Numbers() {
  const { data: live } = useLive();
  if (!live || !DEP || CHAIN.id === 31337) return null;
  const arbLoss = live.vaults.reduce((s, v) => s + v.arbLoss, 0);
  const arbFees = live.vaults.reduce((s, v) => s + v.arbFees, 0);
  const userFees = live.vaults.reduce((s, v) => s + v.userFees, 0);
  const bonds = live.vaults.reduce((s, v) => s + v.bond, 0);
  // read from vault state, so the landing page never downloads the swap history (on a 1 s chain it grows every day)
  const epochs = live.vaults.reduce((s, v) => s + v.epoch, 0);
  const skilled = live.vaults.filter((v) => v.hasSkill).length;
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
            <b>{epochs.toLocaleString("en-US")}</b>
            <span>{`epochs settled and scored (${skilled} of ${live.vaults.length} curators pass the skill test)`}</span>
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
    <ReadProviders>
      <Numbers />
    </ReadProviders>
  );
}
