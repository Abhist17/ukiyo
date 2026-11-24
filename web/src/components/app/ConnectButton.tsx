"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import type { Connector } from "wagmi";
import { CHAIN, CHAIN_LABEL, EXPLORER, short } from "@/lib/chain";

/** A wallet error in plain words: what happened and what to do. */
function explain(e: unknown): string {
  const err = e as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const code = err.code ?? err.cause?.code;
  const name = err.name ?? "";
  if (code === 4001 || name === "UserRejectedRequestError") return "The request was rejected in your wallet.";
  if (code === -32002 || name === "ResourceUnavailableRpcError")
    return "Your wallet already has a request waiting. Open the extension and approve or close it.";
  if (name === "ProviderNotFoundError") return "That wallet is not available in this browser.";
  if (code === 4902 || name === "SwitchChainError" || name === "ChainNotConfiguredError")
    return `Your wallet could not switch to ${CHAIN_LABEL}. Add the network (chain ${CHAIN.id}, RPC ${CHAIN.rpcUrls.default.http[0]}) and try again.`;
  return (err.shortMessage ?? err.message ?? "Something went wrong.").split("\n")[0];
}

/** Wallets to offer: each one the browser announces (EIP-6963), or the generic injected one if none announces. */
function useWallets(): Connector[] {
  const connectors = useConnectors();
  const [hasInjected, setHasInjected] = useState(false);
  useEffect(() => setHasInjected(typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum), []);
  const announced = connectors.filter((c) => c.id !== "injected");
  if (announced.length) return announced;
  return hasInjected ? connectors.filter((c) => c.id === "injected") : [];
}

/**
 * Connect a browser wallet on Ukiyo's chain. Lists every wallet the browser has (so a second extension cannot hijack
 * the request), connects and switches to the chain in one step (the wallet adds the network if it lacks it), says in
 * plain words what went wrong, and points to a wallet when there is none.
 */
export function ConnectButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const wallets = useWallets();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // close the menu on an outside click
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function connectTo(c: Connector) {
    setError(null);
    try {
      await connectAsync({ connector: c, chainId: CHAIN.id });
      setOpen(false);
    } catch (e) {
      setError(explain(e));
    }
  }

  async function switchTo() {
    setError(null);
    try {
      await switchChainAsync({ chainId: CHAIN.id });
    } catch (e) {
      setError(explain(e));
    }
  }

  let button: React.ReactNode;
  if (isConnected && chainId !== CHAIN.id) {
    button = (
      <button className="btn sm warn" disabled={switching} onClick={switchTo}>
        {switching ? "Check your wallet…" : `Switch to ${CHAIN_LABEL}`}
      </button>
    );
  } else if (isConnected) {
    button = (
      <button className="btn sm ghost" onClick={() => disconnect()} title="Disconnect">
        <span className="dot live" /> {short(address!)}
      </button>
    );
  } else {
    button = (
      <button
        className="btn sm"
        disabled={isPending}
        aria-expanded={open}
        onClick={() => (wallets.length === 1 ? connectTo(wallets[0]) : (setError(null), setOpen(!open)))}
      >
        {isPending ? "Check your wallet…" : "Connect wallet"}
      </button>
    );
  }

  const site = typeof window !== "undefined" ? window.location.host + window.location.pathname : "";
  return (
    <div className="wallet" ref={box}>
      {button}
      {open && !isConnected && (
        <div className="wallet-pop" role="menu">
          {wallets.length > 0 ? (
            <>
              <p className="wallet-title">Choose a wallet</p>
              {wallets.map((c) => (
                <button key={c.uid} className="wallet-opt" role="menuitem" onClick={() => connectTo(c)} disabled={isPending}>
                  {c.icon ? <img src={c.icon} alt="" width={22} height={22} /> : <span className="wallet-blank" />}
                  {c.id === "injected" ? "Browser wallet" : c.name}
                </button>
              ))}
              <p className="wallet-note">Connects on {CHAIN_LABEL}; your wallet adds the network if it does not have it.</p>
            </>
          ) : (
            <>
              <p className="wallet-title">No browser wallet found</p>
              <p className="wallet-note">
                Install <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask</a> or{" "}
                <a href="https://rabby.io/" target="_blank" rel="noreferrer">Rabby</a>, then reload this page.
              </p>
              <p className="wallet-note">
                On a phone, open this page in your wallet&apos;s browser:{" "}
                <a href={`https://metamask.app.link/dapp/${site}`}>open in MetaMask</a>.
              </p>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="wallet-pop wallet-err" role="alert">
          <p>{error}</p>
          {EXPLORER && error.includes("network") && (
            <p className="wallet-note">
              {CHAIN_LABEL} details: chain id {CHAIN.id}, explorer {EXPLORER.replace(/^https?:\/\//, "")}.
            </p>
          )}
          <button className="link" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
    </div>
  );
}
