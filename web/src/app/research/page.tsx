import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Scoreboard } from "@/components/Scoreboard";
import { Method } from "@/components/Method";
import "@/components/landing/landing.css";

export const metadata: Metadata = {
  title: "Ukiyo Research · BTC/USD 2024 backtest",
  description: "Six curators, one year of real BTC prices: why fee APR and beat-HODL mislead, and how Edge tracks true hedged P&L.",
};

/** The full backtest: leaderboard, rank shift, the year week by week, and the method. */
export default function Research() {
  return (
    <>
      <header className="site-header">
        <div className="wrap">
          <Link className="brand" href="/">
            <Logo size={28} />
            Ukiyo
          </Link>
          <nav className="nav">
            <a href="#scoreboard">Scoreboard</a>
            <a href="#rankings" className="hide-sm">Rankings</a>
            <a href="#method" className="hide-sm">Method</a>
            <ThemeToggle />
            <Link className="btn sm" href="/app/">Launch app</Link>
          </nav>
        </div>
      </header>
      <main className="wrap">
        <section className="research-hero">
          <span className="eyebrow">Research · backtest</span>
          <h1>One year of real BTC prices, six curators, five ways to score them</h1>
          <p>
            A hook-exclusive 5 bps pool replayed through Bitstamp BTC/USD 2024, with top-of-block arbitrage and random
            user flow. Only the simulator knows each curator&apos;s true hedged P&amp;L; Ukiyo&apos;s on-chain Edge is
            scored against it.
          </p>
        </section>
        <Scoreboard />
        <Method />
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <Logo size={20} />
          <span>Ukiyo · Uniswap Hook Incubator, cohort 11</span>
          <span style={{ marginLeft: "auto" }}>Backtest figures, not live results.</span>
        </div>
      </footer>
    </>
  );
}
