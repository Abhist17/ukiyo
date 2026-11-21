import { usd } from "@/lib/chain";
import type { VaultLive } from "@/lib/useUkiyo";

/**
 * The formula as a picture, for one curator: what users paid (fees and price impact) against what arbitrage took,
 * and the Edge that is left. Arbitrage fees are shown struck through, because counting them would count them twice.
 */
export function EdgeBreakdown({ v }: { v: VaultLive }) {
  const gross = v.userFees + v.userImpact;
  const scale = Math.max(gross, v.arbLoss, 1);
  const rows: { label: string; value: number; tone: "pos" | "neg"; offset: number }[] = [
    { label: "User fees", value: v.userFees, tone: "pos", offset: 0 },
    { label: "User price impact", value: v.userImpact, tone: "pos", offset: v.userFees },
    { label: "Arbitrage loss", value: -v.arbLoss, tone: "neg", offset: Math.max(gross - v.arbLoss, 0) },
  ];
  const pct = (x: number) => `${(Math.abs(x) / scale) * 100}%`;
  return (
    <div className="eb">
      <div className="eb-head">
        <span>Edge, all time</span>
        <b className={v.edge >= 0 ? "pos" : "neg"}>{usd(v.edge)}</b>
      </div>
      {rows.map((r) => (
        <div className="eb-row" key={r.label}>
          <span className="eb-label">{r.label}</span>
          <span className="eb-track">
            <i className={r.tone} style={{ left: pct(r.offset), width: pct(r.value) }} />
          </span>
          <span className={`eb-val ${r.tone}`}>{r.value >= 0 ? "+" : ""}{usd(r.value)}</span>
        </div>
      ))}
      <div className="eb-row eb-off">
        <span className="eb-label">Arbitrage fees</span>
        <span className="eb-track" />
        <span className="eb-val"><s>{usd(v.arbFees)}</s> not counted</span>
      </div>
    </div>
  );
}
