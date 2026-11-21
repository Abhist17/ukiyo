"use client";

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { formatEther, maxUint256, parseEther } from "viem";
import { routerAbi, tokenAbi } from "@/lib/abi";
import { BTC_IS_0, CHAIN, DEP, MAX_SQRT, MIN_SQRT, POOL_KEY, usd, gwei } from "@/lib/chain";
import type { Live } from "@/lib/useUkiyo";
import { useTx } from "./useTx";
import { TxStatus } from "./TxStatus";
import { Tape } from "./Tape";
import { SwapReceipt, type SwapIntent } from "./SwapReceipt";
import type { TransactionReceipt } from "viem";

/** Swap tBTC and tUSD through the hook-exclusive pool, choosing whether to bid a priority fee. */
export function TradeTab({ live }: { live: Live }) {
  const { address, isConnected, chainId } = useAccount();
  const pc = usePublicClient({ chainId: CHAIN.id });
  const tx = useTx();
  const [sellBtc, setSellBtc] = useState(false);
  const [amt, setAmt] = useState("");
  const [asArb, setAsArb] = useState(false);
  const [last, setLast] = useState<{ receipt: TransactionReceipt; intent: SwapIntent } | null>(null);
  const me = address ?? "0x0000000000000000000000000000000000000000";
  const ready = isConnected && chainId === CHAIN.id;
  const tokenIn = sellBtc ? DEP!.btc : DEP!.usd;

  const reads = useReadContracts({
    allowFailure: false,
    query: { enabled: ready, refetchInterval: 3000 },
    contracts: [
      { address: DEP!.btc, abi: tokenAbi, functionName: "balanceOf", args: [me] },
      { address: DEP!.usd, abi: tokenAbi, functionName: "balanceOf", args: [me] },
      { address: tokenIn, abi: tokenAbi, functionName: "allowance", args: [me, DEP!.router] },
    ],
  });
  const [btcBal, usdBal, allowance] = reads.data ?? [];
  const amountIn = useMemo(() => {
    try {
      return Number(amt) > 0 ? parseEther(amt) : 0n;
    } catch {
      return 0n;
    }
  }, [amt]);
  const fee = DEP!.fee / 1e6;
  const outEst = Number(amt) > 0 ? (sellBtc ? Number(amt) * live.price : Number(amt) / live.price) * (1 - fee) : 0;
  const bal = sellBtc ? btcBal : usdBal;
  const tip = asArb ? live.threshold * 2n : 0n;

  async function swap() {
    if ((allowance ?? 0n) < amountIn)
      if (!(await tx.send("Approve", { address: tokenIn, abi: tokenAbi, functionName: "approve", args: [DEP!.router, maxUint256] }))) return;
    const zeroForOne = sellBtc === BTC_IS_0;
    const intent: SwapIntent = { priceBefore: live.price, sellBtc };
    const block = await pc!.getBlock();
    const base = block.baseFeePerGas ?? 0n;
    const receipt = await tx.send(asArb ? "Swap (priority fee)" : "Swap", {
        address: DEP!.router,
        abi: routerAbi,
        functionName: "swap",
        args: [
          POOL_KEY!,
          { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
          { takeClaims: false, settleUsingBurn: false },
          "0x",
        ],
        // the tip is what the hook reads to classify the swap
        maxPriorityFeePerGas: tip,
        maxFeePerGas: base * 2n + tip + 1n,
        gas: 600_000n,
      });
    if (receipt) {
      setAmt("");
      setLast({ receipt, intent });
    }
  }

  return (
    <div className="app-grid trade">
      <div className="panel swap">
        <div className="panel-head">
          <h2>Swap</h2>
          <span className="muted sm">tBTC / tUSD · 5 bps · hook-exclusive</span>
        </div>
        <label className="field big">
          <span>
            You pay
            <em>
              balance {bal !== undefined ? Number(formatEther(bal)).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}
              {bal ? <button className="link" onClick={() => setAmt(formatEther(bal))}>max</button> : null}
            </em>
          </span>
          <div className="amt">
            <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
            <span className="tok">{sellBtc ? "tBTC" : "tUSD"}</span>
          </div>
        </label>
        <button className="flip" aria-label="Flip direction" onClick={() => { setSellBtc(!sellBtc); setAmt(""); }}>↓↑</button>
        <label className="field big">
          <span>You receive (≈, before price impact)</span>
          <div className="amt">
            <input readOnly value={outEst ? outEst.toLocaleString("en-US", { maximumFractionDigits: sellBtc ? 2 : 6 }) : ""} placeholder="0.0" />
            <span className="tok">{sellBtc ? "tUSD" : "tBTC"}</span>
          </div>
        </label>
        <div className="route">
          <span>Pool price</span><b>{usd(live.price, 2)}</b>
          <span>Priority fee</span><b>{asArb ? gwei(tip) : "none"}</b>
          <span>Hook will classify</span>
          <b><span className={`badge ${asArb ? "arb" : "user"}`}>{asArb ? "ARBITRAGE" : "USER FLOW"}</span></b>
        </div>
        <label className="check">
          <input type="checkbox" checked={asArb} onChange={(e) => setAsArb(e.target.checked)} />
          Bid a priority fee like an arbitrageur (≥ {gwei(live.threshold)}). The hook will
          book this swap&apos;s fee as arbitrage, so it will not count toward any curator&apos;s Edge.
        </label>
        <button className="btn wide" disabled={!ready || amountIn === 0n || amountIn > (bal ?? 0n) || tx.state.status === "pending"} onClick={swap}>
          {!isConnected ? "Connect a wallet to swap" : amountIn > (bal ?? 0n) ? "Not enough balance" : "Swap"}
        </button>
        <TxStatus s={tx.state} />
        {last && <SwapReceipt receipt={last.receipt} intent={last.intent} live={live} onClose={() => setLast(null)} />}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Live tape</h2>
          <span className="muted sm">every swap, as the hook classified it</span>
        </div>
        <Tape rows={16} />
      </div>
    </div>
  );
}
