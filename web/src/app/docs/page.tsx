import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CHAIN, DEP, EXPLORER } from "@/lib/chain";
import "@/components/landing/landing.css";
import "./docs.css";

export const metadata: Metadata = {
  title: "Ukiyo Docs · Read a curator's Edge",
  description: "How Ukiyo scores curators, how to read Edge from a contract or a frontend, and how the vaults, fee and bond work.",
};

const REPO = "https://github.com/Abhist17/ukiyo";

const NAV = [
  ["quickstart", "Quickstart"],
  ["edge", "What Edge measures"],
  ["solidity", "Read Edge in Solidity"],
  ["frontend", "Read Edge in a frontend"],
  ["vaults", "Vaults and epochs"],
  ["fee-bond", "Performance fee and LVR bond"],
  ["classifier", "The classifier"],
  ["deployments", "Deployments"],
  ["local", "Run it locally"],
  ["security", "Security"],
] as const;

function Code({ lang, children }: { lang: string; children: string }) {
  return (
    <pre className="code" data-lang={lang}>
      <code>{children.trim()}</code>
    </pre>
  );
}

const SOLIDITY = `
// The two views a vault, a scoreboard or a fee contract needs. Amounts are raw token1 units.
interface IUkiyoHook {
    struct Ledger { uint256 userFees; uint256 userImpact; uint256 arbLoss; uint256 arbFees; }
    function edge(uint256 sleeveId) external view returns (int256);
    function ledger(uint256 sleeveId) external view returns (Ledger memory);
}

contract CuratorScore {
    IUkiyoHook public immutable hook;
    constructor(IUkiyoHook hook_) { hook = hook_; }

    /// Edge earned between two snapshots, e.g. one fee period. Negative means arbitrage took more than users paid.
    function edgeSince(uint256 sleeveId, int256 snapshot) external view returns (int256) {
        return hook.edge(sleeveId) - snapshot;
    }
}`;

const VIEM = `
import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { unichainSepolia } from "viem/chains";

const hook = "${DEP?.hook ?? "0x…"}";
const abi = parseAbi([
  "function edge(uint256 sleeveId) view returns (int256)",
  "function ledger(uint256 sleeveId) view returns ((uint256 userFees, uint256 userImpact, uint256 arbLoss, uint256 arbFees))",
]);
const client = createPublicClient({ chain: unichainSepolia, transport: http() });

const edge = await client.readContract({ address: hook, abi, functionName: "edge", args: [0n] });
const l = await client.readContract({ address: hook, abi, functionName: "ledger", args: [0n] });
console.log("Edge", formatEther(edge), "= user fees", formatEther(l.userFees),
  "+ impact", formatEther(l.userImpact), "- arbitrage loss", formatEther(l.arbLoss));`;

const LOCAL = `
git clone --recurse-submodules ${REPO} && cd ukiyo
forge test                                   # 99 tests + 5 invariants
anvil --block-time 2                         # in another terminal
EPOCH=120 forge script script/DeployUkiyo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \\
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's public dev key
cd web && npm ci && npm run abi && npm run bot   # replay bot, leave running
npm run dev                                      # http://localhost:3000`;

