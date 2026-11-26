import { createConfig, http } from "wagmi";
import type { Chain } from "viem";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { CHAIN, RPC } from "./chain";

/** One chain, the one Ukiyo is deployed on. */
const chain: Chain = CHAIN;

/**
 * WalletConnect project id (free, from cloud.reown.com). It is public by design: it ships in the page. With it, the
 * wallet modal offers QR codes and mobile wallets; without it, only wallets that need no relay (browser extensions,
 * Coinbase) are listed, so the app still connects.
 */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

const connectors = connectorsForWallets(
  WALLETCONNECT_PROJECT_ID
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, coinbaseWallet] },
        { groupName: "More", wallets: [walletConnectWallet, injectedWallet] },
      ]
    : [{ groupName: "Browser wallets", wallets: [injectedWallet, rabbyWallet, coinbaseWallet] }],
  { appName: "Ukiyo", projectId: WALLETCONNECT_PROJECT_ID || "ukiyo-no-walletconnect" },
);

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  transports: { [CHAIN.id]: http(RPC, { batch: true }) },
  // One refresh reads ~80 values; Multicall3 turns them into a few eth_calls instead of one request each, which the
  // public RPC answers far faster. Only where the chain has it (a bare anvil does not).
  batch: CHAIN.contracts?.multicall3 ? { multicall: { wait: 16 } } : undefined,
  ssr: true,
});
