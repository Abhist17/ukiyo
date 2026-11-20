"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN, short, CHAIN_LABEL } from "@/lib/chain";

/** Connect an injected wallet, switch it to Ukiyo's chain, or show the connected address. */
export function ConnectButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <button className="btn sm" disabled={isPending || !injected} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  if (chainId !== CHAIN.id) {
    return (
      <button className="btn sm warn" onClick={() => switchChain({ chainId: CHAIN.id })}>
        Switch to {CHAIN_LABEL}
      </button>
    );
  }
  return (
    <button className="btn sm ghost" onClick={() => disconnect()} title="Disconnect">
      <span className="dot live" /> {short(address!)}
    </button>
  );
}
