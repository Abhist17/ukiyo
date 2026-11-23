"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatEther, parseEther } from "viem";
import { factoryAbi, hookAbi, tokenAbi } from "@/lib/abi";
import type { Live } from "@/lib/useUkiyo";
import { CHAIN, CHAIN_LABEL, DEP, priceToTick, usd } from "@/lib/chain";
import { useTx } from "./useTx";
import { TxStatus } from "./TxStatus";

/** Round a tick down (or up) to the pool's spacing. */
function snap(t: number, up: boolean): number {
  const s = DEP!.tickSpacing;
  return (up ? Math.ceil(t / s) : Math.floor(t / s)) * s;
}

/**
 * Become a curator: launch your own vault through UkiyoFactory. One transaction deploys a genuine UkiyoVault, opens its
 * sleeve in the hook-exclusive pool, hands the sleeve to the vault for good and posts the launch bond. The factory
 * enforces the depositor protections (epoch length, probation, a permanent bond), so a launched vault is as safe to
 * deposit in as the demo's own.
 */
export function LaunchTab({ live }: { live: Live }) {
  const { address, isConnected, chainId } = useAccount();
  const ready = isConnected && chainId === CHAIN.id;
  const factory = DEP?.factory;
  const tx = useTx();

  const read = { chainId: CHAIN.id, query: { enabled: !!factory } } as const;
  const { data: minBond } = useReadContract({ ...read, address: factory, abi: factoryAbi, functionName: "minLaunchBond" });
  const { data: minEpoch } = useReadContract({ ...read, address: factory, abi: factoryAbi, functionName: "minEpochLength" });
  const { data: maxProb } = useReadContract({ ...read, address: factory, abi: factoryAbi, functionName: "maxProbationBps" });
  const { data: count } = useReadContract({ chainId: CHAIN.id, address: DEP?.hook, abi: hookAbi, functionName: "sleeveCount" });
  const { data: max } = useReadContract({ chainId: CHAIN.id, address: DEP?.hook, abi: hookAbi, functionName: "MAX_SLEEVES" });
  const { data: allowance } = useReadContract({
    chainId: CHAIN.id,
    address: DEP?.usd,
    abi: tokenAbi,
    functionName: "allowance",
    args: [address!, factory!],
    query: { enabled: !!address && !!factory },
  });

  const [name, setName] = useState("My Ukiyo vault");
  const [symbol, setSymbol] = useState("ukME");
  const [width, setWidth] = useState("5");
  const [fee, setFee] = useState("10");
  const [probation, setProbation] = useState("5");
  const [bond, setBond] = useState("");

  if (!factory) {
    return (
      <div className="panel narrow">
        <h2>Launch a vault</h2>
        <p className="fine">This deployment predates the factory. Redeploy with script/DeployUkiyo.s.sol to enable open launches.</p>
      </div>
    );
  }

  const minBondUsd = minBond !== undefined ? Number(formatEther(minBond)) : 0;
  const bondUsd = bond === "" ? minBondUsd : Number(bond);
  const w = Number(width) / 100;
  const lo = live.price * (1 - w);
  const hi = live.price * (1 + w);
  const [ta, tb] = [priceToTick(lo), priceToTick(hi)];
  const tickLower = snap(Math.min(ta, tb), false);
  const tickUpper = snap(Math.max(ta, tb), true);
  const feeBps = Math.round(Number(fee) * 100);
  const probBps = Math.round(Number(probation) * 100);
  const maxProbBps = maxProb !== undefined ? Number(maxProb) : 0;
  const slotsLeft = count !== undefined && max !== undefined ? Number(max - count) : undefined;

  const problem =
    !name.trim() || !symbol.trim()
      ? "Name the vault and its share token."
      : !(w > 0 && w < 0.9)
        ? "Pick a half-width between 0 and 90%."
        : !(feeBps >= 0 && feeBps <= 2000)
          ? "The performance fee is capped at 20%."
          : !(probBps >= 1 && probBps <= maxProbBps)
            ? `Probation must be between 0.01% and ${maxProbBps / 100}%.`
            : !(bondUsd >= minBondUsd)
              ? `The bond must be at least ${usd(minBondUsd)}.`
              : slotsLeft === 0
                ? "The pool's sleeve slots are full."
                : null;

  async function launch() {
    const bondWei = parseEther(String(bondUsd));
    if ((allowance ?? 0n) < bondWei) {
      const ok = await tx.send("Approve the bond", { address: DEP!.usd, abi: tokenAbi, functionName: "approve", args: [factory!, bondWei] });
      if (!ok) return;
    }
    // ~50 KB of creation code, loaded only when someone actually launches
    const { VAULT_CODE } = await import("@/lib/vaultCode");
    await tx.send("Launch the vault", {
      address: factory!,
      abi: factoryAbi,
      functionName: "launch",
      args: [
        VAULT_CODE,
        tickLower,
        tickUpper,
        { epochLength: minEpoch ?? 0n, performanceFeeBps: BigInt(feeBps), probationBps: BigInt(probBps), minBond: bondWei },
        name.trim(),
        symbol.trim(),
      ],
      gas: 8_000_000n,
    });
  }

  return (
    <div className="panel narrow">
      <div className="panel-head">
        <h2>Launch your own vault</h2>
        <span className="muted sm">{slotsLeft !== undefined ? `${slotsLeft} of ${Number(max)} sleeve slots free` : CHAIN_LABEL}</span>
      </div>
      <p className="fine">
        Anyone can be a curator. One transaction deploys a genuine vault, opens your sleeve in the pool and hands it to
        the vault for good. From then on the hook scores you like every other curator, and depositors see your Edge, your
        Edge return and your skill test.
      </p>
      <div className="form">
        <label className="field">
          <span>Vault name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        <label className="field">
          <span>Share symbol</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
        </label>
        <label className="field">
          <span>Range, each side of the price <em>{usd(lo)} – {usd(hi)}</em></span>
          <input inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} />
        </label>
        <label className="field">
          <span>Performance fee, % of Edge above the high-water mark <em>max 20%</em></span>
          <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <label className="field">
          <span>Probation drawdown, % of the Edge index <em>max {maxProbBps / 100}%</em></span>
          <input inputMode="decimal" value={probation} onChange={(e) => setProbation(e.target.value)} />
        </label>
        <label className="field">
          <span>Permanent bond, tUSD <em>at least {usd(minBondUsd)}</em></span>
          <input inputMode="decimal" placeholder={String(minBondUsd)} value={bond} onChange={(e) => setBond(e.target.value)} />
        </label>
      </div>
      <ul className="fine launch-terms">
        <li>Epochs of {minEpoch !== undefined ? `${Number(minEpoch) / 60} minutes` : "…"}: deposits and exits settle in batches.</li>
        <li>If your Edge index falls {probBps / 100 || "—"}% below its peak, you cannot rebalance for 3 epochs.</li>
        <li>The bond stays in the vault for its life. If an epoch loses more than the LVR budget you promise, the bond pays depositors.</li>
      </ul>
      <button className="btn" disabled={!ready || !!problem || tx.state.status === "pending"} onClick={launch}>
        Launch vault
      </button>
      {problem && ready && <p className="fine">{problem}</p>}
      {!ready && <p className="fine">Connect a wallet on {CHAIN_LABEL}. Mint tUSD for the bond in the Faucet tab.</p>}
      <TxStatus s={tx.state} />
      {tx.state.status === "done" && tx.state.label === "Launch the vault" && (
        <p className="fine">Your vault is live and listed under Vaults. Seed it with a deposit there; it starts earning once the first epoch settles.</p>
      )}
    </div>
  );
}
