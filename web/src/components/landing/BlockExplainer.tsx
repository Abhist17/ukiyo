"use client";

import { useEffect, useState } from "react";

/** Illustrative path through two blocks (pool price, in dollars per tBTC, around 100 for readability). */
const MARK_1 = 100;
const MARKET = 101;
const ARB_TO = 100.95; // arbitrage stops one fee-width short of the market
const USER_PATH = [100.62, 100.78, 100.45]; // three user swaps; the last price is the block's close
const CLOSE = USER_PATH[USER_PATH.length - 1];

/** Illustrative ledger entries for the sleeve, in dollars (they follow the formulas' shapes, not real data). */
const LOSS = 9.03; // l·(s*₂ − s*₁)² / s*₁ for this sleeve
const ARB_FEE = 0.47; // paid by the arbitrage, booked but never counted
const USER_FEES = [2.4, 2.4, 2.4];
const CREDIT = 2.5; // l·(close − s*₂)² / s*₂, credited when the next arbitrage reverts it

const STEPS = [
  { title: "The market moves", body: "Block 1 has closed with the pool at the hook's last mark. Then the real market moves up; the pool hasn't yet." },
  { title: "Arbitrage goes first", body: "An arbitrageur bids the top priority fee and buys until the pool is one fee-width from the market. The hook marks the price right after it. The move between marks is the curator's loss; the arbitrage's fee is not income." },
  { title: "Users trade after", body: "Ordinary traders pay no tip and land after the arbitrage. Their fees count. Their trades push the price away from the market." },
  { title: "Next block, arbitrage reverts the push", body: "The next block's arbitrage pulls the price back to the market. The curator gains on that round trip, so the hook credits the users' price impact." },
];

const W = 760;
const H = 300;
const X = { b1: 50, b2: 230, arb: 250, u: [330, 400, 470], b3: 540, arb2: 560, end: 720 };
const y = (p: number) => 250 - ((p - 99.75) / (101.25 - 99.75)) * 200;
const usd = (v: number) => `$${v.toFixed(2)}`;

