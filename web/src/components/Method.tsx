import { TIERS, mean } from "@/lib/data";

const STEPS = [
  {
    title: "Classify",
    where: "beforeSwap",
    body: "A swap that pays a priority fee at or above the threshold is arbitrage. On Unichain arbitrageurs bid for the top of the block. When in doubt, call it arbitrage: then Edge is never overstated.",
  },
  {
    title: "Credit impact",
    where: "first beforeSwap of a block",
    body: "Users who pushed the price last block left a displacement the next arbitrage reverts in the LPs' favour. Each sleeve is credited l·(close − s*)²/s*, net per block, so a same-block round trip earns nothing.",
  },
  {
    title: "Attribute fees",
    where: "afterSwap",
    body: "Each sleeve's LP fee is computed exactly from the price path and booked as user or arbitrage fee. Arbitrage fees never count: they come straight back as loss.",
  },
  {
    title: "Mark and charge",
    where: "first afterSwap of a block",
    body: "The price right after the arbitrage slot is the block's mark s*. Each sleeve pays l·(s*ₖ − s*ₖ₋₁)²/s*ₖ₋₁, the loss to rebalancing, rounded up.",
  },
];

/** How the hook computes Edge, and the identity that makes the obvious formula wrong. */
export function Method() {
  return (
    <section className="block" id="method">
      <div className="section-head">
        <div>
          <span className="eyebrow">Method</span>
          <h2>Why the obvious formula overstates every curator</h2>
          <p>
            Loss-versus-rebalancing marked at pool prices is LVR <em>net of the fees arbitrageurs pay</em>. So
            &ldquo;fees − pool LVR&rdquo; counts arbitrage fees twice: once as income, once hidden inside a smaller
            loss.
          </p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="chart-title">LVR_true ≈ LVR_pool + fees paid by arbitrageurs</p>
        <p className="chart-sub">Mean per curator per week, bps of position value, BTC/USD 2024 replay</p>
        {TIERS.map((t) => {
          const truth = mean(t, "lvrTrue");
          const pool = mean(t, "lvrPool");
          const arb = mean(t, "arbFees");
          const max = Math.max(truth, pool + arb);
          return (
            <div key={t} style={{ marginBottom: 14 }}>
              <div className="label-sm" style={{ marginBottom: 4 }}>{t.replace("bps", " bps")} pool</div>
              <div className="decomp-row">
                <span style={{ fontSize: 14 }}>True LVR</span>
                <div className="decomp-bar">
                  <div style={{ width: `${(truth / max) * 100}%`, background: "var(--ink-2)" }}>{truth.toFixed(0)} bps</div>
                </div>
              </div>
              <div className="decomp-row">
                <span style={{ fontSize: 14 }}>Pool LVR + arb fees</span>
                <div className="decomp-bar">
                  <div style={{ width: `${(pool / max) * 100}%`, background: "var(--s1)" }}>{pool.toFixed(0)} pool</div>
                  <div style={{ width: `${(arb / max) * 100}%`, background: "var(--seal)" }}>{arb.toFixed(0)} arb fees</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div className="step" key={s.title}>
            <div className="n">{i + 1}</div>
            <h3>{s.title}</h3>
            <div className="where">{s.where}</div>
            <p>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
