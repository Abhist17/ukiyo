"use client";

import { useVaultLogs, type VaultLog } from "@/lib/logs";
import { num, tickToPrice, usd } from "@/lib/chain";
import type { VaultLive } from "@/lib/useUkiyo";

const SHOWN: VaultLog["name"][] = ["EpochSettled", "PerformanceFee", "BondPenalty", "Rebalanced"];

function line(l: VaultLog): { icon: string; tone: "pos" | "neg" | ""; text: string } {
  const a = l.args;
  switch (l.name) {
    case "EpochSettled": {
      const e = num(a.edgeDelta as bigint);
      return { icon: "◷", tone: e >= 0 ? "pos" : "neg", text: `Epoch ${a.epoch} settled · Edge ${e >= 0 ? "+" : ""}${usd(e)}` };
    }
    case "PerformanceFee":
      return { icon: "★", tone: "pos", text: `Curator earned its fee · ${usd(num(a.value as bigint))} in shares` };
    case "BondPenalty":
      return { icon: "⚑", tone: "neg", text: `Bond paid depositors ${usd(num(a.penalty as bigint))} (loss over budget)` };
    case "Rebalanced": {
      const p1 = tickToPrice(Number(a.tickLower));
      const p2 = tickToPrice(Number(a.tickUpper));
      return { icon: "⇄", tone: "", text: `Range moved to ${usd(Math.min(p1, p2))} – ${usd(Math.max(p1, p2))}` };
    }
    default:
      return { icon: "·", tone: "", text: l.name };
  }
}

/** The vault's track record, newest first: settlements and their Edge, fees earned, bond payouts, range moves. */
export function VaultHistory({ v }: { v: VaultLive }) {
  const { data } = useVaultLogs();
  const mine = (data?.logs ?? [])
    .filter((l) => SHOWN.includes(l.name) && l.vault.toLowerCase() === v.address.toLowerCase())
    .slice(-8)
    .reverse();
  if (mine.length === 0) return null;
  return (
    <div className="history">
      <p className="label-sm">Track record</p>
      <ol>
        {mine.map((l, k) => {
          const x = line(l);
          return (
            <li key={`${l.block}-${k}`}>
              <span className="h-icon">{x.icon}</span>
              <span className={x.tone}>{x.text}</span>
              <span className="h-block mono">#{l.block.toString()}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
