"use client";

import { decodeEventLog, parseAbiItem, type TransactionReceipt } from "viem";
import { hookAbi } from "@/lib/abi";
import { DEP, EXPLORER, num, priceOf, split, tickToPrice, usd, gwei } from "@/lib/chain";
import type { Live } from "@/lib/useUkiyo";

const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

/** What the swap looked like when it was sent, for the before/after comparison. */
export interface SwapIntent {
  priceBefore: number;
  sellBtc: boolean;
}

/**
 * The receipt of one swap as the hook saw it: classification and tip, size and price move, the LP fee paid, and how
 * that fee splits across the curators whose ranges cover the price (by liquidity, as the hook attributes it).
 */
export function SwapReceipt({ receipt, intent, live, onClose }: { receipt: TransactionReceipt; intent: SwapIntent; live: Live; onClose: () => void }) {
  let cls: { isArbitrage: boolean; priorityFeePerGas: bigint } | undefined;
  let swap: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; fee: number } | undefined;
  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === DEP!.hook.toLowerCase()) {
        const d = decodeEventLog({ abi: hookAbi, data: log.data, topics: log.topics });
        if (d.eventName === "SwapClassified") cls = d.args as typeof cls;
      } else if (log.address.toLowerCase() === DEP!.poolManager.toLowerCase()) {
        const d = decodeEventLog({ abi: [SWAP_EVENT], data: log.data, topics: log.topics });
        swap = d.args as unknown as typeof swap;
      }
    } catch {
      /* a log from another contract or event */
    }
  }
  if (!cls || !swap) return null;

  const [b, u] = split(swap.amount0, swap.amount1);
  const btc = Math.abs(num(b));
  const usdAmt = Math.abs(num(u));
  const after = priceOf(swap.sqrtPriceX96);
  const moveBps = ((after - intent.priceBefore) / intent.priceBefore) * 1e4;
  const feeRate = Number(swap.fee) / 1e6;
  const feeUsd = usdAmt * feeRate;
  const arb = cls.isArbitrage;

  // sleeves whose range covers the price the swap traded at, weighted by liquidity
  const mid = (intent.priceBefore + after) / 2;
  const active = live.vaults
    .map((v) => {
      const a = tickToPrice(v.tickLower);
      const z = tickToPrice(v.tickUpper);
      return { v, on: mid >= Math.min(a, z) && mid < Math.max(a, z), l: Number(v.liquidity) };
    })
    .filter((x) => x.on && x.l > 0);
  const totalL = active.reduce((s, x) => s + x.l, 0) || 1;

  return (
    <div className={`receipt ${arb ? "is-arb" : "is-user"}`}>
      <div className="receipt-head">
        <span className={`badge ${arb ? "arb" : "user"}`}>{arb ? "ARBITRAGE" : "USER FLOW"}</span>
        <b>Your swap, as the hook saw it</b>
        <button className="link" onClick={onClose} aria-label="Close receipt">close</button>
      </div>
      <dl className="receipt-rows">
        <div><dt>Traded</dt><dd>{intent.sellBtc ? `${btc.toFixed(4)} tBTC → ${usd(usdAmt)}` : `${usd(usdAmt)} → ${btc.toFixed(4)} tBTC`}</dd></div>
        <div><dt>Price</dt><dd>{usd(intent.priceBefore)} → {usd(after)} <span className={moveBps >= 0 ? "pos" : "neg"}>({moveBps >= 0 ? "+" : ""}{moveBps.toFixed(1)} bps)</span></dd></div>
        <div><dt>Priority fee</dt><dd>{gwei(cls.priorityFeePerGas)} {arb ? "≥" : "<"} threshold {gwei(live.threshold)}</dd></div>
        <div><dt>LP fee you paid</dt><dd>{usd(feeUsd, 2)}</dd></div>
      </dl>
      <p className="receipt-verdict">
        {arb
          ? "Booked as an arbitrage fee: it never counts toward any curator's Edge, because pool-marked LVR already nets it out."
          : "Booked as user fees: it counts toward the Edge of the curators below. Your price impact will also be credited to them when the next arbitrage reverts it."}
      </p>
      {!arb && active.length > 0 && (
        <div className="receipt-split">
          {active.map(({ v, l }) => (
            <div key={v.address}>
              <span className="chip" style={{ background: `var(--s${v.i + 1})` }} />
              <span>{v.name}</span>
              <div className="track"><div style={{ width: `${(l / totalL) * 100}%`, background: `var(--s${v.i + 1})` }} /></div>
              <b className="num">+{usd(feeUsd * (l / totalL), 2)}</b>
            </div>
          ))}
          <small>Split by each sleeve&apos;s liquidity at the traded price; the hook attributes it exactly from the price path.</small>
        </div>
      )}
      {EXPLORER && (
        <a className="receipt-link" href={`${EXPLORER}/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer">
          View transaction ↗
        </a>
      )}
    </div>
  );
}
