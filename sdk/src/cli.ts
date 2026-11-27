#!/usr/bin/env node
// The `ukiyo` command: Ukiyo's scoreboard and accounting from a terminal. Run `ukiyo help`.
import { parseArgs } from "node:util";
import { createPublicClient, http, isHash, type Address, type Chain } from "viem";
import { createUkiyo, toNumber, type Row, type Scoreboard } from "./client.ts";
import { CHAINS, DEFAULT_CHAIN_ID, DEPLOYMENTS } from "./deployments.ts";
import { impactCredit, priceToSqrt, rebalancingLoss } from "./math.ts";
import { METRICS, misranked, positions, rank, type RankBy } from "./rank.ts";

const HELP = `ukiyo: an honest scoreboard for curated liquidity, from your terminal

Usage
  ukiyo scoreboard [--rank edge|index|tstat|fees] [--block N]   every curator's Edge, ranked
  ukiyo explain <txHash>                                       how the hook booked a transaction, and why
  ukiyo edge <sleeveId> --from N [--to N]                     Edge a curator earned between two blocks
  ukiyo watch [--edge]                                         follow swaps, marks and Edge live
  ukiyo cost --range LO:HI --from P0 --to P1 [--liquidity L]   what a price move costs a range (the hook's maths)
  ukiyo info                                                   the deployment this talks to

Options
  --rpc URL       RPC endpoint (default: the chain's public one)
  --chain ID      chain id (default ${DEFAULT_CHAIN_ID}, Unichain Sepolia)
  --hook ADDR     another Ukiyo hook (default: the known deployment)
  --lens ADDR     UkiyoLens to read it through
  --json          machine-readable output (bigints as strings)
`;

type Flags = Record<string, string | boolean | undefined>;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string" },
    chain: { type: "string" },
    hook: { type: "string" },
    lens: { type: "string" },
    json: { type: "boolean" },
    rank: { type: "string" },
    block: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    range: { type: "string" },
    liquidity: { type: "string" },
    edge: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
}) as { values: Flags; positionals: string[] };

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const die = (msg: string): never => {
  console.error(`ukiyo: ${msg}`);
  process.exit(1);
};
const big = (s: string | boolean | undefined, name: string): bigint | undefined => {
  if (s === undefined) return undefined;
  if (typeof s !== "string" || !/^\d+$/.test(s)) die(`--${name} must be a block number`);
  return BigInt(s as string);
};
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const green = paint(32);
const dim = paint(2);
const bold = paint(1);
const signed = (v: number, f: (n: number) => string) => (v > 0 ? green("+" + f(v)) : v < 0 ? red("−" + f(-v)) : f(0));
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const gwei = (wei: bigint) => `${(Number(wei) / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 3 })} gwei`;
// ANSI codes take no columns, so pad on the visible text
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s: string, w: number, right = false) => {
  const gap = " ".repeat(Math.max(0, w - visible(s).length));
  return right ? gap + s : s + gap;
};

function table(head: string[], rows: string[][], rightFrom = 1) {
  const w = head.map((h, i) => Math.max(visible(h).length, ...rows.map((r) => visible(r[i]).length)));
  const line = (r: string[]) => r.map((c, i) => pad(c, w[i], i >= rightFrom)).join("  ");
  console.log(dim(line(head)));
  for (const r of rows) console.log(line(r));
}

