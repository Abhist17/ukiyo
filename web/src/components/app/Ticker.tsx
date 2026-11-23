/** A slow strip of verifiable facts under the app header; each links to where it can be checked. */
const REPO = "https://github.com/Abhist17/ukiyo";
const FACTS: [string, string][] = [
  ["98 tests and 5 stateful invariants against the canonical PoolManager", `${REPO}/tree/main/test`],
  ["Differential fuzz test: every ledger field equals an independent replay", `${REPO}/blob/main/test/UkiyoHook.t.sol`],
  ["No oracle, no keeper: the hook reads only the pool's own prices", `${REPO}#how-the-hook-works`],
  ["Rounding never overstates Edge: losses round up, credits round down", `${REPO}/blob/main/src/libraries/EdgeMath.sol`],
  ["Curators are paid only on Edge above a high-water mark, and bonded against LVR", `${REPO}#paid-in-edge-held-to-edge`],
  ["Threat model: every actor's powers and what is still open", `${REPO}/blob/main/THREAT_MODEL.md`],
  ["Classifier measured on 6,714 real Unichain swaps", `${REPO}#does-the-priority-fee-identify-arbitrage-on-unichain-measured-not-assumed`],
];

export function Ticker() {
  const items = FACTS.map(([t, href]) => (
    <a key={t} href={href} target="_blank" rel="noreferrer">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      </svg>
      {t}
    </a>
  ));
  return (
    <div className="ticker" aria-label="Facts about Ukiyo">
      <div className="ticker-track">
        {items}
        <span aria-hidden className="ticker-dup">{items}</span>
      </div>
    </div>
  );
}
