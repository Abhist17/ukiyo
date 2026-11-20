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
  ssr: true,
});
