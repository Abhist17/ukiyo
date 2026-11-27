"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { useState } from "react";
import { CHAIN, RPC } from "@/lib/chain";

/**
 * Chain reads only, with no wallet connectors: for pages that show live numbers but never sign. Keeps RainbowKit and
 * WalletConnect (and their network calls) out of those pages, which loads them noticeably faster on a phone.
 */
const readConfig = createConfig({
  chains: [CHAIN],
  connectors: [],
  multiInjectedProviderDiscovery: false,
  transports: { [CHAIN.id]: http(RPC, { batch: true }) },
  batch: CHAIN.contracts?.multicall3 ? { multicall: { wait: 16 } } : undefined,
  ssr: true,
});

/** Query and read-only chain context. */
export function ReadProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1 } } }));
  return (
    <WagmiProvider config={readConfig}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