function connect() {
  const id = flags.chain ? Number(flags.chain) : DEFAULT_CHAIN_ID;
  const chain: Chain | undefined = CHAINS[id];
  const rpc = (flags.rpc as string | undefined) ?? chain?.rpcUrls.default.http[0];
  if (!rpc) die(`no public RPC known for chain ${id}; pass --rpc`);
  const client = createPublicClient({
    chain: chain ?? ({ id, name: `chain ${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc!] } } } as Chain),
    transport: http(rpc, { batch: true, retryCount: 3 }),
  });
  return createUkiyo({ client, hook: flags.hook as Address | undefined, lens: flags.lens as Address | undefined });
}

async function scoreboard() {
  const by = ((flags.rank as string) ?? "edge") as RankBy;
  if (!(by in METRICS)) die(`--rank must be one of ${Object.keys(METRICS).join(", ")}`);
  const u = connect();
  const sb: Scoreboard = await u.scoreboard(big(flags.block, "block"));
  if (flags.json) return console.log(json(sb));
  const d = sb.token1.decimals;
  const m = (raw: bigint) => toNumber(raw, d);
  const feeRank = positions(sb.rows, "fees");
  console.log(
    bold("Ukiyo scoreboard") +
      dim(` · block ${sb.blockNumber} · ${fmt(sb.pool.price)} ${sb.token1.symbol}/${sb.token0.symbol} · ranked by ${METRICS[by].label} · money in ${sb.token1.symbol}`),
  );
  const ranked = rank(sb.rows, by);
  table(
    ["#", "Curator", "Edge", "User fees", "Impact", "Arb loss", "Arb fees", "Index", "t-stat", "Fee rank"],
    ranked.map((r: Row, i) => [
      String(i + 1),
      r.name + (r.onProbation ? red(" (probation)") : "") + (r.hasSkill ? green(" ✓skill") : ""),
      signed(m(r.edge), fmt),
      fmt(m(r.ledger.userFees)),
      fmt(m(r.ledger.userImpact)),
      red(fmt(m(r.ledger.arbLoss))),
      dim(fmt(m(r.ledger.arbFees))),
      r.isVault ? fmt(toNumber(r.edgeIndex, 18), 4) : "–",
      r.isVault && r.edgeEpochs >= 2n ? fmt(toNumber(r.edgeTStat, 18), 1) : "–",
      String(feeRank.get(r.sleeveId)),
    ]),
    2,
  );
  const wrong = misranked(sb.rows);
  if (wrong.length) {
    const w = wrong[0];
    console.log(
      dim(
        `\nA fee-APR dashboard would put ${w.row.name} #${w.feeRank}; its Edge is #${w.edgeRank}, because arbitrage took ${fmt(m(w.row.ledger.arbLoss))} ${sb.token1.symbol} from it.`,
      ),
    );
  }
  console.log(dim(`Edge = user fees + user impact − arbitrage loss. Arbitrage fees are shown, never counted.`));
}

async function explain() {
  const hash = positionals[1];
  if (!hash || !isHash(hash)) die("usage: ukiyo explain <txHash>");
  const ex = await connect().explain(hash as `0x${string}`);
  if (flags.json) return console.log(json(ex));
  console.log(bold(`Transaction ${hash.slice(0, 10)}…`) + dim(` · block ${ex.blockNumber} · from ${ex.from}`));
  for (const line of ex.narrative) console.log("  " + line);
  for (const s of ex.swaps) {
    const rows = s.sleeveFees.filter((f) => f.fee > 0n);
    if (!rows.length) continue;
    console.log(dim(`\n  Fee by sleeve for ${s.isArbitrage ? "this arbitrage swap (reported, not counted)" : "this user swap (counted)"}:`));
    for (const f of rows) {
      const name = ex.block.find((b) => b.sleeveId === f.sleeveId)?.name ?? `Sleeve ${f.sleeveId}`;
      console.log(`    ${pad(name, 22)} ${fmt(toNumber(f.fee, ex.token1.decimals), 6)} ${ex.token1.symbol}`);
    }
  }
}

async function edge() {
  const id = Number(positionals[1]);
  if (!Number.isInteger(id) || id < 0) die("usage: ukiyo edge <sleeveId> --from N [--to N]");
  const from = big(flags.from, "from") ?? die("--from is required");
  const u = connect();
  const [r, meta] = await Promise.all([u.edgeBetween(id, from, big(flags.to, "to")), u.poolMeta()]);
  if (flags.json) return console.log(json(r));
  const m = (raw: bigint) => toNumber(raw, meta.token1.decimals);
  console.log(bold(`Sleeve ${id}, blocks ${from} → ${flags.to ?? "latest"}`) + dim(` · ${meta.token1.symbol}`));
  table(
    ["", "amount"],
    [
      ["User fees", fmt(m(r.userFees), 4)],
      ["User impact", fmt(m(r.userImpact), 4)],
      ["Arbitrage loss", red("−" + fmt(m(r.arbLoss), 4))],
      [bold("Edge"), signed(m(r.edge), (n) => fmt(n, 4))],
      [dim("Arbitrage fees (not counted)"), dim(fmt(m(r.arbFees), 4))],
    ],
  );
}

async function watch() {
  const u = connect();
  const { token1 } = await u.poolMeta();
  console.log(dim(`Watching ${u.hook} · Ctrl-C to stop`));
  u.watch({
    withEdge: !!flags.edge,
    onError: (e) => console.error(dim(`  (rpc: ${(e as Error).message.split("\n")[0]})`)),
    onBlock: (b) => {
      if (flags.json) return console.log(JSON.stringify(b, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
      const kinds = b.swaps.map((s) => (s.isArbitrage ? red(`arb(${gwei(s.tip)})`) : green("user"))).join(" ");
      let line = `block ${b.blockNumber}  ${kinds}`;
      if (b.price !== undefined) line += dim(`  mark ${fmt(b.price)}`);
      if (b.spikeNetted) line += dim("  spike netted");
      console.log(line);
      for (const d of b.edgeDelta ?? [])
        if (d.delta !== 0n) console.log(`    ${pad(d.name, 22)} Edge ${signed(toNumber(d.delta, token1.decimals), (n) => fmt(n, 4))}`);
    },
  });
}

function cost() {
  const range = typeof flags.range === "string" ? flags.range.split(":").map(Number) : [];
  const p0 = Number(flags.from);
  const p1 = Number(flags.to);
  if (range.length !== 2 || !(range[0] > 0 && range[1] > range[0]) || !(p0 > 0) || !(p1 > 0))
    die("usage: ukiyo cost --range LO:HI --from P0 --to P1 [--liquidity L]   (prices in token1 per token0)");
  const l = BigInt(typeof flags.liquidity === "string" ? flags.liquidity : "1000000000000000000000");
  const [lo, hi] = [priceToSqrt(range[0]), priceToSqrt(range[1])];
  const s0 = priceToSqrt(p0);
  const s1 = priceToSqrt(p1);
  const loss = rebalancingLoss(l, s0, s1, lo, hi);
  const credit = impactCredit(l, s0, s1, lo, hi);
  const half = priceToSqrt(p0 + (p1 - p0) / 2);
  const halfLoss = rebalancingLoss(l, s0, half, lo, hi);
  if (flags.json) return console.log(json({ liquidity: l, loss, credit, halfMoveLoss: halfLoss }));
  const n = (v: bigint) => fmt(toNumber(v), 6);
  console.log(bold(`A move ${p0} → ${p1} on range ${range[0]}–${range[1]}, liquidity ${l}`));
  console.log(`  If arbitrage made the move:   arbitrage loss ${red(n(loss))}  (l·(c1 − c0)²/c0, rounded up)`);
  console.log(`  If users made it and it reverts: impact credit ${green(n(credit))}  (same form, rounded down)`);
  if (halfLoss > 0n)
    console.log(dim(`  Half the move costs ${n(halfLoss)}: ${(Number(loss) / Number(halfLoss)).toFixed(2)}× less. The loss is quadratic in the move.`));
  console.log(dim(`  Raw token1 units shown as 18-decimal amounts; the bigint maths is the hook's, to the wei (ukiyo-sdk/math).`));
}

function info() {
  const id = flags.chain ? Number(flags.chain) : DEFAULT_CHAIN_ID;
  const d = DEPLOYMENTS[id];
  if (!d) die(`no deployment known on chain ${id}`);
  if (flags.json) return console.log(json(d));
  console.log(bold(`Ukiyo on ${CHAINS[id]?.name ?? `chain ${id}`}`) + dim(` (since block ${d.deployBlock})`));
  table(
    ["contract", "address"],
    [
      ["UkiyoHook", d.hook],
      ["UkiyoLens", d.lens ?? "–"],
      ["UkiyoFactory", d.factory ?? "–"],
      ["UkiyoSkillRouter", d.skillRouter ?? "–"],
      ["PoolManager", d.poolManager],
      ...d.vaults.map((v) => [`vault ${v.sleeveId}: ${v.name}`, v.address]),
    ],
    9,
  );
  console.log(dim(`pool fee ${d.fee / 1e4}% · tick spacing ${d.tickSpacing} · arbitrage tip threshold ${gwei(BigInt(d.threshold))}`));
}

const commands: Record<string, () => unknown> = { scoreboard, explain, edge, watch, cost, info };
const cmd = positionals[0];
if (!cmd || flags.help || cmd === "help") console.log(HELP);
else if (!commands[cmd]) die(`unknown command "${cmd}". Run \`ukiyo help\`.`);
else
  Promise.resolve(commands[cmd]()).catch((e: Error) => die((e as { shortMessage?: string }).shortMessage ?? e.message));
