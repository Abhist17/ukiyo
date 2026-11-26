import Link from "next/link";
import { Logo, Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HeroRank } from "@/components/landing/HeroRank";
import { LiveNumbers } from "@/components/landing/LiveNumbers";
import { Marquee, Motion } from "@/components/landing/Motion";
import { BlockExplainer } from "@/components/landing/BlockExplainer";
import { RankShift } from "@/components/RankShift";
import { error } from "@/lib/data";
import { CHAIN } from "@/lib/chain";
import "@/components/landing/landing.css";

const REPO = "https://github.com/Abhist17/ukiyo";

const STEPS = [
  {
    k: "01 · Classify",
    title: "Every swap is tagged at the door",
    body: "Under priority ordering, arbitrageurs bid for the top of the block. A swap that pays a priority fee at or above the threshold is arbitrage; when in doubt, the hook calls it arbitrage.",
    rows: [
      ["Tip ≥ threshold", "ARB", "arb"],
      ["No tip", "USER", "user"],
    ],
  },
  {
    k: "02 · Charge",
    title: "Arbitrage pays for what it takes",
    body: "Right after each block's first swap the hook marks the price. Each sleeve is charged the loss to rebalancing between consecutive marks, rounded against the curator.",
    rows: [
      ["Arbitrage loss", "− l·Δs*²/s*", "neg"],
      ["Arbitrage fees", "not counted", "muted"],
    ],
  },
  {
    k: "03 · Credit",
    title: "Users pay the curator",
    body: "Fees from user swaps count, and so does the user price impact that the next arbitrage reverts in the LPs' favour. A same-block round trip earns nothing.",
    rows: [
      ["User fees", "+ exact, per sleeve", "pos"],
      ["User impact", "+ l·(close − s*)²/s*", "pos"],
    ],
  },
];

const FAQ = [
  {
    q: "What is Edge?",
    a: "Edge = user fees + user price impact − arbitrage loss. It is the part of a liquidity position's P&L that the curator controls: what ordinary traders paid, minus what arbitrageurs took. The market's direction is left out, so a bull run does not make a curator look skilled.",
  },
  {
    q: "Why not rank by fee APR or by beating HODL?",
    a: "Fee APR rewards volume, including the arbitrage volume that is costing LPs money: the tightest range always earns the most fees. Beat-HODL rewards being on the right side of the price, so in a trending week every curator loses and in a round-trip week every curator wins.",
  },
  {
    q: "Why are arbitrage fees not counted?",
    a: "LVR measured at pool prices is already net of the fees arbitrageurs pay: LVR_true ≈ LVR_pool + arbitrage fees. Counting those fees as income as well counts them twice. On the BTC 2024 replay that mistake overstates every curator by 140–330 bps a week.",
  },
  {
    q: "How does the hook know which swaps are arbitrage?",
    a: "By the priority fee. On Unichain, priority ordering makes arbitrageurs bid for the top of the block. We measured this on 6,714 real Unichain swaps: today tips cluster around wallet defaults rather than separating informed flow, so on mainnet we recommend a 1 wei threshold and the README reports the remaining error.",
  },
  {
    q: "Is there an oracle?",
    a: "No. The hook reads only the pool's own prices: the close of each block and the mark right after its first swap. Vault deposits are proportional, like a Uniswap v2 mint, so they need no price either.",
  },
  {
    q: "Is it live, and is it audited?",
    a:
      CHAIN.id !== 31337
        ? `The demo runs on ${CHAIN.name} with free test tokens and a bot that replays BTC/USD 2024 through the pool. It works on any chain with a v4 PoolManager whose sequencer orders by priority fee, such as Unichain and Base. It is unaudited hackathon code: do not use it with real funds.`
        : "The demo runs on a local chain today (one deploy script and a bot that replays BTC/USD 2024 through the pool); the public testnet deployment is next. It is unaudited hackathon code: do not use it with real funds.",
  },
];