/** Developer docs: what Edge is, how to read it from a contract or a frontend, and how the vaults work. */
export default function Docs() {
  const rows: [string, string][] = DEP
    ? [
        ["Hook (UkiyoHook)", DEP.hook],
        ["PoolManager", DEP.poolManager],
        ["Swap router (PoolSwapTest)", DEP.router],
        ["tBTC (token0)", DEP.btc],
        ["tUSD (token1)", DEP.usd],
        ...DEP.vaults.map((v) => [`Vault ${v.sleeveId}: ${v.name.replace("Ukiyo ", "")}`, v.address] as [string, string]),
      ]
    : [];

  return (
    <div className="landing docs-page">
      <header className="l-nav">
        <div className="wrap l-nav-in">
          <Link className="wordmark-link" href="/" aria-label="Ukiyo home">
            <Wordmark size={28} />
          </Link>
          <span className="docs-tag">Docs</span>
          <nav>
            <Link href="/research/" className="hide-sm">Research</Link>
            <a href={REPO} className="hide-sm" target="_blank" rel="noreferrer">GitHub ↗</a>
            <ThemeToggle />
            <Link className="btn sm" href="/app/">Launch app</Link>
          </nav>
        </div>
      </header>

      <div className="wrap docs-grid">
        <aside className="docs-nav">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`}>{label}</a>
          ))}
        </aside>

        <article className="docs-body">
          <h1>Ukiyo docs</h1>
          <p className="docs-lede">
            Ukiyo is a Uniswap v4 hook that scores each liquidity curator&apos;s skill on-chain. Anything that pays,
            ranks or chooses curators can read that score with one view call.
          </p>

          <section id="quickstart">
            <h2>Quickstart</h2>
            <ol>
              <li>Open the <Link href="/app/">app</Link>, connect a wallet on {CHAIN.name}, and mint test tokens on the Faucet tab.</li>
              <li>Swap on the Trade tab, once with no priority fee and once bidding one. The receipt shows the hook calling the first user flow and the second arbitrage.</li>
              <li>Deposit into a curator vault on the Vaults tab. It joins at the end of the epoch.</li>
              <li>Read any curator&apos;s Edge from your own code with the snippets below.</li>
            </ol>
          </section>

          <section id="edge">
            <h2>What Edge measures</h2>
            <Code lang="text">{"Edge = user fees + user price impact − arbitrage loss"}</Code>
            <ul>
              <li><b>User fees</b>: the sleeve&apos;s LP fee on every swap classified as user flow, attributed exactly from the price path.</li>
              <li><b>User price impact</b>: users&apos; net displacement in a block, which the next arbitrage reverts in the LPs&apos; favour. Credited on the next block&apos;s first swap; a same-block round trip earns nothing.</li>
              <li><b>Arbitrage loss</b>: the loss to rebalancing between consecutive post-arbitrage marks (the price right after each block&apos;s first swap). Rounded up.</li>
              <li><b>Arbitrage fees</b> are recorded in the ledger but never counted: LVR measured at pool prices is already net of them, so counting them as income would count them twice.</li>
            </ul>
            <p>All amounts are raw token1 units (tUSD in the demo, 18 decimals). Losses round up and credits round down, so rounding never overstates Edge.</p>
          </section>

          <section id="solidity">
            <h2>Read Edge in Solidity</h2>
            <p>Snapshot <code>edge(sleeveId)</code> at the start of a period and subtract it at the end; that is exactly what <code>UkiyoVault</code> does each epoch to charge its performance fee.</p>
            <Code lang="solidity">{SOLIDITY}</Code>
          </section>

          <section id="frontend">
            <h2>Read Edge in a frontend</h2>
            <Code lang="ts">{VIEM}</Code>
            <p>The public Unichain Sepolia RPC serves at most 1,000 blocks of logs per request; read event history in chunks (the app&apos;s <code>web/src/lib/logs.ts</code> does this incrementally).</p>
          </section>

          <section id="vaults">
            <h2>Vaults and epochs</h2>
            <table className="docs-table">
              <thead><tr><th>Call</th><th>Who</th><th>What happens</th></tr></thead>
              <tbody>
                <tr><td><code>requestDeposit(a0, a1)</code></td><td>anyone</td><td>Escrows both tokens until the epoch ends; <code>cancelDeposit</code> takes them back before that</td></tr>
                <tr><td><code>requestRedeem(shares)</code></td><td>holder</td><td>Hands shares to the vault for the end of the epoch</td></tr>
                <tr><td><code>settleEpoch()</code></td><td>anyone, after <code>epochEndsAt()</code></td><td>Collects fees, books the epoch&apos;s Edge (bond, fee), pays redemptions, mints deposits, redeploys</td></tr>
                <tr><td><code>claimRedemption(e)</code>, <code>claimRefund()</code></td><td>user</td><td>Withdraws payouts and the part of a deposit that did not fit the vault&apos;s mix</td></tr>
                <tr><td><code>rebalance(lo, hi)</code></td><td>curator</td><td>Moves the range; removed liquidity always returns to the vault</td></tr>
                <tr><td><code>rebalanceWithSwap(lo, hi, zeroForOne, amountIn)</code></td><td>curator</td><td>The same, after swapping idle tokens into the new range&apos;s mix; price move capped at 1%, booked as arbitrage</td></tr>
              </tbody>
            </table>
            <p>Deposits buy the same share of every token the vault holds (no oracle), and a new depositor must bring at least 0.01% of the vault&apos;s holdings of one token, so dust cannot fill the 32-slot queue.</p>
          </section>

          <section id="fee-bond">
            <h2>Performance fee and LVR bond</h2>
            <ul>
              <li><b>Fee</b>: each settlement adds the epoch&apos;s Edge per share to <code>edgePerShare</code>. Above <code>highWaterMark</code>, the curator receives <code>performanceFeeBps</code> of the gain as new shares (10% in the demo, capped at 20%). Losses must be earned back first.</li>
              <li><b>Bond</b>: the curator posts token1 with <code>postBond</code> and promises a budget with <code>setLvrBudget</code> (bps of value per epoch). An epoch whose negative Edge exceeds the budget moves the overshoot from the bond into the vault, capped at the bond. Budget changes apply next epoch; withdrawals are paid only after the next settlement&apos;s penalty.</li>
              <li>Both use <code>valueAtMark()</code>: the position valued at the hook&apos;s post-arbitrage mark, never the spot price of the settling transaction.</li>
              <li><b>Edge index</b>: each settlement multiplies <code>edgeIndex</code> (1e18 at launch) by 1 + the epoch&apos;s Edge over <code>epochStartValue</code>, the capital that earned it. It is a share price that counts only skill, so it ranks curators of any size on equal terms; the app ranks by it.</li>
              <li><b>Skill test</b>: <code>edgeTStat()</code> is the t-statistic of the per-epoch Edge returns, and <code>hasSkill()</code> is true at t &ge; 2, when the Edge is statistically clear of zero rather than a few lucky epochs.</li>
              <li><b>Probation</b>: if the Edge index falls <code>probationBps</code> below its peak, the curator cannot rebalance for three epochs. <code>minBond</code> is bond the curator can never withdraw.</li>
              <li><b>Open launches</b>: <code>UkiyoFactory.launch</code> deploys a genuine vault, opens and hands over its sleeve, and posts the bond, for anyone. It enforces a minimum epoch, probation and a permanent bond.</li>
              <li><b>Invest by skill</b>: <code>UkiyoSkillRouter.deposit</code> splits one deposit across curators in proportion to their skill tests (capped, nothing to a curator on probation, even while no one has shown skill), escrowing each slice in the depositor&apos;s name with <code>requestDepositFor</code>.</li>
            </ul>
          </section>

          <section id="classifier">
            <h2>The classifier</h2>
            <p>
              A swap is arbitrage when its priority fee (<code>tx.gasprice − block.basefee</code>) is at least{" "}
              <code>priorityFeeThreshold</code>. Rule: when in doubt, call it arbitrage. A classifier that never misses an
              arbitrage never overstates Edge. Raising the threshold waits 2 days; lowering it applies at once.
              Measured on 6,714 real Unichain swaps, tips do not yet separate informed flow cleanly (about 7% slip
              through at 1 wei), as the README reports.
            </p>
          </section>

          <section id="deployments">
            <h2>Deployments</h2>
            {DEP ? (
              <>
                <p>{CHAIN.name} (chain {CHAIN.id}), from block {DEP.deployBlock.toLocaleString("en-US")}. Test tokens only.</p>
                <table className="docs-table">
                  <thead><tr><th>Contract</th><th>Address</th></tr></thead>
                  <tbody>
                    {rows.map(([k, a]) => (
                      <tr key={a}>
                        <td>{k}</td>
                        <td>{EXPLORER ? <a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noreferrer"><code>{a}</code></a> : <code>{a}</code>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p>No deployment in this build.</p>
            )}
          </section>

          <section id="local">
            <h2>Run it locally</h2>
            <Code lang="bash">{LOCAL}</Code>
          </section>

          <section id="security">
            <h2>Security</h2>
            <p>
              Unaudited hackathon code. The <a href={`${REPO}/blob/main/THREAT_MODEL.md`} target="_blank" rel="noreferrer">threat model</a> lists
              every actor&apos;s powers, the mitigations, and what is still open.
            </p>
          </section>
        </article>
      </div>

      <footer className="site-footer">
        <div className="wrap">
          <span>Ukiyo 浮世 · Uniswap Hook Incubator, cohort 11</span>
          <span style={{ marginLeft: "auto" }}>Unaudited hackathon code. Test tokens only.</span>
        </div>
      </footer>
    </div>
  );
}