/** A two-block walk-through of how the hook scores a sleeve: loss at the marks, user fees, then the impact credit. */
export function BlockExplainer() {
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 3600);
    return () => clearInterval(id);
  }, [auto]);
  const go = (s: number) => {
    setAuto(false);
    setStep(s);
  };
  const on = (s: number) => (step >= s ? 1 : 0);
  const fees = USER_FEES.reduce((a, b) => a + b, 0);
  const edge = (step >= 2 ? fees : 0) + (step >= 3 ? CREDIT : 0) - (step >= 1 ? LOSS : 0);

  // user path as a step line from the arbitrage mark through each swap to the close
  const userPts: [number, number][] = [[X.arb, ARB_TO]];
  USER_PATH.forEach((p, k) => {
    userPts.push([X.u[k], userPts[userPts.length - 1][1]], [X.u[k], p]);
  });
  userPts.push([X.b3, CLOSE]);
  const userD = userPts.map(([px, p], k) => `${k ? "L" : "M"}${px} ${y(p)}`).join(" ");

  return (
    <div className="bx">
      <div className="bx-steps" role="tablist" aria-label="Steps">
        {STEPS.map((s, k) => (
          <button key={s.title} role="tab" aria-selected={k === step} onClick={() => go(k)} className={k < step ? "done" : ""}>
            <span>{k + 1}</span>
            {s.title}
          </button>
        ))}
      </div>

      <div className="bx-body">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Pool price through two blocks: arbitrage, user trades, and the revert">
          {/* blocks */}
          <rect x={X.b2} y={20} width={X.b3 - X.b2} height={250} rx="10" fill="var(--card-2)" />
          <text x={X.b1 + 6} y={286} className="bx-ax">block 1</text>
          <text x={X.b2 + 8} y={286} className="bx-ax">block 2</text>
          <text x={X.b3 + 8} y={286} className="bx-ax">block 3</text>

          {/* the market */}
          <g style={{ opacity: on(0), transition: "opacity 400ms" }}>
            <path d={`M${X.b1} ${y(MARK_1)} L${X.b2 - 30} ${y(MARK_1)} L${X.b2 - 30} ${y(MARKET)} L${X.end} ${y(MARKET)}`}
              fill="none" stroke="var(--muted)" strokeDasharray="4 5" strokeWidth="1.5" />
            <text x={X.end} y={y(MARKET) - 10} textAnchor="end" className="bx-ax">market price</text>
          </g>

          {/* pool: block 1 */}
          <path d={`M${X.b1} ${y(MARK_1)} L${X.arb} ${y(MARK_1)}`} stroke="var(--ink)" strokeWidth="2.5" fill="none" />
          <circle cx={X.b1 + 110} cy={y(MARK_1)} r="5" fill="var(--ink)" />
          <text x={X.b1 + 110} y={y(MARK_1) + 22} textAnchor="middle" className="bx-lbl">mark s*₁</text>

          {/* step 1: arbitrage */}
          <g style={{ opacity: on(1), transition: "opacity 400ms" }}>
            <path d={`M${X.arb} ${y(MARK_1)} L${X.arb} ${y(ARB_TO)}`} stroke="var(--bad)" strokeWidth="3" />
            <circle cx={X.arb} cy={y(ARB_TO)} r="5" fill="var(--bad)" />
            <text x={X.arb + 10} y={y(ARB_TO) - 10} className="bx-lbl">mark s*₂</text>
            <path d={`M${X.arb - 16} ${y(MARK_1)} L${X.arb - 22} ${y(MARK_1)} L${X.arb - 22} ${y(ARB_TO)} L${X.arb - 16} ${y(ARB_TO)}`}
              fill="none" stroke="var(--bad)" strokeWidth="1.5" />
            <text x={X.arb - 28} y={(y(MARK_1) + y(ARB_TO)) / 2 + 4} textAnchor="end" className="bx-lbl neg">arbitrage loss</text>
          </g>

          {/* step 2: users */}
          <g style={{ opacity: on(2), transition: "opacity 400ms" }}>
            <path d={userD} stroke="var(--good)" strokeWidth="2.5" fill="none" />
            {USER_PATH.map((p, k) => (
              <g key={k}>
                <circle cx={X.u[k]} cy={y(p)} r="4.5" fill="var(--good)" />
                {/* above a swap that pushed the price up, below one that pushed it down, so it never sits on the line */}
                <text x={X.u[k]} y={p > (k ? USER_PATH[k - 1] : ARB_TO) ? y(p) - 12 : y(p) + 20} textAnchor="middle" className="bx-chip">+fee</text>
              </g>
            ))}
            <text x={X.b3 - 6} y={y(CLOSE) + 22} textAnchor="end" className="bx-lbl">close</text>
          </g>

          {/* step 3: revert */}
          <g style={{ opacity: on(3), transition: "opacity 400ms" }}>
            <path d={`M${X.b3} ${y(CLOSE)} L${X.arb2} ${y(CLOSE)} L${X.arb2} ${y(ARB_TO)} L${X.end} ${y(ARB_TO)}`}
              stroke="var(--ink)" strokeWidth="2.5" fill="none" />
            <path d={`M${X.arb2 + 16} ${y(CLOSE)} L${X.arb2 + 22} ${y(CLOSE)} L${X.arb2 + 22} ${y(ARB_TO)} L${X.arb2 + 16} ${y(ARB_TO)}`}
              fill="none" stroke="var(--good)" strokeWidth="1.5" />
            <text x={X.arb2 + 28} y={(y(CLOSE) + y(ARB_TO)) / 2 + 4} className="bx-lbl pos">impact credit</text>
          </g>
        </svg>

        <aside className="bx-side">
          <p className="bx-title">{STEPS[step].title}</p>
          <p className="bx-text">{STEPS[step].body}</p>
          <dl className="bx-ledger">
            <div className={step >= 1 ? "" : "off"}><dt>Arbitrage loss</dt><dd className="neg">−{usd(LOSS)}</dd></div>
            <div className={step >= 1 ? "struck" : "off"}><dt>Arbitrage fee</dt><dd>{usd(ARB_FEE)} not counted</dd></div>
            <div className={step >= 2 ? "" : "off"}><dt>User fees</dt><dd className="pos">+{usd(fees)}</dd></div>
            <div className={step >= 3 ? "" : "off"}><dt>Impact credit</dt><dd className="pos">+{usd(CREDIT)}</dd></div>
            <div className="total"><dt>Edge so far</dt><dd className={edge >= 0 ? "pos" : "neg"}>{edge >= 0 ? "+" : "−"}{usd(Math.abs(edge))}</dd></div>
          </dl>
          <small>Illustrative numbers for one sleeve. The hook computes the same terms on-chain, every block.</small>
        </aside>
      </div>
    </div>
  );
}
