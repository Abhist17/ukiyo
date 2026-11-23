"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatEther, parseEther } from "viem";
import { skillRouterAbi, tokenAbi } from "@/lib/abi";
import type { Live } from "@/lib/useUkiyo";
import { CHAIN, CHAIN_LABEL, DEP, join } from "@/lib/chain";
import { useTx } from "./useTx";
import { TxStatus } from "./TxStatus";

/** Parse a decimal input to wei, or 0 for anything that is not a non-negative number. */
const wei = (v: string) => (/^\d*\.?\d*$/.test(v) && v !== "" && v !== "." ? parseEther(v) : 0n);

/**
 * Invest by skill: one deposit, split by UkiyoSkillRouter across every eligible curator in proportion to its on-chain
 * skill test. The router never holds the money; each slice is escrowed in its vault in the depositor's name.
 */
export function InvestTab({ live }: { live: Live }) {
  const { address, isConnected, chainId } = useAccount();
  const ready = isConnected && chainId === CHAIN.id;
  const router = DEP?.skillRouter;
  const tx = useTx();
  const [btcIn, setBtcIn] = useState("");
  const [usdIn, setUsdIn] = useState("");

  const list = live.vaults.map((v) => v.address);
  const { data: weights, error } = useReadContract({
    chainId: CHAIN.id,
    address: router,
    abi: skillRouterAbi,
    functionName: "weights",
    args: [list],
    query: { enabled: !!router && list.length > 0, refetchInterval: 10_000 },
  });
  const allowanceOf = (token: `0x${string}` | undefined) =>
    ({
      chainId: CHAIN.id,
      address: token,
      abi: tokenAbi,
      functionName: "allowance",
      args: [address!, router!],
      query: { enabled: !!address && !!router && !!token },
    }) as const;
  const { data: btcAllowance } = useReadContract(allowanceOf(DEP?.btc));
  const { data: usdAllowance } = useReadContract(allowanceOf(DEP?.usd));

  if (!router) {
    return (
      <div className="panel narrow">
        <h2>Invest by skill</h2>
        <p className="fine">This deployment predates the skill router. Redeploy with script/DeployUkiyo.s.sol to enable it.</p>
      </div>
    );
  }

  const btc = wei(btcIn);
  const usdAmt = wei(usdIn);
  const anySkill = live.vaults.some((v) => v.tStat > 0 && !v.onProbation);

  async function invest() {
    if (btc > 0n && (btcAllowance ?? 0n) < btc) {
      if (!(await tx.send("Approve tBTC", { address: DEP!.btc, abi: tokenAbi, functionName: "approve", args: [router!, btc] }))) return;
    }
    if (usdAmt > 0n && (usdAllowance ?? 0n) < usdAmt) {
      if (!(await tx.send("Approve tUSD", { address: DEP!.usd, abi: tokenAbi, functionName: "approve", args: [router!, usdAmt] }))) return;
    }
    const [a0, a1] = join(btc, usdAmt);
    await tx.send("Invest by skill", { address: router!, abi: skillRouterAbi, functionName: "deposit", args: [list, a0, a1], gas: 3_000_000n });
  }

  return (
    <div className="panel narrow">
      <div className="panel-head">
        <h2>Invest by skill</h2>
        <span className="muted sm">{live.vaults.length} curators</span>
      </div>
      <p className="fine">
        One deposit, split across every curator by its skill test: the t-statistic of its Edge returns, read on-chain.
        Curators on probation get nothing.{" "}
        {anySkill ? "The split follows each curator's evidence of skill." : "No curator has shown skill yet, so the split is even."}{" "}
        You hold every vault&apos;s shares yourself; the router never keeps the money.
      </p>

      <div className="split">
        {live.vaults.map((v, i) => {
          const bps = weights ? Number(weights[i]) : 0;
          return (
            <div className="split-row" key={v.address}>
              <span className="chip" style={{ background: `var(--s${(v.i % 6) + 1})` }} />
              <span className="split-name">
                {v.name}
                <em>{v.onProbation ? "on probation" : v.edgeEpochs < 2 ? "no record yet" : `t ${v.tStat.toFixed(1)}`}</em>
              </span>
              <span className="track"><span style={{ width: `${bps / 100}%`, background: `var(--s${(v.i % 6) + 1})` }} /></span>
              <b className="mono">{(bps / 100).toFixed(1)}%</b>
            </div>
          );
        })}
        {error && <p className="fine">The router cannot split right now: every curator is on probation.</p>}
      </div>

      <div className="form">
        <label className="field">
          <span>tBTC</span>
          <input inputMode="decimal" placeholder="0.0" value={btcIn} onChange={(e) => setBtcIn(e.target.value)} />
        </label>
        <div className="plus">+</div>
        <label className="field">
          <span>tUSD</span>
          <input inputMode="decimal" placeholder="0.0" value={usdIn} onChange={(e) => setUsdIn(e.target.value)} />
        </label>
      </div>
      <p className="fine">
        Each slice joins its vault at the end of that vault&apos;s epoch. Whatever does not fit a vault&apos;s token mix is
        refunded by that vault, and a slice a vault cannot take comes straight back.
        {btc > 0n || usdAmt > 0n ? ` About ${Number(formatEther(btc)).toFixed(4)} tBTC and ${Number(formatEther(usdAmt)).toLocaleString("en-US")} tUSD in all.` : ""}
      </p>
      <button className="btn" disabled={!ready || (btc === 0n && usdAmt === 0n) || !!error || tx.state.status === "pending"} onClick={invest}>
        Invest by skill
      </button>
      {!ready && <p className="fine">Connect a wallet on {CHAIN_LABEL}. Mint test tokens in the Faucet tab.</p>}
      <TxStatus s={tx.state} />
    </div>
  );
}
