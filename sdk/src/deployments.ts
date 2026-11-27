import type { Address, Chain } from "viem";
import { unichainSepolia } from "viem/chains";
import { DEPLOYMENTS_JSON } from "./deployments.generated.ts";

/** A Ukiyo deployment, as script/DeployUkiyo.s.sol writes it. */
export interface Deployment {
  chainId: number;
  deployBlock: number;
  poolManager: Address;
  hook: Address;
  lens?: Address;
  factory?: Address;
  skillRouter?: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  threshold: string;
  vaults: readonly { address: Address; sleeveId: number; name: string; symbol: string; style: string }[];
}

/** Every public Ukiyo deployment, by chain id. */
export const DEPLOYMENTS: Record<number, Deployment> = DEPLOYMENTS_JSON as unknown as Record<number, Deployment>;

/** Chains with a public deployment, by id. */
export const CHAINS: Record<number, Chain> = { [unichainSepolia.id]: unichainSepolia };

/** The default chain: where the live demo runs. */
export const DEFAULT_CHAIN_ID = unichainSepolia.id;
