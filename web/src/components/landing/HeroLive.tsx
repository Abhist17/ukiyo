"use client";

import { Providers } from "@/components/app/Providers";
import { useLive } from "@/lib/useUkiyo";
import { useVaultLogs } from "@/lib/logs";
import { CHAIN, DEP, EXPLORER, short } from "@/lib/chain";

/** One glass chip of live facts from the deployed hook; renders nothing until the chain answers. */
function Chip({ side }: { side: "left" | "right" }) {
  const { data: live } = useLive();
  const { data: logs } = useVaultLogs();
  if (!live || !DEP || CHAIN.id === 31337) return null;
  const swaps = logs?.logs.filter((l) => l.name === "SwapClassified") ?? [];
  const arb = swaps.filter((l) => l.args.isArbitrage).length;
  if (side === "left")
    return (
      <a className="hero-chip left" href={EXPLORER ? `${EXPLORER}/address/${DEP.hook}` : undefined} target="_blank" rel="noreferrer">
        <span><i className="dot live" /> Live on {CHAIN.name}</span>
        <b>block #{live.block.toLocaleString("en-US")}</b>
        <small>hook {short(DEP.hook)} ↗</small>
      </a>
    );
  return (
    <div className="hero-chip right">
      <span>Swaps classified by the hook</span>
      <b>{swaps.length.toLocaleString("en-US")}</b>
      <small>
        <em className="arb">{arb} arbitrage</em> · <em className="user">{swaps.length - arb} user</em>
      </small>
    </div>
  );
}

export function HeroLive({ side }: { side: "left" | "right" }) {
  return (
    <Providers>
      <Chip side={side} />
    </Providers>
  );
}
