import Link from "next/link";
import { Logo, Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HeroRank } from "@/components/landing/HeroRank";
import { LiveNumbers } from "@/components/landing/LiveNumbers";
import { Marquee, Motion } from "@/components/landing/Motion";
import { BlockExplainer } from "@/components/landing/BlockExplainer";
import { RankShift } from "@/components/RankShift";
import { error } from "@/lib/data";
import { CHAIN, DEP, EXPLORER, SOURCE_VERIFIED } from "@/lib/chain";
import "@/components/landing/landing.css";

const REPO = "https://github.com/Abhist17/ukiyo";

const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US")}%`;
const mins = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** The deployed contracts and the parameters they actually run with, read from the deployment file. */
const SPECS = DEP
  ? [
      {
        k: "UkiyoHook",
        title: "Scores every swap",
        addr: DEP.hook,
        rows: [
          ["Pool", `tBTC / tUSD · ${pct(DEP.fee / 100)}`],
          ["Arbitrage if tip ≥", `${BigInt(DEP.threshold).toLocaleString("en-US")} wei`],
          ["Raising that threshold", "waits 2 days"],
          ["Spike netting", "8 fee widths"],
          ["Oracles, keepers", "none"],
        ],
      },
      {
        k: `UkiyoVault × ${DEP.vaults.length}`,
        title: "Pays curators for Edge only",
        addr: DEP.vaults[0]?.address,
        rows: [
          ["Epoch", mins(DEP.epochLength)],
          ["Performance fee", DEP.performanceFeeBps != null ? `${pct(DEP.performanceFeeBps)} of new Edge` : "share of new Edge"],
          ["Probation after", DEP.probationBps != null ? `−${pct(DEP.probationBps)} Edge index` : "a drawdown"],
          ["Settles within", "1% of the last mark"],
          ["Skill test passes at", "t ≥ 2"],
        ],
      },
      {
        k: "UkiyoFactory + SkillRouter",
        title: "Open to any curator",
        addr: DEP.factory,
        rows: [
          ["Launch bond", DEP.launchBond ? `${(Number(BigInt(DEP.launchBond) / 10n ** 18n)).toLocaleString("en-US")} tUSD, kept` : "kept"],
          ["Vault bytecode", "hash-checked"],
          ["Curator can withdraw funds", "never"],
          ["Router splits a deposit", "by skill test"],
          ["Curators per pool", "up to 8"],
        ],
      },
    ].filter((s) => s.addr)
  : [];

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

