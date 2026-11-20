import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HeroArt } from "@/components/HeroArt";
import { Scoreboard } from "@/components/Scoreboard";
import { Method } from "@/components/Method";
import { error, pairAgreement, total } from "@/lib/data";

const REPO = "https://github.com/Abhist17/ukiyo";

const VAULT = [
  ["Epochs", "Entries and exits settle in batches, so the Edge recorded for an epoch belongs to exactly the shares that held it."],
  ["No oracle", "A deposit buys the same fraction of every token the vault holds, like a Uniswap v2 mint. The rest is refunded."],
  ["Curator can't take funds", "Only the vault can move its sleeve, and liquidity removed through the hook always goes back to the vault."],
  ["One-way hand-over", "The hook owner hands a sleeve to its vault once and has no way back in."],
];

export default function Home() {
  const e = error("5bps");
  const order = pairAgreement(total("5bps", "edge"), total("5bps", "truth"));

  return (
    <>
      <header className="site-header">
        <div className="wrap">
          <a className="brand" href="#top">
            <Logo size={30} />
            Ukiyo <small>浮世</small>
          </a>
          <nav className="nav">
            <a href="#scoreboard">Scoreboard</a>
            <a href="#rankings" className="hide-sm">Rankings</a>
            <a href="#method" className="hide-sm">Method</a>
            <a href={REPO} className="hide-sm">GitHub</a>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="wrap" id="top">
        <section className="hero">
          <div className="hero-grid">
            <div>
              <span className="eyebrow">Uniswap v4 hook · curated liquidity</span>
              <h1>
                Fee APR rewards volume. <span style={{ whiteSpace: "nowrap" }}>Beat-HODL</span> rewards luck. <em>Edge rewards skill.</em>
              </h1>
              <p className="lede">
                Ukiyo is an honest scoreboard for liquidity curators. Every curator runs a sleeve in a hook-exclusive
                pool, and the hook measures, block by block and with no oracle, what each one actually earned against
                arbitrage.
              </p>
              <div className="formula" aria-label="Edge equals user fees plus user price impact minus arbitrage loss">
                <b>Edge</b> = user fees + user price impact − arbitrage loss
              </div>
              <div className="cta">
                <a className="btn" href="#scoreboard">See the scoreboard</a>
                <a className="btn ghost" href={REPO}>Read the code</a>
              </div>
            </div>
            <div className="hero-art">
              <HeroArt />
            </div>
          </div>
        </section>

        <div className="stats">
          <div className="stat">
            <div>
              <span className="big num">{e.edge.rmse.toFixed(0)}</span>
              <span className="vs">bps/week · naive <s>{e.naive.rmse.toFixed(0)}</s></span>
            </div>
            <p>Weekly error against each curator&apos;s true hedged P&amp;L (RMSE, 5 bps pool).</p>
          </div>
          <div className="stat">
            <div>
              <span className="big num">{e.edge.corr.toFixed(3)}</span>
              <span className="vs">naive <s>{e.naive.corr.toFixed(2)}</s></span>
            </div>
            <p>Correlation of weekly Edge with the truth over 52 weeks of real BTC prices.</p>
          </div>
          <div className="stat">
            <div>
              <span className="big num">{Math.round(order * 100)}%</span>
              <span className="vs">of curator pairs</span>
            </div>
            <p>Full-year ranking of six curators, ordered exactly as their real P&amp;L.</p>
          </div>
        </div>

        <div className="waves" aria-hidden />
        <Scoreboard />
        <div className="waves" aria-hidden />
        <Method />

        <section className="block" id="vaults">
          <div className="section-head">
            <div>
              <span className="eyebrow">Curator vaults</span>
              <h2>A vault per sleeve, scored by the hook</h2>
              <p>
                Depositors buy into a curator through a <code>UkiyoVault</code>. At every epoch boundary the vault
                collects fees, settles entries and exits, and records the Edge its sleeve earned.
              </p>
            </div>
          </div>
          <div className="steps">
            {VAULT.map(([t, b]) => (
              <div className="step" key={t}>
                <h3 style={{ marginTop: 0 }}>{t}</h3>
                <p>{b}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="wrap">
          <Logo size={22} />
          <span>Ukiyo · Uniswap Hook Incubator, cohort 11</span>
          <a href={REPO}>GitHub</a>
          <span style={{ marginLeft: "auto" }}>Unaudited hackathon code. Backtest figures, not live results.</span>
        </div>
      </footer>
    </>
  );
}
