import { createConfig, http } from "wagmi";
import type { Chain } from "viem";
import { injected } from "wagmi/connectors";
import { CHAIN, RPC } from "./chain";

/** One chain, the one Ukiyo is deployed on; any injected wallet (MetaMask, Rabby, Coinbase extension). */
const chain: Chain = CHAIN;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [CHAIN.id]: http(RPC, { batch: true }) },
  // One refresh reads ~80 values; Multicall3 turns them into a few eth_calls instead of one request each, which the
  // public RPC answers far faster. Only where the chain has it (a bare anvil does not).
  batch: CHAIN.contracts?.multicall3 ? { multicall: { wait: 16 } } : undefined,
  ssr: true,
});
