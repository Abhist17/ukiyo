import {
  type Address,
  type Chain,
  type Transport,
  type Hash,
  type Log,
  type PublicClient,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiItem,
} from "viem";
import { hookAbi, lensAbi } from "./abi.ts";
import { DEPLOYMENTS, type Deployment } from "./deployments.ts";
import { getSqrtPriceAtTick, lpFeeRate, sqrtToPrice, swapFee } from "./math.ts";

/** A sleeve's running totals, in raw token1 units. Edge = userFees + userImpact − arbLoss; arbFees is reported only. */
export interface Ledger {
  userFees: bigint;
  userImpact: bigint;
  arbLoss: bigint;
  arbFees: bigint;
}

/** One curator's line on the scoreboard. The vault fields are zero/empty when the sleeve is not run by a vault. */
export interface Row {
  sleeveId: number;
  curator: Address;
  manager: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  ledger: Ledger;
  /** userFees + userImpact − arbLoss, raw token1. */
  edge: bigint;
  isVault: boolean;
  name: string;
  symbol: string;
  /** Compounded Edge return over the capital that earned it; 1e18 at launch. Size-neutral skill. */
  edgeIndex: bigint;
  /** t-statistic of per-epoch Edge returns, 1e18 = 1.0. Skill needs ≥ 2. */
  edgeTStat: bigint;
  edgeEpochs: bigint;
  hasSkill: boolean;
  onProbation: boolean;
  epoch: bigint;
  capital: bigint;
  bond: bigint;
  performanceFeeBps: bigint;
}

