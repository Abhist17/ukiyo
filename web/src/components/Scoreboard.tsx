"use client";

import { useState } from "react";
import { TIERS, type Tier } from "@/lib/data";
import { Leaderboard } from "./Leaderboard";
import { RankShift } from "./RankShift";
import { CumulativeChart } from "./CumulativeChart";

/** The interactive half of the page: one fee-tier switch drives the table, the rank shift and the year chart. */
export function Scoreboard() {
  const [tier, setTier] = useState<Tier>("5bps");
  const tierSwitch = (
    <div className="seg" role="group" aria-label="Pool fee tier">
      {TIERS.map((t) => (
        <button key={t} aria-pressed={tier === t} onClick={() => setTier(t)}>
          {t.replace("bps", " bps")} pool
        </button>
      ))}
    </div>
  );

  return (
    <>
      <section className="block" id="scoreboard">
        <div className="section-head">
          <div>
            <span className="eyebrow">Scoreboard · BTC/USD 2024 replay</span>
            <h2>Six curators, one year, ranked by skill</h2>
            <p>
              Each curator runs a sleeve in the same hook-exclusive pool. Ranked by Edge, next to every yardstick a
              dashboard would use instead. A green rank agrees with the curator&apos;s true hedged P&amp;L.
            </p>
          </div>
          {tierSwitch}
        </div>
        <div className="card">
          <Leaderboard tier={tier} />
        </div>
        <p className="foot-note">
          Totals over 52 weeks, as a % of each week&apos;s starting position value. Backtest numbers (backtest/
          experiments.py); classifier misses 3% of arbitrage and flags 3% of user swaps by mistake.
        </p>
      </section>

      <section className="block" id="rankings">
        <div className="section-head">
          <div>
            <span className="eyebrow">Same curators, five rankings</span>
            <h2>Every yardstick tells a different story. Only one tells the true one.</h2>
            <p>
              Fee income crowns the curator that trades most against arbitrageurs. Beat-HODL crowns whoever the price
              happened to favour. Edge, computed on-chain with no oracle, puts them in the same order as the hedged
              P&amp;L only a simulator can see.
            </p>
          </div>
          {tierSwitch}
        </div>
        <div className="card">
          <RankShift tier={tier} />
        </div>
      </section>

      <section className="block" id="year">
        <div className="section-head">
          <div>
            <span className="eyebrow">Week by week</span>
            <h2>Edge tracks the truth all year</h2>
            <p>Hover the chart to read any week. Click a curator to hide it.</p>
          </div>
          {tierSwitch}
        </div>
        <div className="card">
          <CumulativeChart tier={tier} />
        </div>
      </section>
    </>
  );
}
