"use client";

import { useAccount, useReadContracts } from "wagmi";
import { tokenAbi, vaultAbi } from "@/lib/abi";
import { CHAIN, CHAIN_LABEL, DEP, num, split, usd } from "@/lib/chain";
import type { Live } from "@/lib/useUkiyo";
import { useVaultLogs } from "@/lib/logs";
import { useTx } from "./useTx";
import { TxStatus } from "./TxStatus";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Everything the connected wallet holds in Ukiyo: tokens, vault positions, requests in flight, and what it can claim. */
export function PortfolioTab({ live }: { live: Live }) {
  const { address, isConnected, chainId } = useAccount();
  const ready = isConnected && chainId === CHAIN.id;
  const me = address ?? ZERO;
  const tx = useTx();
  const logs = useVaultLogs();

  const per = live.vaults.flatMap((v) => [
    { address: v.address, abi: vaultAbi, functionName: "balanceOf", args: [me] },
    { address: v.address, abi: vaultAbi, functionName: "pendingDeposit", args: [BigInt(v.epoch), me] },
    { address: v.address, abi: vaultAbi, functionName: "pendingRedeem", args: [BigInt(v.epoch), me] },
    { address: v.address, abi: vaultAbi, functionName: "refunds", args: [me] },
  ]);
  // epochs this wallet asked to redeem in, already settled: their payouts may be waiting
  const asked = (logs.data?.logs ?? []).filter(
    (l) => l.name === "RedeemRequested" && (l.args.user as string).toLowerCase() === me.toLowerCase(),
  );
  const claimCalls = asked
    .map((l) => ({ vault: l.vault, e: l.args.epoch as bigint }))
    .filter((c, k, all) => all.findIndex((x) => x.vault === c.vault && x.e === c.e) === k)
    .filter((c) => {
      const v = live.vaults.find((x) => x.address.toLowerCase() === c.vault.toLowerCase());
      return v && c.e < BigInt(v.epoch);
    });

  const reads = useReadContracts({
    allowFailure: false,
    query: { enabled: ready, refetchInterval: 4000 },
    contracts: [
      { address: DEP!.btc, abi: tokenAbi, functionName: "balanceOf", args: [me] },
      { address: DEP!.usd, abi: tokenAbi, functionName: "balanceOf", args: [me] },
      ...per,
      ...claimCalls.map((c) => ({ address: c.vault, abi: vaultAbi, functionName: "pendingRedeem", args: [c.e, me] })),
    ] as never,
  });

  if (!ready) {
    return (
      <div className="panel narrow">
        <div className="panel-head"><h2>Portfolio</h2></div>
        <p className="fine">Connect a wallet on {CHAIN_LABEL} to see your vault positions, requests and claims.</p>
      </div>
    );
  }

  const d = (reads.data ?? []) as unknown[];
  const btcBal = (d[0] as bigint | undefined) ?? 0n;
  const usdBal = (d[1] as bigint | undefined) ?? 0n;
  const rows = live.vaults.map((v, i) => {
    const shares = (d[2 + i * 4] as bigint | undefined) ?? 0n;
    const pd = (d[3 + i * 4] as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
    const pr = (d[4 + i * 4] as bigint | undefined) ?? 0n;
    const rf = (d[5 + i * 4] as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
    const share = v.supply > 0n ? Number(shares) / Number(v.supply) : 0;
    // you own the epochs you hold through; Edge from before you joined was earned by other holders
    const [pdB, pdU] = split(pd[0], pd[1]);
    const [rfB, rfU] = split(rf[0], rf[1]);
    return { v, shares, share, value: share * v.tvl, edge: share * v.epochEdge, pdB, pdU, pr, rfB, rfU };
  });
  const base = 2 + live.vaults.length * 4;
  const claims = claimCalls
    .map((c, k) => ({ ...c, s: (d[base + k] as bigint | undefined) ?? 0n }))
    .filter((c) => c.s > 0n);
  const total = rows.reduce((a, r) => a + r.value, 0) + num(btcBal) * live.price + num(usdBal);
  const held = rows.filter((r) => r.shares > 0n || r.pdB + r.pdU > 0n || r.pr > 0n || r.rfB + r.rfU > 0n);

  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi accent"><span>Portfolio value</span><b>{usd(total)}</b><small>tokens plus vault positions, at the pool price</small></div>
        <div className="kpi"><span>tBTC</span><b>{num(btcBal).toFixed(4)}</b><small>{usd(num(btcBal) * live.price)}</small></div>
        <div className="kpi"><span>tUSD</span><b>{usd(num(usdBal))}</b><small>wallet balance</small></div>
        <div className="kpi"><span>Ready to claim</span><b>{claims.length + rows.filter((r) => r.rfB + r.rfU > 0n).length}</b><small>payouts and refunds</small></div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Vault positions</h2><span className="muted sm">your share of each curator&apos;s vault</span></div>
        {held.length === 0 ? (
          <p className="fine">No positions yet. Mint test tokens on the Faucet tab, then deposit on the Vaults tab.</p>
        ) : (
          <div className="scroll-x">
            <table className="vt">
              <thead>
                <tr>
                  <th className="l">Vault</th><th>Value</th><th>Share of vault</th><th>Your share of this epoch&apos;s Edge</th><th className="l">In flight</th><th />
                </tr>
              </thead>
              <tbody>
                {held.map((r) => (
                  <tr key={r.v.address}>
                    <td className="l">
                      <div className="who">
                        <span className="chip" style={{ background: `var(--s${(r.v.i % 6) + 1})` }} />
                        <div><b>{r.v.name}</b><span>{r.v.symbol} · epoch {r.v.epoch}</span></div>
                      </div>
                    </td>
                    <td className="num strong">{usd(r.value)}</td>
                    <td className="num">{(r.share * 100).toFixed(3)}%</td>
                    <td className={`num ${r.edge >= 0 ? "pos" : "neg"}`}>{usd(r.edge)}</td>
                    <td className="l sm">
                      {r.pdB + r.pdU > 0n && <div>Deposit waiting: {num(r.pdB).toFixed(4)} tBTC + {usd(num(r.pdU))}</div>}
                      {r.pr > 0n && <div>Redemption waiting: {num(r.pr).toFixed(4)} shares</div>}
                      {r.rfB + r.rfU > 0n && <div>Refund ready: {num(r.rfB).toFixed(4)} tBTC + {usd(num(r.rfU))}</div>}
                      {r.pdB + r.pdU + r.pr + r.rfB + r.rfU === 0n && <span className="muted">—</span>}
                    </td>
                    <td>
                      {r.rfB + r.rfU > 0n && (
                        <button className="btn sm" onClick={() => tx.send(`Claim refund from ${r.v.name}`, { address: r.v.address, abi: vaultAbi, functionName: "claimRefund" })}>
                          Claim refund
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {claims.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Redemption payouts ready</h2></div>
          {claims.map((c) => {
            const v = live.vaults.find((x) => x.address.toLowerCase() === c.vault.toLowerCase())!;
            return (
              <div className="faucet-row" key={`${c.vault}-${c.e}`} style={{ marginBottom: 8 }}>
                <div><b>{v.name}</b><span className="muted sm">epoch {c.e.toString()} · {num(c.s).toFixed(4)} shares</span></div>
                <button className="btn sm" onClick={() => tx.send(`Claim ${v.name} payout`, { address: c.vault, abi: vaultAbi, functionName: "claimRedemption", args: [c.e] })}>
                  Claim
                </button>
              </div>
            );
          })}
        </div>
      )}
      <TxStatus s={tx.state} />
    </div>
  );
}
