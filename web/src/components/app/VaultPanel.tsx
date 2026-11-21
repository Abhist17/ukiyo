"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatEther, maxUint256, parseEther } from "viem";
import { tokenAbi, vaultAbi } from "@/lib/abi";
import { CHAIN, DEP, join, num, split, usd } from "@/lib/chain";
import type { Live, VaultLive } from "@/lib/useUkiyo";
import { useTx } from "./useTx";
import { useVaultLogs } from "@/lib/logs";
import { TxStatus } from "./TxStatus";


/** Seconds until `to` (chain time), ticking every second between polls. */
function useCountdown(to: number, chainNow: number) {
  const [offset, setOffset] = useState(0);
  const [, setTick] = useState(0);
  useEffect(() => setOffset(chainNow - Date.now() / 1000), [chainNow]);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor(to - (Date.now() / 1000 + offset)));
}

const fmtLeft = (s: number) => (s <= 0 ? "ready to settle" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`);
const clean = (s: string) => (s && Number(s) > 0 ? s : "0");

/** Deposit, redeem and claim for one vault. Entries and exits settle at the epoch boundary. */
export function VaultPanel({ v, live }: { v: VaultLive; live: Live }) {
  const { address, isConnected, chainId } = useAccount();
  const pc = usePublicClient({ chainId: CHAIN.id });
  const tx = useTx();
  const [mode, setMode] = useState<"deposit" | "redeem">("deposit");
  const [btcIn, setBtcIn] = useState("");
  const [usdIn, setUsdIn] = useState("");
  const [sharesIn, setSharesIn] = useState("");
  const left = useCountdown(v.epochEndsAt, live.time);
  const ratio = v.btc > 0 ? v.usd / v.btc : live.price; // the vault's own mix; deposits buy the same mix
  const me = address ?? "0x0000000000000000000000000000000000000000";
  const ready = isConnected && chainId === CHAIN.id;

  const reads = useReadContracts({
    allowFailure: false,
    query: { enabled: ready, refetchInterval: 3000 },
    contracts: [
      { address: v.address, abi: vaultAbi, functionName: "balanceOf", args: [me] },
      { address: v.address, abi: vaultAbi, functionName: "pendingDeposit", args: [BigInt(v.epoch), me] },
      { address: v.address, abi: vaultAbi, functionName: "pendingRedeem", args: [BigInt(v.epoch), me] },
      { address: v.address, abi: vaultAbi, functionName: "refunds", args: [me] },
      { address: DEP!.btc, abi: tokenAbi, functionName: "balanceOf", args: [me] },
      { address: DEP!.usd, abi: tokenAbi, functionName: "balanceOf", args: [me] },
      { address: DEP!.btc, abi: tokenAbi, functionName: "allowance", args: [me, v.address] },
      { address: DEP!.usd, abi: tokenAbi, functionName: "allowance", args: [me, v.address] },
    ],
  });
  const [shares, pendDep, pendRed, refund, btcBal, usdBal, btcAllow, usdAllow] = reads.data ?? [];
  const [pendBtc, pendUsd] = pendDep ? split(pendDep[0], pendDep[1]) : [0n, 0n];
  const [refBtc, refUsd] = refund ? split(refund[0], refund[1]) : [0n, 0n];
  const myValue = shares && v.supply > 0n ? (Number(shares) / Number(v.supply)) * v.tvl : 0;

  // epochs this user asked to redeem in, and still holds a claim for
  const vlogs = useVaultLogs();
  const askedIn = [
    ...new Set(
      (vlogs.data?.logs ?? [])
        .filter(
          (l) =>
            l.name === "RedeemRequested" &&
            l.vault.toLowerCase() === v.address.toLowerCase() &&
            (l.args.user as string).toLowerCase() === (address ?? "").toLowerCase(),
        )
        .map((l) => l.args.epoch as bigint)
        .filter((e) => e < BigInt(v.epoch)),
    ),
  ];
  const claims = useQuery({
    queryKey: ["claims", v.address, address, askedIn.join(","), live.block.toString()],
    enabled: ready && !!pc && askedIn.length > 0,
    queryFn: async () => {
      const open = await Promise.all(
        askedIn.map(async (e) => ({
          e,
          s: await pc!.readContract({ address: v.address, abi: vaultAbi, functionName: "pendingRedeem", args: [e, address!] }),
        })),
      );
      return open.filter((o) => o.s > 0n);
    },
  });

  const want = useMemo(() => {
    try {
      return { btc: parseEther(clean(btcIn)), usd: parseEther(clean(usdIn)), shares: parseEther(clean(sharesIn)) };
    } catch {
      return { btc: 0n, usd: 0n, shares: 0n };
    }
  }, [btcIn, usdIn, sharesIn]);

  const onBtc = (s: string) => {
    setBtcIn(s);
    const n = Number(s);
    setUsdIn(n > 0 ? (n * ratio).toFixed(2) : "");
  };

  async function deposit() {
    if (btcAllow! < want.btc)
      if (!(await tx.send("Approve tBTC", { address: DEP!.btc, abi: tokenAbi, functionName: "approve", args: [v.address, maxUint256] }))) return;
    if (usdAllow! < want.usd)
      if (!(await tx.send("Approve tUSD", { address: DEP!.usd, abi: tokenAbi, functionName: "approve", args: [v.address, maxUint256] }))) return;
    const [a0, a1] = join(want.btc, want.usd);
    if (await tx.send("Deposit request", { address: v.address, abi: vaultAbi, functionName: "requestDeposit", args: [a0, a1] })) {
      setBtcIn("");
      setUsdIn("");
    }
  }

  const canDeposit = ready && want.btc + want.usd > 0n && want.btc <= (btcBal ?? 0n) && want.usd <= (usdBal ?? 0n);
  const canRedeem = ready && want.shares > 0n && want.shares <= (shares ?? 0n);

  return (
    <aside className="panel side">
      <div className="panel-head">
        <div className="who">
          <span className="chip" style={{ background: `var(--s${v.i + 1})` }} />
          <div>
            <b>{v.name}</b>
            <span>{v.symbol} · epoch {v.epoch}</span>
          </div>
        </div>
      </div>

      <div className="mini-stats">
        <div><span>This epoch&apos;s Edge</span><b className={v.epochEdge >= 0 ? "pos" : "neg"}>{usd(v.epochEdge)}</b></div>
        <div><span>Next settlement</span><b>{fmtLeft(left)}</b></div>
        <div><span>Holdings</span><b>{v.btc.toFixed(3)} tBTC · {usd(v.usd)}</b></div>
        <div><span>Your position</span><b>{ready ? usd(myValue) : "—"}</b></div>
      </div>

      <div className="terms-box">
        <div>
          <span>Performance fee</span>
          <b>{v.feeBps / 100}% of Edge</b>
          <small>{v.atHighWater ? "at the high-water mark: due on new gains" : "under water: losses must be earned back first"}</small>
        </div>
        <div>
          <span>LVR bond</span>
          <b>{v.bond > 0 ? usd(v.bond) : "none"}</b>
          <small>{v.bond > 0 ? `pays you any epoch loss beyond ${v.budgetBps} bps of value` : "the curator has not posted a bond"}</small>
        </div>
      </div>

      <div className="seg full" role="tablist">
        <button aria-pressed={mode === "deposit"} onClick={() => setMode("deposit")}>Deposit</button>
        <button aria-pressed={mode === "redeem"} onClick={() => setMode("redeem")}>Redeem</button>
      </div>

      {mode === "deposit" ? (
        <div className="form">
          <label className="field">
            <span>tBTC <em>balance {btcBal !== undefined ? Number(formatEther(btcBal)).toFixed(4) : "—"}</em></span>
            <input inputMode="decimal" placeholder="0.0" value={btcIn} onChange={(e) => onBtc(e.target.value)} />
          </label>
          <div className="plus">+</div>
          <label className="field">
            <span>tUSD <em>balance {usdBal !== undefined ? Number(formatEther(usdBal)).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"}</em></span>
            <input inputMode="decimal" placeholder="0.0" value={usdIn} onChange={(e) => setUsdIn(e.target.value)} />
          </label>
          <p className="fine">
            The tUSD side fills to the vault&apos;s own mix ({ratio.toLocaleString("en-US", { maximumFractionDigits: 0 })} tUSD
            held per tBTC). A deposit buys the same share of every token the vault holds, so no oracle is needed;
            whatever does not fit is refunded at settlement.
          </p>
          <button className="btn wide" disabled={!canDeposit || tx.state.status === "pending"} onClick={deposit}>
            {!isConnected ? "Connect a wallet to deposit" : "Request deposit"}
          </button>
        </div>
      ) : (
        <div className="form">
          <label className="field">
            <span>
              Shares <em>you hold {shares !== undefined ? Number(formatEther(shares)).toFixed(4) : "—"}</em>
              {shares ? <button className="link" onClick={() => setSharesIn(formatEther(shares))}>max</button> : null}
            </span>
            <input inputMode="decimal" placeholder="0.0" value={sharesIn} onChange={(e) => setSharesIn(e.target.value)} />
          </label>
          <p className="fine">Shares go to the vault now and are paid out pro rata (liquidity and idle tokens) when the epoch settles.</p>
          <button className="btn wide" disabled={!canRedeem || tx.state.status === "pending"}
            onClick={async () => (await tx.send("Redeem request", { address: v.address, abi: vaultAbi, functionName: "requestRedeem", args: [want.shares] })) && setSharesIn("")}>
            {!isConnected ? "Connect a wallet to redeem" : "Request redemption"}
          </button>
        </div>
      )}

      {ready && (pendBtc + pendUsd > 0n || (pendRed ?? 0n) > 0n || refBtc + refUsd > 0n || (claims.data?.length ?? 0) > 0) && (
        <div className="pending">
          <p className="label-sm">Your requests</p>
          {pendBtc + pendUsd > 0n && (
            <div className="row">
              <span>Deposit waiting: {num(pendBtc).toFixed(4)} tBTC + {usd(num(pendUsd))}</span>
              <button className="link" onClick={() => tx.send("Cancel deposit", { address: v.address, abi: vaultAbi, functionName: "cancelDeposit" })}>cancel</button>
            </div>
          )}
          {(pendRed ?? 0n) > 0n && <div className="row"><span>Redemption waiting: {num(pendRed!).toFixed(4)} shares</span></div>}
          {claims.data?.map((c) => (
            <div className="row" key={c.e.toString()}>
              <span>Epoch {c.e.toString()} payout ready</span>
              <button className="link" onClick={() => tx.send("Claim", { address: v.address, abi: vaultAbi, functionName: "claimRedemption", args: [c.e] })}>claim</button>
            </div>
          ))}
          {refBtc + refUsd > 0n && (
            <div className="row">
              <span>Refund: {num(refBtc).toFixed(4)} tBTC + {usd(num(refUsd))}</span>
              <button className="link" onClick={() => tx.send("Claim refund", { address: v.address, abi: vaultAbi, functionName: "claimRefund" })}>claim</button>
            </div>
          )}
        </div>
      )}

      {left <= 0 && ready && (
        <button className="btn ghost wide" onClick={() => tx.send("Settle epoch", { address: v.address, abi: vaultAbi, functionName: "settleEpoch", gas: 3_000_000n })}>
          Settle epoch {v.epoch}
        </button>
      )}
      <TxStatus s={tx.state} />
    </aside>
  );
}
