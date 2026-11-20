"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { encodeAbiParameters, keccak256, parseAbiItem, type Address } from "viem";
import { hookAbi, vaultAbi } from "./abi";
import { CHAIN, DEP, POOL_KEY, num, priceOf, split } from "./chain";

/** Live state of one curator vault and its sleeve, money in tUSD. */
export interface VaultLive {
  i: number;
  address: Address;
  name: string;
  symbol: string;
  style: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  userFees: number;
  userImpact: number;
  arbLoss: number;
  arbFees: number;
  edge: number;
  btc: number;
  usd: number;
  tvl: number;
  supply: bigint;
  epoch: number;
  epochEndsAt: number;
  epochEdge: number;
}

export interface Live {
  block: bigint;
  time: number;
  price: number;
  threshold: bigint;
  vaults: VaultLive[];
  tvl: number;
  edge: number;
}

/** One swap in the pool, joined with how the hook classified it. */
export interface TapeRow {
  tx: `0x${string}`;
  block: bigint;
  arb: boolean;
  tip: bigint;
  buyBtc: boolean;
  btc: number;
  usd: number;
  price: number;
}

export const POLL_MS = 3000;
const POOL_ID = POOL_KEY
  ? keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
        [POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee, POOL_KEY.tickSpacing, POOL_KEY.hooks],
      ),
    )
  : undefined;

const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const CLASSIFIED_EVENT = parseAbiItem("event SwapClassified(uint256 indexed blockNumber, bool isArbitrage, uint256 priorityFeePerGas)");
const SETTLED_EVENT = parseAbiItem(
  "event EpochSettled(uint256 indexed epoch, int256 edgeDelta, uint256 sharesMinted, uint256 sharesBurned, uint128 liquidityAfter)",
);

/** Hook, pool and vault state, refreshed every few seconds. */
export function useLive() {
  const pc = usePublicClient({ chainId: CHAIN.id });
  return useQuery({
    queryKey: ["live", CHAIN.id],
    enabled: !!pc && !!DEP,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<Live> => {
      const d = DEP!;
      const hook = d.hook;
      const [block, sqrtP, threshold] = await Promise.all([
        pc!.getBlock(),
        pc!.readContract({ address: hook, abi: hookAbi, functionName: "sqrtPriceX96" }),
        pc!.readContract({ address: hook, abi: hookAbi, functionName: "priorityFeeThreshold" }),
      ]);
      const price = priceOf(sqrtP);
      const vaults = await Promise.all(
        d.vaults.map(async (v, i): Promise<VaultLive> => {
          const id = BigInt(v.sleeveId);
          const [s, l, e, h, supply, epoch, ends, startEdge] = await Promise.all([
            pc!.readContract({ address: hook, abi: hookAbi, functionName: "sleeve", args: [id] }),
            pc!.readContract({ address: hook, abi: hookAbi, functionName: "ledger", args: [id] }),
            pc!.readContract({ address: hook, abi: hookAbi, functionName: "edge", args: [id] }),
            pc!.readContract({ address: v.address, abi: vaultAbi, functionName: "holdings" }),
            pc!.readContract({ address: v.address, abi: vaultAbi, functionName: "totalSupply" }),
            pc!.readContract({ address: v.address, abi: vaultAbi, functionName: "epoch" }),
            pc!.readContract({ address: v.address, abi: vaultAbi, functionName: "epochEndsAt" }),
            pc!.readContract({ address: v.address, abi: vaultAbi, functionName: "epochStartEdge" }),
          ]);
          const [btc, usdAmt] = split(h[0], h[1]);
          const edge = num(e);
          return {
            i,
            address: v.address,
            name: v.name.replace(/^Ukiyo /, ""),
            symbol: v.symbol,
            style: v.style.split(": ")[1] ?? v.style,
            tickLower: s.tickLower,
            tickUpper: s.tickUpper,
            liquidity: s.liquidity,
            userFees: num(l.userFees),
            userImpact: num(l.userImpact),
            arbLoss: num(l.arbLoss),
            arbFees: num(l.arbFees),
            edge,
            btc: num(btc),
            usd: num(usdAmt),
            tvl: num(btc) * price + num(usdAmt),
            supply,
            epoch: Number(epoch),
            epochEndsAt: Number(ends),
            epochEdge: edge - num(startEdge),
          };
        }),
      );
      return {
        block: block.number,
        time: Number(block.timestamp),
        price,
        threshold,
        vaults,
        tvl: vaults.reduce((a, v) => a + v.tvl, 0),
        edge: vaults.reduce((a, v) => a + v.edge, 0),
      };
    },
  });
}

/** The latest swaps in the pool, each tagged arbitrage or user as the hook classified it. */
export function useTape(lookback = 400n) {
  const pc = usePublicClient({ chainId: CHAIN.id });
  return useQuery({
    queryKey: ["tape", CHAIN.id],
    enabled: !!pc && !!DEP && !!POOL_ID,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<TapeRow[]> => {
      const latest = await pc!.getBlockNumber();
      const fromBlock = latest > lookback ? latest - lookback : 0n;
      const [swaps, classes] = await Promise.all([
        pc!.getLogs({ address: DEP!.poolManager, event: SWAP_EVENT, args: { id: POOL_ID }, fromBlock, toBlock: latest }),
        pc!.getLogs({ address: DEP!.hook, event: CLASSIFIED_EVENT, fromBlock, toBlock: latest }),
      ]);
      const byTx = new Map(classes.map((c) => [c.transactionHash, c.args]));
      return swaps
        .map((s) => {
          const c = byTx.get(s.transactionHash);
          const [b, u] = split(s.args.amount0!, s.args.amount1!);
          // v4 reports the swapper's balance delta: positive = received by the swapper
          return {
            tx: s.transactionHash,
            block: s.blockNumber,
            arb: c?.isArbitrage ?? true,
            tip: c?.priorityFeePerGas ?? 0n,
            buyBtc: b > 0n,
            btc: Math.abs(num(b)),
            usd: Math.abs(num(u)),
            price: priceOf(s.args.sqrtPriceX96!),
          };
        })
        .reverse();
    },
  });
}

/** Cumulative Edge per vault at every settled epoch, from EpochSettled logs. */
export function useEdgeHistory() {
  const pc = usePublicClient({ chainId: CHAIN.id });
  return useQuery({
    queryKey: ["edge-history", CHAIN.id],
    enabled: !!pc && !!DEP,
    refetchInterval: POLL_MS * 4,
    queryFn: async () => {
      const d = DEP!;
      const logs = await Promise.all(
        d.vaults.map((v) =>
          pc!.getLogs({ address: v.address, event: SETTLED_EVENT, fromBlock: BigInt(d.deployBlock), toBlock: "latest" }),
        ),
      );
      return logs.map((ls) => {
        let run = 0;
        return [{ block: BigInt(d.deployBlock), edge: 0 }].concat(
          ls.map((l) => ({ block: l.blockNumber, edge: (run += num(l.args.edgeDelta!)) })),
        );
      });
    },
  });
}
