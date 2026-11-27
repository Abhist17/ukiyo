"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeEventLog, type Address, type Hex } from "viem";
import { VAULT_EVENTS, decodeBig, historyPath } from "./vaultEvents";
import { factoryAbi } from "./abi";
import { CHAIN, DEP } from "./chain";

/** Most blocks one eth_getLogs may span on the public Unichain Sepolia RPC (it rejects wider ranges). */
const MAX_SPAN = 1000n;
/** Parallel chunk requests while catching up. */
const PARALLEL = 4;
/**
 * Blockscout's log API has no block-range cap, so the history since deployment comes back in a few requests instead
 * of one per 1,000 blocks (which grows by ~86 a day on a 1 s chain). The RPC then covers only the newest blocks.
 */
const INDEXER: Record<number, string> = { 1301: "https://unichain-sepolia.blockscout.com/api" };
/** Blocks below the head left to the RPC, in case the indexer lags it. */
const INDEXER_MARGIN = 200n;
/** A gap the RPC reads quickly by itself (a few requests); the indexer is asked only for more. */
const RPC_ONLY_GAP = 5_000n;


/** One vault event, flattened to what the app reads. */
export interface VaultLog {
  vault: Address;
  block: bigint;
  name: "EpochSettled" | "PerformanceFee" | "BondPenalty" | "RedeemRequested" | "Rebalanced";
  args: Record<string, unknown>;
}

// Everything fetched so far lives here for the page's lifetime; each poll only asks for blocks after `to`.
const cache: { to: bigint; logs: VaultLog[] } = { to: BigInt(DEP?.deployBlock ?? 0) - 1n, logs: [] };
let syncing: Promise<void> | undefined;

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

// Launched vaults, re-read at most once a minute: a launch is rare, and the public RPC rate-limits each visitor's IP.
let launchedAt = 0;
let launchedCache: Address[] = [];
const LAUNCHED_TTL_MS = 60_000;

/** The demo's vaults plus every vault launched through the factory so far (at most 8 sleeves, so 8 speculative reads). */
async function vaultAddresses(pc: Client): Promise<Address[]> {
  if (Date.now() - launchedAt < LAUNCHED_TTL_MS) return [...DEP!.vaults.map((v) => v.address), ...launchedCache];
  const launched = DEP!.factory
    ? await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          pc.readContract({ address: DEP!.factory!, abi: factoryAbi, functionName: "vaults", args: [BigInt(k)] }).catch(() => null),
        ),
      )
    : [];
  launchedCache = launched.filter((a): a is Address => !!a);
  launchedAt = Date.now();
  return [...DEP!.vaults.map((v) => v.address), ...launchedCache];
}

/** Every vault event of one address up to `to`, from the indexer, a page of up to 1,000 at a time. */
async function fromIndexer(api: string, address: Address, from: bigint, to: bigint): Promise<VaultLog[]> {
  const out: VaultLog[] = [];
  for (let f = from; f <= to; ) {
    const url = `${api}?module=logs&action=getLogs&address=${address}&fromBlock=${f}&toBlock=${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as { status: string; message: string; result: { blockNumber: Hex; data: Hex; topics: (Hex | null)[] }[] };
    if (body.status !== "1") {
      if (/no logs/i.test(body.message)) break;
      throw new Error(`indexer: ${body.message}`);
    }
    let last = f;
    for (const l of body.result) {
      const block = BigInt(l.blockNumber);
      if (block > last) last = block;
      try {
        const topics = l.topics.filter((t): t is Hex => !!t) as [Hex, ...Hex[]];
        const ev = decodeEventLog({ abi: VAULT_EVENTS, data: l.data, topics });
        out.push({ vault: address, block, name: ev.eventName as VaultLog["name"], args: ev.args as Record<string, unknown> });
      } catch {
        // a share transfer or another event the app does not read
      }
    }
    if (body.result.length < 1000) break;
    if (last === f) {
      f = last + 1n; // a whole page in one block: nothing more to split, move on
      continue;
    }
    // a full page: carry on from its last block, dropping that block's logs first so none are read twice
    const keep = out.filter((l) => l.block < last);
    out.length = 0;
    out.push(...keep);
    f = last;
  }
  return out;
}

/**
 * The vault events up to the last deploy, shipped with the site (scripts/history.mts writes it), so a visit only reads
 * the blocks since. Absent in a local build: then everything comes from the indexer or the RPC.
 */
async function seedFromSnapshot() {
  try {
    const res = await fetch(historyPath(CHAIN.id));
    if (!res.ok) return;
    const snap = decodeBig<{ hook: string; to: bigint; logs: VaultLog[] }>(await res.text());
    // a snapshot of another deployment (an older hook) would describe other vaults
    if (snap.hook.toLowerCase() !== DEP!.hook.toLowerCase() || snap.to <= cache.to) return;
    cache.logs = snap.logs;
    cache.to = snap.to;
  } catch {
    // no snapshot: read it all
  }
}

let seeded = false;

async function sync(pc: Client) {
  if (!seeded) {
    seeded = true;
    await seedFromSnapshot();
  }
  // found before the block range is fixed, so a vault launched in that range is already in the filter
  const [vaults, head] = await Promise.all([vaultAddresses(pc), pc.getBlockNumber()]);
  // a block behind the head: the public RPC is load-balanced, and a node a block behind could answer short
  const latest = head - 1n;
  const api = INDEXER[CHAIN.id];
  if (api && cache.to < latest - RPC_ONLY_GAP) {
    const upTo = latest - INDEXER_MARGIN;
    try {
      // one vault at a time: the public indexer rate-limits bursts, and a refusal falls back to the RPC below
      const got: VaultLog[] = [];
      for (const v of vaults) got.push(...(await fromIndexer(api, v, cache.to + 1n, upTo)));
      cache.logs = cache.logs.concat(got.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0)));
      cache.to = upTo;
    } catch {
      // the indexer is down or refused: the RPC reads the same events, only in more requests
    }
  }
  const ranges: [bigint, bigint][] = [];
  for (let f = cache.to + 1n; f <= latest; f += MAX_SPAN) ranges.push([f, f + MAX_SPAN - 1n > latest ? latest : f + MAX_SPAN - 1n]);
  const out: VaultLog[][] = new Array(ranges.length);
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    await Promise.all(
      ranges.slice(i, i + PARALLEL).map(async ([from, to], k) => {
        const logs = await pc.getLogs({ address: vaults, events: VAULT_EVENTS, fromBlock: from, toBlock: to });
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
 * Every vault event since deployment: backfilled from the indexer where there is one (else in chunks the RPC
 * accepts), then topped up from the RPC with only the new blocks.
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
