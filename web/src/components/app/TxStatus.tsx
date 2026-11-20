import type { TxState } from "./useTx";
import { EXPLORER } from "@/lib/chain";

/** One line of feedback under a form: pending, done (with an explorer link on testnets) or the revert reason. */
export function TxStatus({ s }: { s: TxState }) {
  if (s.status === "idle") return null;
  const link = s.hash && EXPLORER ? <a href={`${EXPLORER}/tx/${s.hash}`} target="_blank" rel="noreferrer">view</a> : null;
  return (
    <p className={`tx-status ${s.status}`} role="status">
      {s.status === "pending" && <>⏳ {s.label}…</>}
      {s.status === "done" && <>✓ {s.label} confirmed {link}</>}
      {s.status === "error" && <>✕ {s.label}: {s.message}</>}
    </p>
  );
}
