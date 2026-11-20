import { CURATORS, METRICS, type MetricKey, type Tier, pct, ranks, total } from "@/lib/data";

const COLS: MetricKey[] = ["truth", "fees", "hodl", "naive"];

/**
 * Curators ranked by Ukiyo Edge. Every other yardstick sits beside it with the rank it would have given; a green
 * rank means that yardstick agrees with the true hedged P&L.
 */
export function Leaderboard({ tier }: { tier: Tier }) {
  const t = Object.fromEntries(METRICS.map((m) => [m.key, total(tier, m.key)])) as Record<MetricKey, number[]>;
  const r = Object.fromEntries(METRICS.map((m) => [m.key, ranks(t[m.key])])) as Record<MetricKey, number[]>;
  const order = CURATORS.map((_, i) => i).sort((a, b) => r.edge[a] - r.edge[b]);
  const span = Math.max(...t.edge.map(Math.abs));
  const neg = Math.max(0, -Math.min(...t.edge)) / span; // share of the track left of zero
  const zeroAt = neg / (1 + neg);

  return (
    <div className="scroll-x">
      <table className="board">
        <caption className="sr-only">Curators ranked by Ukiyo Edge over 2024, with the rank each other metric gives</caption>
        <thead>
          <tr>
            <th className="l">#</th>
            <th className="l">Curator</th>
            <th className="edge-col">Ukiyo Edge</th>
            <th>True hedged P&amp;L</th>
            <th>Fee income</th>
            <th>vs HODL</th>
            <th>Fees − pool LVR</th>
          </tr>
        </thead>
        <tbody>
          {order.map((i) => {
            const e = t.edge[i];
            const w = (Math.abs(e) / span) * (1 - zeroAt) * 100;
            return (
              <tr key={i}>
                <td className="l">
                  <span className={`rank-seal ${r.edge[i] === 1 ? "first" : ""}`}>{r.edge[i]}</span>
                </td>
                <td className="l">
                  <div className="who">
                    <span className="chip" style={{ background: `var(--s${i + 1})` }} />
                    <div>
                      <b>{CURATORS[i].short}</b>
                      <span>{CURATORS[i].style}</span>
                    </div>
                  </div>
                </td>
                <td className="edge-col">
                  <div className="edge-bar">
                    <div className="track" aria-hidden>
                      <div className="zero" style={{ left: `${zeroAt * 100}%` }} />
                      <div
                        className="fill"
                        style={{
                          background: `var(--s${i + 1})`,
                          width: `${w}%`,
                          left: e >= 0 ? `${zeroAt * 100}%` : `${zeroAt * 100 - w}%`,
                        }}
                      />
                    </div>
                    <span className="cell-val" style={{ fontWeight: 700 }}>
                      {pct(e)}
                    </span>
                  </div>
                </td>
                {COLS.map((k) => (
                  <td key={k}>
                    <span className="cell-val">{pct(t[k][i], k === "fees" ? 0 : 1)}</span>
                    <span
                      className={`rk ${r[k][i] === (k === "truth" ? r.edge[i] : r.truth[i]) ? "match" : ""}`}
                      title={`Rank by ${METRICS.find((m) => m.key === k)!.label}`}
                    >
                      #{r[k][i]}
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