/** Pool-level state. Prices are token1 per token0 with decimals applied. */
export interface PoolState {
  sqrtPriceX96: bigint;
  referenceSqrtPriceX96: bigint;
  lastPostMark: bigint;
  lastMarkedBlock: bigint;
  /** Tip per gas (wei) at or above which a swap is booked as arbitrage. */
  priorityFeeThreshold: bigint;
  price: number;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface Scoreboard {
  blockNumber: bigint;
  pool: PoolState;
  token0: TokenInfo;
  token1: TokenInfo;
  rows: Row[];
}

/** How one swap through the hook's pool was booked. */
export interface SwapBooking {
  /** The router (or vault) that called PoolManager.swap; the hook's `sender`. */
  sender: Address;
  isArbitrage: boolean;
  /** Why: a tip at or above the threshold, a sleeve manager trading for its vault, or neither (user flow). */
  reason: "tip" | "sleeve-manager" | "user";
  tip: bigint;
  threshold: bigint;
  /** The first swap of its block: the hook credited the previous block's impact and marked the price after it. */
  firstInBlock: boolean;
  amount0: bigint;
  amount1: bigint;
  sqrtBefore: bigint;
  sqrtAfter: bigint;
  priceBefore: number;
  priceAfter: number;
  /** The post-arbitrage mark set by this swap, when it was the block's first. */
  mark?: bigint;
  /** Whether the mark netted a spike (a move and its reversal charged once). */
  spikeNetted: boolean;
  /** Each sleeve's LP fee from this swap (raw token1), from its range and liquidity at the start of the block. */
  sleeveFees: { sleeveId: number; fee: bigint }[];
}

/** What a transaction did on a Ukiyo pool, and what the hook booked for its block. */
export interface Explanation {
  hash: Hash;
  blockNumber: bigint;
  from: Address;
  swaps: SwapBooking[];
  /** Swaps through the hook in the whole block (the ledgers below cover all of them). */
  swapsInBlock: number;
  /** Each sleeve's ledger change over the block, read from chain state before and after it. */
  block: { sleeveId: number; name: string; delta: Ledger; edgeDelta: bigint }[];
  token0: TokenInfo;
  token1: TokenInfo;
  /** The same, in plain sentences. */
  narrative: string[];
}

/** One block with hook activity, as `watch` reports it. */
export interface BlockActivity {
  blockNumber: bigint;
  swaps: { isArbitrage: boolean; tip: bigint }[];
  mark?: bigint;
  price?: number;
  spikeNetted: boolean;
  /** Each sleeve's Edge change over the block (raw token1), when `withEdge` is on. */
  edgeDelta?: { sleeveId: number; name: string; delta: bigint }[];
}

export interface UkiyoOptions<C extends Chain | undefined = Chain | undefined> {
  /** A viem public client on the deployment's chain (any chain type, OP-stack formatters included). */
  client: PublicClient<Transport, C>;
  /** The hook; defaults to the known deployment on the client's chain. */
  hook?: Address;
  /** UkiyoLens; defaults to the deployment's. Without one the SDK reads the hook directly (vault fields left empty). */
  lens?: Address;
  /** Widest eth_getLogs range the RPC accepts (the public Unichain Sepolia RPC caps it at 1000). */
  maxLogRange?: bigint;
}

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const emptyLedger = (): Ledger => ({ userFees: 0n, userImpact: 0n, arbLoss: 0n, arbFees: 0n });
const sub = (a: Ledger, b: Ledger): Ledger => ({
  userFees: a.userFees - b.userFees,
  userImpact: a.userImpact - b.userImpact,
  arbLoss: a.arbLoss - b.arbLoss,
  arbFees: a.arbFees - b.arbFees,
});

/** The Ukiyo client: the scoreboard, Edge over a period, a transaction's booking, and a live feed. */
export function createUkiyo<C extends Chain | undefined>(opts: UkiyoOptions<C>) {
  // one concrete client type inside; callers keep their own chain type (unichainSepolia carries OP-stack formatters)
  const client = opts.client as unknown as PublicClient;
  const chainId = client.chain?.id;
  const dep: Deployment | undefined = chainId !== undefined ? DEPLOYMENTS[chainId] : undefined;
  const hook = opts.hook ?? dep?.hook;
  if (!hook) throw new Error(`no Ukiyo deployment known on chain ${chainId}; pass { hook }`);
  // the deployment's lens only reads the deployment's hook's vaults correctly if it is that hook
  const lens = opts.lens ?? (opts.hook === undefined || opts.hook === dep?.hook ? dep?.lens : undefined);
  const maxLogRange = opts.maxLogRange ?? 1000n;
  const vaultNames = new Map((dep?.hook === hook ? dep.vaults : []).map((v) => [v.sleeveId, v.name]));

  let meta: Promise<{ token0: TokenInfo; token1: TokenInfo; lpFee: number; poolId: Hash; poolManager: Address }> | undefined;

  /** The pool's tokens, fee, id and PoolManager, read once. */
  function poolMeta() {
    meta ??= (async () => {
      const [key, pm] = await Promise.all([
        client.readContract({ address: hook!, abi: hookAbi, functionName: "poolKey" }),
        client.readContract({ address: hook!, abi: hookAbi, functionName: "poolManager" }),
      ]);
      const [currency0, currency1, fee, tickSpacing, hooks] = key as readonly [Address, Address, number, number, Address];
      const token = async (address: Address): Promise<TokenInfo> => {
        if (address === ZERO) return { address, symbol: "ETH", decimals: 18 };
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address, abi: ERC20, functionName: "symbol" }).catch(() => "token"),
          client.readContract({ address, abi: ERC20, functionName: "decimals" }).catch(() => 18),
        ]);
        return { address, symbol, decimals: Number(decimals) };
      };
      const poolId = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
          [currency0, currency1, fee, tickSpacing, hooks],
        ),
      );
      const [token0, token1] = await Promise.all([token(currency0), token(currency1)]);
      return { token0, token1, lpFee: fee, poolId, poolManager: pm as Address };
    })();
    return meta;
  }

  /** The whole scoreboard, at the latest block or at `blockNumber` (needs an RPC that serves past state). */
  async function scoreboard(blockNumber?: bigint): Promise<Scoreboard> {
    const at = blockNumber ?? (await client.getBlockNumber());
    const { token0, token1 } = await poolMeta();
    let pool: Omit<PoolState, "price">;
    let rows: Row[];
    if (lens) {
      const [p, rs] = await client.readContract({
        address: lens,
        abi: lensAbi,
        functionName: "scoreboard",
        args: [hook!],
        blockNumber: at,
      });
      pool = p;
      rows = rs.map((r) => ({
        sleeveId: Number(r.sleeveId),
        curator: r.curator,
        manager: r.manager,
        tickLower: r.tickLower,
        tickUpper: r.tickUpper,
        liquidity: r.liquidity,
        ledger: { ...r.ledger },
        edge: r.edge,
        isVault: r.isVault,
        name: r.name || vaultNames.get(Number(r.sleeveId)) || `Sleeve ${r.sleeveId}`,
        symbol: r.symbol,
        edgeIndex: r.edgeIndex,
        edgeTStat: r.edgeTStat,
        edgeEpochs: r.edgeEpochs,
        hasSkill: r.hasSkill,
        onProbation: r.onProbation,
        epoch: r.epoch,
        capital: r.capital,
        bond: r.bond,
        performanceFeeBps: r.performanceFeeBps,
      }));
    } else {
      const read = <T>(functionName: string, args: unknown[] = []) =>
        client.readContract({ address: hook!, abi: hookAbi, functionName, args, blockNumber: at } as never) as Promise<T>;
      const [n, sqrt, ref, mark, marked, threshold] = await Promise.all([
        read<bigint>("sleeveCount"),
        read<bigint>("sqrtPriceX96"),
        read<bigint>("referenceSqrtPrice"),
        read<bigint>("lastPostMark"),
        read<bigint>("lastMarkedBlock"),
        read<bigint>("priorityFeeThreshold"),
      ]);
      pool = { sqrtPriceX96: sqrt, referenceSqrtPriceX96: ref, lastPostMark: mark, lastMarkedBlock: marked, priorityFeeThreshold: threshold };
      rows = await Promise.all(
        Array.from({ length: Number(n) }, async (_, i) => {
          const id = BigInt(i);
          const [s, l, e, m] = await Promise.all([
            read<{ tickLower: number; tickUpper: number; liquidity: bigint; curator: Address }>("sleeve", [id]),
            read<Ledger>("ledger", [id]),
            read<bigint>("edge", [id]),
            read<Address>("sleeveManager", [id]),
          ]);
          return {
            sleeveId: i, curator: s.curator, manager: m, tickLower: s.tickLower, tickUpper: s.tickUpper,
            liquidity: s.liquidity, ledger: { ...l }, edge: e, isVault: false, name: vaultNames.get(i) ?? `Sleeve ${i}`,
            symbol: "", edgeIndex: 0n, edgeTStat: 0n, edgeEpochs: 0n, hasSkill: false, onProbation: false, epoch: 0n,
            capital: 0n, bond: 0n, performanceFeeBps: 0n,
          };
        }),
      );
    }
    return {
      blockNumber: at,
      pool: { ...pool, price: sqrtToPrice(pool.sqrtPriceX96, token0.decimals, token1.decimals) },
      token0,
      token1,
      rows,
    };
  }

  /** A sleeve's Edge (raw token1) at a block. */
  async function edgeAt(sleeveId: number, blockNumber?: bigint): Promise<bigint> {
    return client.readContract({ address: hook!, abi: hookAbi, functionName: "edge", args: [BigInt(sleeveId)], blockNumber });
  }

  /**
   * Edge a sleeve earned between two blocks, with its parts: what to pay a curator on, or judge it by, for a period.
   * Exactly how UkiyoVault settles its performance fee, without waiting for an epoch.
   */
  async function edgeBetween(sleeveId: number, fromBlock: bigint, toBlock?: bigint) {
    const id = BigInt(sleeveId);
    const read = (blockNumber: bigint | undefined) =>
      client.readContract({ address: hook!, abi: hookAbi, functionName: "ledger", args: [id], blockNumber });
    const [a, b] = await Promise.all([read(fromBlock), read(toBlock)]);
    const delta = sub(b, a);
    return { ...delta, edge: delta.userFees + delta.userImpact - delta.arbLoss };
  }

  /** Hook logs between two blocks, in chunks the RPC accepts. */
  async function hookLogs(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    const out: Log[] = [];
    for (let f = fromBlock; f <= toBlock; f += maxLogRange) {
      const t = f + maxLogRange - 1n < toBlock ? f + maxLogRange - 1n : toBlock;
      out.push(...(await client.getLogs({ address: hook!, fromBlock: f, toBlock: t })));
    }
    return out;
  }

  /** Each sleeve's ledger change over one block, from state before and after it. */
  async function blockDelta(blockNumber: bigint) {
    const [before, after] = await Promise.all([scoreboard(blockNumber - 1n), scoreboard(blockNumber)]);
    return after.rows.map((r) => {
      const prev = before.rows.find((p) => p.sleeveId === r.sleeveId);
      const delta = sub(r.ledger, prev?.ledger ?? emptyLedger());
      return { sleeveId: r.sleeveId, name: r.name, delta, edgeDelta: delta.userFees + delta.userImpact - delta.arbLoss };
    });
  }

  /** What a transaction did on the pool: each swap's classification and why, its fee per sleeve, and the block's bookings. */
  async function explain(hash: Hash): Promise<Explanation> {
    const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
    const n = receipt.blockNumber;
    const [block, m] = await Promise.all([client.getBlock({ blockNumber: n }), poolMeta()]);
    const tip = receipt.effectiveGasPrice > (block.baseFeePerGas ?? 0n) ? receipt.effectiveGasPrice - (block.baseFeePerGas ?? 0n) : 0n;

    type Item =
      | { kind: "classified"; logIndex: number; isArbitrage: boolean; tip: bigint }
      | { kind: "swap"; logIndex: number; sender: Address; amount0: bigint; amount1: bigint; sqrt: bigint; fee: number }
      | { kind: "mark"; logIndex: number; sqrt: bigint }
      | { kind: "spike"; logIndex: number };
    const items: Item[] = [];
    for (const log of receipt.logs) {
      const addr = log.address.toLowerCase();
      if (addr === hook!.toLowerCase()) {
        try {
          const ev = decodeEventLog({ abi: hookAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "SwapClassified")
            items.push({ kind: "classified", logIndex: log.logIndex, isArbitrage: ev.args.isArbitrage, tip: ev.args.priorityFeePerGas });
          else if (ev.eventName === "BlockMarked") items.push({ kind: "mark", logIndex: log.logIndex, sqrt: ev.args.sqrtPostMarkX96 });
          else if (ev.eventName === "SpikeNetted") items.push({ kind: "spike", logIndex: log.logIndex });
        } catch {
          // not one of the hook's events we explain
        }
      } else if (addr === m.poolManager.toLowerCase() && log.topics[1]?.toLowerCase() === m.poolId.toLowerCase()) {
        try {
          const ev = decodeEventLog({ abi: [SWAP_EVENT], data: log.data, topics: log.topics });
          items.push({
            kind: "swap",
            logIndex: log.logIndex,
            sender: ev.args.sender,
            amount0: ev.args.amount0,
            amount1: ev.args.amount1,
            sqrt: ev.args.sqrtPriceX96,
            fee: ev.args.fee,
          });
        } catch {
          // a PoolManager event other than Swap on this pool
        }
      }
    }

    const [threshold, prevSqrt, blockSwaps, blockHookLogs, board] = await Promise.all([
      client.readContract({ address: hook!, abi: hookAbi, functionName: "priorityFeeThreshold", blockNumber: n }),
      client.readContract({ address: hook!, abi: hookAbi, functionName: "sqrtPriceX96", blockNumber: n - 1n }),
      client.getLogs({ address: m.poolManager, event: SWAP_EVENT, args: { id: m.poolId }, fromBlock: n, toBlock: n }),
      hookLogs(n, n),
      scoreboard(n - 1n),
    ]);

    const swaps: SwapBooking[] = [];
    let pending: Extract<Item, { kind: "classified" }> | undefined;
    for (const it of items) {
      if (it.kind === "classified") pending = it;
      else if (it.kind === "swap" && pending) {
        const earlier = blockSwaps.filter((l) => l.logIndex < it.logIndex).sort((a, b) => b.logIndex - a.logIndex)[0];
        const sqrtBefore = earlier ? earlier.args.sqrtPriceX96! : prevSqrt;
        // arbitrage without a qualifying tip can only be a sleeve manager's own swap (the hook's other rule)
        const isManager = pending.isArbitrage && pending.tip < threshold;
        // the Swap event's fee is the total; with no protocol fee it equals the LP fee
        const [num, den] = it.fee === m.lpFee ? lpFeeRate(m.lpFee, 0) : [0n, 1n];
        swaps.push({
          sender: it.sender,
          isArbitrage: pending.isArbitrage,
          reason: pending.isArbitrage ? (isManager ? "sleeve-manager" : "tip") : "user",
          tip: pending.tip,
          threshold,
          firstInBlock: false,
          amount0: it.amount0,
          amount1: it.amount1,
          sqrtBefore,
          sqrtAfter: it.sqrt,
          priceBefore: sqrtToPrice(sqrtBefore, m.token0.decimals, m.token1.decimals),
          priceAfter: sqrtToPrice(it.sqrt, m.token0.decimals, m.token1.decimals),
          spikeNetted: false,
          sleeveFees: board.rows.map((r) => ({
            sleeveId: r.sleeveId,
            fee:
              r.liquidity === 0n || num === 0n
                ? 0n
                : swapFee(r.liquidity, sqrtBefore, it.sqrt, getSqrtPriceAtTick(r.tickLower), getSqrtPriceAtTick(r.tickUpper), num, den),
          })),
        });
        pending = undefined;
      } else if (it.kind === "mark" && swaps.length) {
        swaps[swaps.length - 1].firstInBlock = true;
        swaps[swaps.length - 1].mark = it.sqrt;
      } else if (it.kind === "spike" && swaps.length) swaps[swaps.length - 1].spikeNetted = true;
    }

    const swapsInBlock = blockHookLogs.filter((l) => {
      try {
        return decodeEventLog({ abi: hookAbi, data: l.data, topics: l.topics }).eventName === "SwapClassified";
      } catch {
        return false;
      }
    }).length;
    const deltas = swaps.length ? await blockDelta(n) : [];
    const ex: Explanation = {
      hash,
      blockNumber: n,
      from: tx.from,
      swaps,
      swapsInBlock,
      block: deltas,
      token0: m.token0,
      token1: m.token1,
      narrative: [],
    };
    ex.narrative = narrateExplanation(ex, tip);
    return ex;
  }

  /**
   * A live feed of blocks with hook activity: classifications, marks, spikes and (with `withEdge`) each sleeve's Edge
   * change. Polls with eth_getLogs, so it works on RPCs without filters or websockets. Returns a function that stops it.
   */
  function watch(o: {
    onBlock: (b: BlockActivity) => void;
    onError?: (e: unknown) => void;
    fromBlock?: bigint;
    pollMs?: number;
    withEdge?: boolean;
  }): () => void {
    let stopped = false;
    let next = o.fromBlock;
    const tick = async () => {
      try {
        // one block behind the head: public RPCs are load-balanced, and a node a block behind rejects ranges past its tip
        const latest = (await client.getBlockNumber()) - 1n;
        if (next === undefined) next = latest + 1n;
        if (latest >= next) {
          const logs = await hookLogs(next, latest);
          const byBlock = new Map<bigint, BlockActivity>();
          for (const l of logs) {
            let ev;
            try {
              ev = decodeEventLog({ abi: hookAbi, data: l.data, topics: l.topics });
            } catch {
              continue;
            }
            const b = l.blockNumber!;
            const a = byBlock.get(b) ?? { blockNumber: b, swaps: [], spikeNetted: false };
            byBlock.set(b, a);
            if (ev.eventName === "SwapClassified") a.swaps.push({ isArbitrage: ev.args.isArbitrage, tip: ev.args.priorityFeePerGas });
            else if (ev.eventName === "BlockMarked") a.mark = ev.args.sqrtPostMarkX96;
            else if (ev.eventName === "SpikeNetted") a.spikeNetted = true;
          }
          const { token0, token1 } = await poolMeta();
          for (const a of [...byBlock.values()].sort((x, y) => Number(x.blockNumber - y.blockNumber))) {
            if (!a.swaps.length) continue;
            if (a.mark) a.price = sqrtToPrice(a.mark, token0.decimals, token1.decimals);
            if (o.withEdge) a.edgeDelta = (await blockDelta(a.blockNumber)).map((d) => ({ sleeveId: d.sleeveId, name: d.name, delta: d.edgeDelta }));
            if (stopped) return;
            o.onBlock(a);
          }
          next = latest + 1n;
        }
      } catch (e) {
        o.onError?.(e);
      }
      if (!stopped) setTimeout(tick, o.pollMs ?? 2000);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }

  return { hook, lens, deployment: dep?.hook === hook ? dep : undefined, poolMeta, scoreboard, edgeAt, edgeBetween, explain, watch };
}

export type Ukiyo = ReturnType<typeof createUkiyo<Chain | undefined>>;

/** Raw token amount → number, for display. */
export function toNumber(raw: bigint, decimals = 18): number {
  const neg = raw < 0n;
  const a = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const v = Number(a / base) + Number(a % base) / Number(base);
  return neg ? -v : v;
}

/** The explanation in plain sentences. Deterministic: it never says more than the numbers do. */
export function narrateExplanation(ex: Explanation, tip?: bigint): string[] {
  const out: string[] = [];
  const t1 = ex.token1;
  const money = (raw: bigint) => `${toNumber(raw, t1.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${t1.symbol}`;
  const gwei = (wei: bigint) => `${(Number(wei) / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 3 })} gwei`;
  const px = (p: number) => p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!ex.swaps.length) {
    out.push(`No swap through this hook's pool in this transaction${tip !== undefined ? ` (tip ${gwei(tip)})` : ""}.`);
    return out;
  }
  ex.swaps.forEach((s, i) => {
    const lead = ex.swaps.length > 1 ? `Swap ${i + 1}: ` : "";
    const why =
      s.reason === "tip"
        ? `its tip of ${gwei(s.tip)} is at or above the ${gwei(s.threshold)} threshold, so it is booked as arbitrage`
        : s.reason === "sleeve-manager"
          ? `it was sent by a curator vault trading for itself, so it is booked as arbitrage whatever its tip`
          : `its tip of ${gwei(s.tip)} is below the ${gwei(s.threshold)} threshold, so it is booked as user flow`;
    out.push(`${lead}moved the price from ${px(s.priceBefore)} to ${px(s.priceAfter)} ${t1.symbol} per ${ex.token0.symbol}; ${why}.`);
    const total = s.sleeveFees.reduce((a, f) => a + f.fee, 0n);
    if (total > 0n)
      out.push(
        s.isArbitrage
          ? `It paid the sleeves ${money(total)} in fees, which Ukiyo reports but never counts as Edge: arbitrage fees are already netted out of the loss.`
          : `It paid the sleeves ${money(total)} in fees, which count toward their Edge.`,
      );
    if (s.firstInBlock)
      out.push(
        `It was the block's first swap: the hook credited the previous block's user impact, marked the price after it (${px(sqrtToPrice(s.mark!, ex.token0.decimals, t1.decimals))}) and charged each sleeve the arbitrage loss since the last mark${s.spikeNetted ? ", netting a spike so it was charged once" : ""}.`,
      );
  });
  const moved = ex.block.filter((d) => d.edgeDelta !== 0n);
  if (moved.length) {
    const others = ex.swapsInBlock - ex.swaps.length;
    out.push(
      `Over block ${ex.blockNumber}${others > 0 ? ` (with ${others} other swap${others > 1 ? "s" : ""})` : ""}, Edge changed by ` +
        moved.map((d) => `${d.name} ${d.edgeDelta > 0n ? "+" : ""}${money(d.edgeDelta)}`).join(", ") +
        ".",
    );
  }
  return out;
}
