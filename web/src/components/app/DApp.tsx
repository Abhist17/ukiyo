"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo, Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CHAIN, DEP, EXPLORER, short, usd, CHAIN_LABEL } from "@/lib/chain";
import { useLive, useTape } from "@/lib/useUkiyo";
import { Providers } from "./Providers";
import { ConnectButton } from "./ConnectButton";
import { VaultsTab } from "./VaultsTab";
import { TradeTab } from "./TradeTab";
import { AnalyticsTab } from "./AnalyticsTab";
import { FaucetTab } from "./FaucetTab";
import { Ticker } from "./Ticker";
import "./app.css";

const TABS = [
  { id: "vaults", label: "Vaults" },
  { id: "trade", label: "Trade" },
  { id: "analytics", label: "Analytics" },
  { id: "faucet", label: "Faucet" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Live strip under the header: the hook's address, block, price and flow counts. */
function LiveBar() {
  const { data: live, isError } = useLive();
  const { data: tape } = useTape();
  const arb = tape?.filter((t) => t.arb).length ?? 0;
  const user = (tape?.length ?? 0) - arb;
  return (
    <div className="livebar">
      <div className="wrap wide livebar-in">
        <span>
          <span className={`dot ${live ? "live" : isError ? "down" : ""}`} /> {live ? "Live from the hook" : isError ? "Chain unreachable" : "Connecting…"}
          {DEP && (
            <>
              {" · "}
              {EXPLORER ? <a href={`${EXPLORER}/address/${DEP.hook}`} target="_blank" rel="noreferrer" className="mono">{short(DEP.hook)}</a> : <span className="mono">{short(DEP.hook)}</span>}
            </>
          )}
        </span>
        {live && (
          <>
            <span className="mono">block #{live.block.toString()}</span>
            <span>tBTC <b className="mono">{usd(live.price, 0)}</b></span>
            <span className="hide-sm">recent swaps <b>{arb}</b> arb · <b>{user}</b> user</span>
          </>
        )}
      </div>
    </div>
  );
}

function Body({ tab }: { tab: Tab }) {
  const { data: live, isError, error } = useLive();
  if (!DEP) return <div className="panel narrow"><h2>No deployment found</h2><p className="fine">Run script/DeployUkiyo.s.sol, then rebuild the site.</p></div>;
  if (!live)
    return (
      <div className="panel narrow">
        <h2>{isError ? "Can't reach the chain" : "Reading the hook…"}</h2>
        {isError && <p className="fine">{(error as Error)?.message.split("\n")[0]}</p>}
        {isError && CHAIN.id === 31337 && <p className="fine">Start anvil, deploy, and run the replay bot (see the README).</p>}
      </div>
    );
  if (tab === "trade") return <TradeTab live={live} />;
  if (tab === "analytics") return <AnalyticsTab live={live} />;
  if (tab === "faucet") return <FaucetTab />;
  return <VaultsTab live={live} />;
}

/** The Ukiyo app: vaults ranked by live Edge, swaps, analytics and a test-token faucet. */
export function DApp() {
  const [tab, setTab] = useState<Tab>("vaults");
  useEffect(() => {
    const t = new URLSearchParams(location.search).get("tab");
    if (TABS.some((x) => x.id === t)) setTab(t as Tab);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `?tab=${t}`);
  };

  return (
    <Providers>
      <header className="app-header">
        <div className="wrap wide app-header-in">
          <Link className="wordmark-link" href="/" aria-label="Ukiyo home">
            <Wordmark size={28} />
          </Link>
          <nav className="app-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="app-actions">
            <span className="chain-pill hide-sm"><span className="dot live" />{CHAIN_LABEL}</span>
            <ThemeToggle />
            <ConnectButton />
          </div>
        </div>
      </header>
      <Ticker />
      <LiveBar />
      <main className="wrap wide app-main">
        <Body tab={tab} />
      </main>
    </Providers>
  );
}
