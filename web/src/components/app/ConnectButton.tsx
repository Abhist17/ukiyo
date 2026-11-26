"use client";

import { ConnectButton as RainbowConnect } from "@rainbow-me/rainbowkit";
import { CHAIN_LABEL, short } from "@/lib/chain";

/**
 * The app's wallet button, drawn in Ukiyo's own style, with RainbowKit doing the work behind it: its modal lists
 * browser and mobile wallets (QR codes and deep links through WalletConnect when a project id is set), switches the
 * wallet to Ukiyo's chain, and opens an account menu with copy and disconnect.
 */
export function ConnectButton() {
  return (
    <RainbowConnect.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal, connectModalOpen }) => {
        // until mounted, render a placeholder of the same size so the header does not jump
        if (!mounted) {
          return (
            <button className="btn sm" aria-hidden style={{ visibility: "hidden" }}>
              Connect wallet
            </button>
          );
        }
        if (!account || !chain) {
          return (
            <button className="btn sm" onClick={openConnectModal} disabled={connectModalOpen}>
              Connect wallet
            </button>
          );
        }
        if (chain.unsupported) {
          return (
            <button className="btn sm warn" onClick={openChainModal}>
              Switch to {CHAIN_LABEL}
            </button>
          );
        }
        return (
          <button className="btn sm ghost" onClick={openAccountModal} title="Account">
            <span className="dot live" /> {account.ensName ?? short(account.address as `0x${string}`)}
          </button>
        );
      }}
    </RainbowConnect.Custom>
  );
}
