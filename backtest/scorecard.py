"""Full-year BTC/USD 2024 curator scorecard under two classifier modes:
symmetric_3pct: 3% of arbitrage swaps missed, 3% of user swaps wrongly flagged
conservative:   no arbitrage missed, 10% of user swaps wrongly flagged as arbitrage"""
import json
import numpy as np
from sim import run, real_path, EPOCH
from experiments import TYP, WIDTH, KVOL, COST, CAP, TIERS, CURATORS, metrics

P = real_path("btc_2024_1m.npz", seed=7)
KEYS = ["fee_bps", "vs_hodl_bps", "edge_old_bps", "edge_new_bps", "true_hedged_bps"]
res = {}
for mode, (miss, false) in {"symmetric_3pct": (0.03, 0.03), "conservative": (0.0, 0.10)}.items():
    for tier, t in TIERS.items():
        out, est = run(P, 2024, t["gamma"], t["lam"], np.log(t["mean_usd"]) - 0.5, 1.0,
                       TYP, WIDTH, KVOL, COST, EPOCH, len(TYP), CAP, miss, false)
        m = metrics(out, est)
        rows = []
        for i, c in enumerate(CURATORS):
            rows.append(dict(curator=c,
                             fee_bps=float(m["fee_apr"][:, i].sum()),
                             vs_hodl_bps=float(m["vs_hodl"][:, i].sum()),
                             edge_old_bps=float(m["edge_v0_raw"][:, i].sum()),
                             edge_new_bps=float(m["edge_v5_blockdisp"][:, i].sum()),
                             true_hedged_bps=float(m["truth"][:, i].sum())))
        key = f"{mode}_{tier}"
        res[key] = rows
        print(key)
        for r in rows:
            print("  %-26s" % r["curator"], "  ".join("%s %7.0f" % (k[:8], r[k]) for k in KEYS))
        for k in KEYS:
            print("   rank by %-16s" % k, [r["curator"][:14] for r in sorted(rows, key=lambda r: -r[k])])
json.dump(res, open("results/btc2024_scorecard.json", "w"), indent=1)
