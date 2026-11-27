import { baseSepolia, foundry, unichainSepolia } from "viem/chains";
import type { Chain } from "viem";
import { formatEther, type Address } from "viem";
import { DEPLOYMENTS } from "@/deployments";
import { quoteToTick, sqrtToPrice, tickToQuote } from "./math";

/** A deployment written by script/DeployUkiyo.s.sol. */
export interface Deployment {
  chainId: number;
  deployBlock: number;
  poolManager: Address;
  hook: Address;
  router: Address;
  token0: Address;
  token1: Address;
  btc: Address;
  usd: Address;
  fee: number;
  tickSpacing: number;
  threshold: string;
  epochLength: number;
  startPrice: number;
  curator: Address;
  /** UkiyoFactory, through which anyone can launch a further vault (absent on older deployments). */
  factory?: Address;
  /** UkiyoSkillRouter: one deposit split across curators by their skill tests (absent on older deployments). */
  skillRouter?: Address;
  /** UkiyoLens: the whole scoreboard in one view call (absent on older deployments). */
  lens?: Address;
  vaults: { address: Address; sleeveId: number; name: string; symbol: string; style: string }[];
}

const all = DEPLOYMENTS as unknown as Record<number, Deployment>;
const wanted = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0);

/** Chains the demo can run on: any with a canonical v4 PoolManager and priority-fee ordering. */
const CHAINS: Record<number, Chain> = {
  [unichainSepolia.id]: unichainSepolia,
  [baseSepolia.id]: baseSepolia,
  [foundry.id]: foundry,
};

/**
 * The deployment the app talks to: NEXT_PUBLIC_CHAIN_ID if set, else Unichain Sepolia, else Base Sepolia, else anvil,
 * whichever has been deployed.
 */
export const DEP: Deployment | undefined =
  all[wanted] ?? all[unichainSepolia.id] ?? all[baseSepolia.id] ?? all[foundry.id];
export const CHAIN: Chain = CHAINS[DEP?.chainId ?? foundry.id] ?? foundry;
/** Human name of the chain, for the header. */
export const CHAIN_LABEL = CHAIN.id === foundry.id ? "Local anvil" : CHAIN.name;
export const RPC = process.env.NEXT_PUBLIC_RPC_URL || CHAIN.rpcUrls.default.http[0];
export const EXPLORER =
  CHAIN.id === unichainSepolia.id ? "https://sepolia.uniscan.xyz" : CHAIN.blockExplorers?.default.url;

/** Every contract of the live deployment has verified source on the explorer (Uniscan, and Sourcify). */
export const SOURCE_VERIFIED = CHAIN.id === unichainSepolia.id;

export const BTC_IS_0 = !!DEP && DEP.btc.toLowerCase() === DEP.token0.toLowerCase();

/** Pool key of the hook-exclusive pool. */
export const POOL_KEY = DEP && {
  currency0: DEP.token0,
  currency1: DEP.token1,
  fee: DEP.fee,
  tickSpacing: DEP.tickSpacing,
  hooks: DEP.hook,
};

export const MIN_SQRT = 4295128740n;
export const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

/** tUSD per tBTC from the pool's sqrt price. */
export function priceOf(sqrtPriceX96: bigint): number {
  return sqrtToPrice(sqrtPriceX96, BTC_IS_0);
}

/** Tick of a tUSD-per-tBTC price, in the pool's orientation. */
export function priceToTick(usdPerBtc: number): number {
  return quoteToTick(usdPerBtc, BTC_IS_0);
}

/** tUSD per tBTC at a tick. */
export function tickToPrice(tick: number): number {
  return tickToQuote(tick, BTC_IS_0);
}

/** Split a (token0, token1) pair into (btc, usd). */
export const split = (a0: bigint, a1: bigint): [bigint, bigint] => (BTC_IS_0 ? [a0, a1] : [a1, a0]);
/** Join (btc, usd) into (token0, token1). */
export const join = (btc: bigint, usd: bigint): [bigint, bigint] => (BTC_IS_0 ? [btc, usd] : [usd, btc]);

/** 18-decimal amount to a JS number. */
export const num = (v: bigint) => Number(formatEther(v));

/**
 * Dollars. Below $100 the cents are kept, so a young scoreboard reads "$3.42" rather than "$0"; below a cent it reads
 * "<$0.01"; and an amount that rounds to zero never carries a minus sign.
 */
export function usd(v: number, digits = 0): string {
  const a = Math.abs(v);
  if (a === 0 || !Number.isFinite(a)) return "$0";
  const d = digits === 0 && a < 100 ? 2 : digits;
  const step = 10 ** -d;
  const sign = v < 0 ? "−" : "";
  if (a < step / 2) return sign + "<$" + step.toFixed(d);
  return sign + "$" + a.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function compactUsd(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return (v < 0 ? "−$" : "$") + s;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A wei amount in gwei with three significant digits, so testnet-sized tips (thousandths of a gwei) never print 0.00. */
export const gwei = (wei: bigint) => `${(Number(wei) / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 3 })} gwei`;
