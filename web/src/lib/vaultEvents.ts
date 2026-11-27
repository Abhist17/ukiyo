// The vault events the app reads, shared by the browser sync (logs.ts) and the deploy-time snapshot
// (scripts/history.mts). Free of app imports so a Node script can load it directly.
import { parseAbi } from "viem";

export const VAULT_EVENTS = parseAbi([
  "event EpochSettled(uint256 indexed epoch, int256 edgeDelta, uint256 sharesMinted, uint256 sharesBurned, uint128 liquidityAfter)",
  "event PerformanceFee(uint256 indexed epoch, uint256 shares, uint256 value)",
  "event BondPenalty(uint256 indexed epoch, uint256 overshoot, uint256 penalty)",
  "event RedeemRequested(uint256 indexed epoch, address indexed user, uint256 shares)",
  "event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity)",
]);

/** Where the deploy-time snapshot of vault events is served from, per chain. */
export const historyPath = (chainId: number) => `/history-${chainId}.json`;

/** JSON with bigints, as {"$b": "…"}, both ways. */
export const encodeBig = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $b: x.toString() } : x));
export const decodeBig = <T>(s: string): T =>
  JSON.parse(s, (_, x) => (x && typeof x === "object" && "$b" in x ? BigInt(x.$b) : x)) as T;