export default function Home() {
  const e = error("5bps");

  return (
    <div className="landing">
      <header className="l-nav">
        <div className="wrap l-nav-in">
          <Link className="wordmark-link" href="/" aria-label="Ukiyo home">
            <Wordmark size={28} />
          </Link>
          <nav>
            <a href="#how" className="hide-sm">How it works</a>
            <a href="#proof" className="hide-sm">Proof</a>
            <a href="#faq" className="hide-sm">FAQ</a>
            <Link href="/docs/" className="hide-sm">Docs</Link>
            <a href={REPO} className="hide-sm" target="_blank" rel="noreferrer">GitHub ↗</a>
            <ThemeToggle />
            <Link className="btn sm" href="/app/">Launch app</Link>
          </nav>
        </div>
      </header>

      <section className="l-hero">
        <div className="wrap hero-in">
          {/* each word rises out of its line's mask, one after another */}
          <h1 aria-label="Rank curators by skill, not luck">
            <span className="ln" aria-hidden>
              <W d={0}>Rank</W> <W d={1}>curators</W>
            </span>
            <span className="ln" aria-hidden>
              <W d={2}>by</W> <W d={3}><em>skill</em>,</W> <W d={4}>not</W> <W d={5}>luck</W>
            </span>
          </h1>
          <p className="l-lede">An on-chain score for every Uniswap v4 liquidity curator.</p>
          <div className="l-cta">
            <Link className="btn primary" href="/app/">Launch app</Link>
            <a className="btn ghost-light" href="#how">How it works</a>
          </div>
          <div className="hero-card">
            {/* tilted back at first, it flattens to face the reader over the first third of a screen of scrolling */}
            <div className="hero-tilt" data-scroll="top">
              <HeroRank />
            </div>
          </div>
        </div>
      </section>

      <section className="l-marquee" data-scroll="view">
        <Marquee quiet="Fee APR rewards volume · Beat-HODL rewards the market" loud="Edge rewards skill" />
      </section>

      <LiveNumbers />

      <section className="l-numbers">
        <div className="wrap">
          <p className="l-kicker" data-reveal>Backtested on a full year of real BTC/USD prices</p>
          <div className="big-num" data-reveal>
            <b data-count>{e.edge.rmse.toFixed(0)}</b> <span>bps</span>
          </div>
          <p className="big-cap" data-reveal>
            weekly error against each curator&apos;s true hedged P&amp;L. The obvious on-chain formula is off by{" "}
            <b>{e.naive.rmse.toFixed(0)} bps</b>.
          </p>
          <div className="num-row" data-reveal="stagger">
            <div><b data-count>{e.edge.corr.toFixed(3)}</b><span>correlation with true P&amp;L</span></div>
            <div><b data-count>6 / 6</b><span>curators in the true order</span></div>
            <div><b>0</b><span>oracles or keepers</span></div>
            <div><b data-count>106</b><span>tests + 5 stateful invariants</span></div>
          </div>
        </div>
      </section>

      <section className="l-section" id="how">
        <div className="wrap">
          <h2 data-reveal>One hook, three entries per swap</h2>
          <p className="l-sub" data-reveal>
            Every curator runs a sleeve in the same hook-exclusive pool. The hook keeps a ledger per sleeve, block by
            block.
          </p>
          <div data-reveal>
            <BlockExplainer />
          </div>
          <div className="l-steps" data-reveal="stagger">
            {STEPS.map((s) => (
              <div className="l-step" key={s.k}>
                <span className="k">{s.k}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <div className="l-step-rows">
                  {s.rows.map(([a, b, c]) => (
                    <div key={a}>
                      <span>{a}</span>
                      <b className={c === "arb" || c === "user" ? `badge ${c}` : c}>{b}</b>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* grows from a card to the full width as it scrolls in */}
      <section className="l-dark" id="proof" data-scroll="view">
        <div className="wrap">
          <h2 data-reveal>Every yardstick tells a different story</h2>
          <p className="l-sub" data-reveal>
            The same six curators over 2024, ranked five ways. Fee income crowns the curator that trades most against
            arbitrageurs. Only Edge puts them in the order of their true hedged P&amp;L.
          </p>
          <div className="dark-card" data-reveal>
            <RankShift tier="5bps" />
          </div>
          <div className="l-cta center">
            <Link className="btn light" href="/research/">See the full backtest</Link>
            <a className="btn ghost-light" href={`${REPO}/tree/main/backtest`} target="_blank" rel="noreferrer">Run it yourself ↗</a>
          </div>
        </div>
      </section>

      <section className="l-section">
        <div className="wrap l-split">
          <div data-reveal>
            <h2>A vault per curator, scored by the hook</h2>
            <p className="l-sub">
              Depositors back a curator through a <code>UkiyoVault</code>. Entries and exits settle at epoch boundaries,
              so the Edge recorded for an epoch belongs to exactly the shares that held it.
            </p>
            <Link className="btn primary" href="/app/">Open the vaults</Link>
          </div>
          <ul className="l-list" data-reveal="stagger">
            <li><b>Paid only for Edge.</b> The curator&apos;s fee is a share of Edge above a high-water mark: nothing for fee volume or a rising market, nothing until losses are earned back.</li>
            <li><b>Bonded against LVR.</b> Curators post a bond and a loss budget; an epoch that loses more pays the overshoot to depositors.</li>
            <li><b>No oracle.</b> A deposit buys the same share of every token the vault holds; the rest is refunded.</li>
            <li><b>Curators can&apos;t take funds.</b> Only the vault can move its sleeve, and removed liquidity always returns to it.</li>
            <li><b>One-way hand-over.</b> The hook owner gives each sleeve to its vault once, with no way back in.</li>
          </ul>
        </div>
      </section>

      <section className="l-section" id="faq">
        <div className="wrap l-faq">
          <div data-reveal>
            <h2>Questions</h2>
            <p className="l-sub">The rest is in the README, with every number traced to the script that produced it.</p>
          </div>
          <div data-reveal="stagger">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="l-final">
        <div className="wrap" data-reveal>
          <Logo size={56} />
          <h2>See which curator actually has Edge</h2>
          <div className="l-cta center">
            <Link className="btn primary" href="/app/">Launch app</Link>
            <a className="btn ghost" href={REPO} target="_blank" rel="noreferrer">GitHub ↗</a>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="wrap">
          <Logo size={20} />
          <span>Ukiyo 浮世 · Uniswap Hook Incubator, cohort 11</span>
          <span style={{ marginLeft: "auto" }}>Unaudited hackathon code. Test tokens only.</span>
        </div>
      </footer>
      <Motion />
    </div>
  );
}

/** One headline word, wrapped so it can rise out of its line. */
function W({ d, children }: { d: number; children: React.ReactNode }) {
  return (
    <span className="wd">
      <span style={{ ["--d" as string]: d }}>{children}</span>
    </span>
  );
}
