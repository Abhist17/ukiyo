"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { CHAIN } from "@/lib/chain";

// The wallet modal in Ukiyo's colours: navy actions on light, vermilion on dark.
const theme = {
  lightMode: lightTheme({ accentColor: "#11162B", borderRadius: "medium", fontStack: "system" }),
  darkMode: darkTheme({ accentColor: "#E8452C", borderRadius: "medium", fontStack: "system" }),
};

/** Wallet, wallet-modal and query context for the app. */
export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1 } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <RainbowKitProvider theme={theme} initialChain={CHAIN} appInfo={{ appName: "Ukiyo" }} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
