"use client";

import { useState } from "react";
import type { TransactionReceipt } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { CHAIN } from "@/lib/chain";

export type TxState = { status: "idle" | "pending" | "done" | "error"; label?: string; message?: string; hash?: string };

/** Sends a contract write, waits for it to be mined, then refreshes every live query. Resolves to the receipt, or null. */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const pc = usePublicClient({ chainId: CHAIN.id });
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  async function send(label: string, req: Parameters<typeof writeContractAsync>[0]) {
    setState({ status: "pending", label });
    try {
      const hash = await writeContractAsync(req);
      setState({ status: "pending", label, hash });
      const r = await pc!.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("Transaction reverted");
      setState({ status: "done", label, hash });
      await qc.invalidateQueries();
      return r as TransactionReceipt;
    } catch (e) {
      const msg = (e as { shortMessage?: string; message: string }).shortMessage ?? (e as Error).message;
      setState({ status: "error", label, message: msg.split("\n")[0] });
      return null;
    }
  }
  return { state, send, reset: () => setState({ status: "idle" }) };
}
