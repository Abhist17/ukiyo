// Writes public/history-<chainId>.json: every vault event since deployment, so the site ships its history and a visit
// only reads the blocks since the last deploy. Run by `npm run deploy:vercel` before the build; harmless to skip.
//   node --experimental-strip-types scripts/history.mts            (RPC_URL to override the chain's public RPC)
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { unichainSepolia } from "viem/chains";
import { VAULT_EVENTS, encodeBig } from "../src/lib/vaultEvents.ts";

const DIR = new URL("../src/deployments/", import.meta.url);
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || unichainSepolia.id);
const file = readdirSync(DIR).find((f) => f === `${chainId}.json`);
if (!file) {
  console.log(`history: no deployment for chain ${chainId}, skipped`);
  process.exit(0);
}
const dep = JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as {
  hook: Address;
  deployBlock: number;
  factory?: Address;
  vaults: { address: Address }[];
};
const rpc = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || unichainSepolia.rpcUrls.default.http[0];
const pc = createPublicClient({ chain: unichainSepolia, transport: http(rpc, { retryCount: 5 }) });

const factoryAbi = parseAbi(["function vaults(uint256) view returns (address)"]);
const launched = dep.factory
  ? await Promise.all(
      Array.from({ length: 8 }, (_, k) =>
        pc.readContract({ address: dep.factory!, abi: factoryAbi, functionName: "vaults", args: [BigInt(k)] }).catch(() => null),
      ),
    )
  : [];
const vaults = [...dep.vaults.map((v) => v.address), ...launched.filter((a): a is Address => !!a)];

// a margin below the head, as the site's own sync leaves the newest blocks to the RPC
const to = (await pc.getBlockNumber()) - 200n;
const logs: { vault: Address; block: bigint; name: string; args: unknown }[] = [];
const SPAN = 1000n; // the public RPC's cap per eth_getLogs
const ranges: [bigint, bigint][] = [];
for (let f = BigInt(dep.deployBlock); f <= to; f += SPAN) ranges.push([f, f + SPAN - 1n > to ? to : f + SPAN - 1n]);
for (let i = 0; i < ranges.length; i += 8) {
  const got = await Promise.all(
    ranges.slice(i, i + 8).map(([fromBlock, toBlock]) => pc.getLogs({ address: vaults, events: VAULT_EVENTS, fromBlock, toBlock })),
  );
  for (const l of got.flat()) logs.push({ vault: l.address, block: l.blockNumber, name: l.eventName, args: l.args });
  process.stdout.write(`\rhistory: ${Math.min(i + 8, ranges.length)}/${ranges.length} chunks`);
}
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../public/history-${chainId}.json`, import.meta.url), encodeBig({ hook: dep.hook, to, logs }));
console.log(`\nhistory: ${logs.length} vault events up to block ${to} → public/history-${chainId}.json`);