const AUDIENCES = [
  {
    k: "Depositors",
    title: "Back skill, not volume",
    body: "Rank curators by Edge return and a t-statistic that says whether it is more than luck, or let the skill router split a deposit by the evidence. Your shares stay yours.",
  },
  {
    k: "Curators",
    title: "A record nobody can dispute",
    body: "The pool computes your Edge itself, block by block. Launch a vault in one call and get paid a share of Edge above a high-water mark, not of volume.",
  },
  {
    k: "Platforms",
    title: "Rank and route on it",
    body: "One view call returns every curator's ledger, Edge index, skill test and terms. No oracle, no keeper: it runs under any v4 pair on a priority-ordered chain.",
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
          <Link className="wordmark-link" href="/" title="Ukiyo home">
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
          <Link className="hero-tag" href="/app/">
            <span className="hero-dot" aria-hidden />
            Uniswap v4 hook · {CHAIN.id !== 31337 ? `live on ${CHAIN.name}` : "running locally"}
          </Link>
          {/* each word rises out of its line's mask, one after another */}
          <h1 aria-label="Fee APR picks the wrong curator">
            <span className="ln" aria-hidden>
              <W d={0}>Fee</W> <W d={1}>APR</W> <W d={2}>picks</W>
            </span>
            <span className="ln" aria-hidden>
              <W d={3}>the</W> <W d={4}><em>wrong</em></W> <W d={5}>curator</W>
            </span>
          </h1>
          <p className="l-lede">
            Curators manage Uniswap liquidity for depositors, and everyone ranks them by the fees they earn. But
            arbitrageurs pay fees while taking more than they pay. Ukiyo is a v4 hook that tells the two apart on every
            swap and keeps each curator&apos;s real score on-chain:
          </p>
          <div className="hero-formula" role="img" aria-label="Edge equals user fees plus user price impact minus arbitrage loss">
            <div className="hf-term pos">
              <b>User fees</b>
              <small>paid by ordinary traders</small>
            </div>
            <div className="hf-term pos">
              <span className="hf-op">+</span>
              <b>User price impact</b>
              <small>won back by the LPs</small>
            </div>
            <div className="hf-term neg">
              <span className="hf-op">−</span>
              <b>Arbitrage loss</b>
              <small>taken by arbitrageurs</small>
            </div>
            <div className="hf-term edge">
              <span className="hf-op">=</span>
              <b>Edge</b>
              <small>per curator, every block</small>
            </div>
          </div>
          <div className="l-cta">
            <Link className="btn primary" href="/app/">See the live scoreboard</Link>
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
            <b>{e.naive.rmse.toFixed(0)} bps</b>. Out of sample, on four years of ETH, Edge picks the true best curator{" "}
            <b>every year</b>; fee income does once.
          </p>
          <div className="num-row" data-reveal="stagger">
            <div><b data-count>{e.edge.corr.toFixed(3)}</b><span>correlation with true P&amp;L</span></div>
            <div><b data-count>6 / 6</b><span>curators in the true order</span></div>
            <div><b>0</b><span>oracles or keepers</span></div>
            <div><b data-count>113</b><span>tests + 5 stateful invariants</span></div>
          </div>
        </div>
      </section>

      <section className="l-section" id="how">
        <div className="wrap">
          <p className="l-eyebrow" data-reveal>How it works</p>
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

      <section className="l-section" id="safeguards">
        <div className="wrap l-split">
          <div data-reveal>
            <p className="l-eyebrow">Safeguards</p>
            <h2>Built to never flatter a curator</h2>
            <p className="l-sub">
              A scoreboard is only worth something if it cannot be gamed. Wherever the hook has to choose, it chooses
              against the curator, so Edge can read low but never high.
            </p>
            <a className="btn ghost" href={`${REPO}/blob/main/THREAT_MODEL.md`} target="_blank" rel="noreferrer">Read the threat model ↗</a>
          </div>
          <ul className="l-list" data-reveal="stagger">
            <li><b>Rounded against the curator.</b> Every loss rounds up and every credit rounds down.</li>
            <li><b>When in doubt, arbitrage.</b> A swap that might be informed is booked as arbitrage, so no arbitrage passes as user flow.</li>
            <li><b>Spikes charged once.</b> A tipped push that is pushed straight back is charged as one move, so a rival cannot make you look bad for free.</li>
            <li><b>Measured from where it joins.</b> New liquidity gets no credit for moves before it arrived, and taking it out and back, even into a shifted range, cannot reset its starting point.</li>
            <li><b>A price no transaction can set.</b> Vaults settle and rebalance only within 1% of the previous block&apos;s mark, so a sandwich cannot pick the price their capital goes in at.</li>
            <li><b>Checked against a second model.</b> A fuzz test replays random swaps, deposits and protocol fees through an independent model and demands every ledger match to the wei.</li>
          </ul>
        </div>
      </section>

      {/* grows from a card to the full width as it scrolls in */}
      <section className="l-dark" id="proof" data-scroll="view">
        <div className="wrap">
          <p className="l-eyebrow" data-reveal>Proof</p>
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

      <section className="l-section" id="impact">
        <div className="wrap">
          <p className="l-eyebrow" data-reveal>Why it matters</p>
          <h2 data-reveal>Capital follows the scoreboard</h2>
          <p className="l-sub" data-reveal>
            On the 2024 replay, fee income ranks the tight chaser first by more than twice the runner-up; its true
            hedged P&amp;L is third. The momentum curator earns 5,857 bps of fees while losing money, and only Edge
            shows the loss. Whoever ranks curators decides where liquidity goes.
          </p>
          <div className="l-steps" data-reveal="stagger">
            {AUDIENCES.map((a) => (
              <div className="l-step" key={a.k}>
                <span className="k">{a.k}</span>
                <h3>{a.title}</h3>
                <p>{a.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="l-section">
        <div className="wrap l-split">
          <div data-reveal>
            <p className="l-eyebrow">Vaults</p>
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
            <li><b>Skill, not luck.</b> Each vault publishes a t-statistic of its epoch Edge returns. At 2 or more, a few lucky epochs no longer explain it.</li>
            <li><b>Probation.</b> A curator whose Edge index falls past its drawdown limit cannot rebalance for three epochs, while depositors decide.</li>
            <li><b>Open launches.</b> Anyone can become a curator in one call: the factory deploys a hash-checked vault and takes a permanent bond.</li>
            <li><b>Invest by skill.</b> The skill router splits one deposit across curators by their skill tests, and the shares stay yours.</li>
            <li><b>Curators can&apos;t take funds.</b> Only the vault can move its sleeve, and removed liquidity always returns to it.</li>
          </ul>
        </div>
      </section>

      {SPECS.length > 0 && (
        <section className="l-section" id="contracts">
          <div className="wrap">
            <p className="l-eyebrow" data-reveal>On-chain</p>
            <h2 data-reveal>The contracts, as deployed</h2>
            <p className="l-sub" data-reveal>
              Live on {CHAIN.name}. These are the parameters they run with, and every one is in the verified source.
            </p>
            <div className="l-specs" data-reveal="stagger">
              {SPECS.map((c) => (
                <div className="l-spec" key={c.k}>
                  <span className="k">{c.k}</span>
                  <h3>{c.title}</h3>
                  <dl>
                    {c.rows.map(([a, b]) => (
                      <div key={a}>
                        <dt>{a}</dt>
                        <dd>{b}</dd>
                      </div>
                    ))}
                  </dl>
                  {EXPLORER && (
                    <a className="l-spec-link" href={`${EXPLORER}/address/${c.addr}${SOURCE_VERIFIED ? "#code" : ""}`} target="_blank" rel="noreferrer">
                      {SOURCE_VERIFIED ? "Read the verified code" : "View on the explorer"} <span aria-hidden>↗</span>
                    </a>
                  )}
                </div>
              ))}
            </div>
            <p className="l-spec-note" data-reveal>
              <Link href="/docs/#deployments">Every address</Link>
              {" · "}
              <code>npm run verify:live</code> checks the deployed bytecode against this repository.
            </p>
          </div>
        </section>
      )}

      <section className="l-section" id="faq">
        <div className="wrap l-faq">
          <div data-reveal>
            <p className="l-eyebrow">FAQ</p>
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
