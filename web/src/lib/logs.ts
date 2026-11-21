"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbi, type Address } from "viem";
import { CHAIN, DEP } from "./chain";

/** Most blocks one eth_getLogs may span on the public Unichain Sepolia RPC (it rejects wider ranges). */
const MAX_SPAN = 1000n;
/** Parallel chunk requests while catching up. */
const PARALLEL = 4;

const VAULT_EVENTS = parseAbi([
  "event EpochSettled(uint256 indexed epoch, int256 edgeDelta, uint256 sharesMinted, uint256 sharesBurned, uint128 liquidityAfter)",
  "event PerformanceFee(uint256 indexed epoch, uint256 shares, uint256 value)",
  "event BondPenalty(uint256 indexed epoch, uint256 overshoot, uint256 penalty)",
  "event RedeemRequested(uint256 indexed epoch, address indexed user, uint256 shares)",
  "event SwapClassified(uint256 indexed blockNumber, bool isArbitrage, uint256 priorityFeePerGas)",
]);

/** One vault event, flattened to what the app reads. */
export interface VaultLog {
  vault: Address;
  block: bigint;
  name: "EpochSettled" | "PerformanceFee" | "BondPenalty" | "RedeemRequested" | "SwapClassified";
  args: Record<string, unknown>;
}

// Everything fetched so far lives here for the page's lifetime; each poll only asks for blocks after `to`.
const cache: { to: bigint; logs: VaultLog[] } = { to: BigInt(DEP?.deployBlock ?? 0) - 1n, logs: [] };
let syncing: Promise<void> | undefined;

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

async function sync(pc: Client) {
  const latest = await pc.getBlockNumber();
  const ranges: [bigint, bigint][] = [];
  for (let f = cache.to + 1n; f <= latest; f += MAX_SPAN) ranges.push([f, f + MAX_SPAN - 1n > latest ? latest : f + MAX_SPAN - 1n]);
  const out: VaultLog[][] = new Array(ranges.length);
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    await Promise.all(
      ranges.slice(i, i + PARALLEL).map(async ([from, to], k) => {
        const logs = await pc.getLogs({
          address: [DEP!.hook, ...DEP!.vaults.map((v) => v.address)],
          events: VAULT_EVENTS,
          fromBlock: from,
          toBlock: to,
        });
        out[i + k] = logs.map((l) => ({
          vault: l.address,
          block: l.blockNumber,
          name: l.eventName as VaultLog["name"],
          args: l.args as Record<string, unknown>,
        }));
      }),
    );
  }
  cache.logs = cache.logs.concat(out.flat());
  cache.to = latest;
}

/**
 * Every vault event, and the hook's swap classifications, since deployment, fetched once in chunks the RPC accepts and then topped up incrementally.
 * Feeds Edge history, curator accountability and redemption claims.
 */
export function useVaultLogs() {
  const pc = usePublicClient({ chainId: CHAIN.id });
  return useQuery({
    queryKey: ["vault-logs", CHAIN.id],
    enabled: !!pc && !!DEP,
    refetchInterval: 8000,
    queryFn: async () => {
      syncing ??= sync(pc!).finally(() => (syncing = undefined));
      await syncing;
      return { logs: cache.logs, to: cache.to };
    },
  });
}
