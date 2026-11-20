"use client";

import { useAccount } from "wagmi";
import { parseEther } from "viem";
import { tokenAbi } from "@/lib/abi";
import { CHAIN, DEP, short, CHAIN_LABEL } from "@/lib/chain";
import { useTx } from "./useTx";
import { TxStatus } from "./TxStatus";

/** Free test tokens: the demo's tBTC and tUSD can be minted by anyone. */
export function FaucetTab() {
  const { address, isConnected, chainId } = useAccount();
  const tx = useTx();
  const ready = isConnected && chainId === CHAIN.id;
  const mint = (token: `0x${string}`, sym: string, amount: string) =>
    tx.send(`Mint ${amount} ${sym}`, { address: token, abi: tokenAbi, functionName: "mint", args: [address!, parseEther(amount)] });

  return (
    <div className="panel narrow">
      <div className="panel-head">
        <h2>Test tokens</h2>
        <span className="muted sm">{CHAIN_LABEL}</span>
      </div>
      <p className="fine">
        The demo pool trades two test tokens anyone can mint. They have no value. You also need a little {CHAIN.nativeCurrency.symbol} on {CHAIN_LABEL} for gas.
      </p>
      <div className="faucet">
        {[
          { sym: "tBTC", addr: DEP!.btc, amount: "10" },
          { sym: "tUSD", addr: DEP!.usd, amount: "500000" },
        ].map((t) => (
          <div className="faucet-row" key={t.sym}>
            <div>
              <b>{t.sym}</b>
              <span className="mono muted sm">{short(t.addr)}</span>
            </div>
            <button className="btn sm" disabled={!ready || tx.state.status === "pending"} onClick={() => mint(t.addr, t.sym, t.amount)}>
              Mint {Number(t.amount).toLocaleString("en-US")}
            </button>
          </div>
        ))}
      </div>
      {!ready && <p className="fine">Connect a wallet on {CHAIN_LABEL} to mint.</p>}
      <TxStatus s={tx.state} />
    </div>
  );
}
