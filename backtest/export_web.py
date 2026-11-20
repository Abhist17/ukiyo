"""Export the BTC/USD 2024 replay to the leaderboard frontend (web/src/data/btc2024.json).

Reads the weekly per-curator arrays that experiments.py saved (results/btc2024_{tier}.npz), the minute prices
(btc_2024_1m.npz) and the headline error statistics (results/results.json). Nothing is recomputed here, so the site
shows exactly the numbers the backtest reports.

Run after experiments.py:  python export_web.py
"""
import json
import os
from datetime import datetime, timezone

import numpy as np

from experiments import CURATORS

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "web", "src", "data", "btc2024.json")
OUT_HOURLY = os.path.join(HERE, "..", "web", "src", "data", "btc2024_hourly.json")
WEEK_MINUTES = 7 * 24 * 60

# Short series names the site shows; the order is the categorical colour order, so never reorder.
SHORT = ["Passive wide", "Passive mid", "Tight chaser", "Vol-adaptive 3σ", "Vol-adaptive 1.5σ", "Momentum"]
STYLE = ["±25% range, never moves", "±8% range, never moves", "±1.5% range, recentres on exit",
         "Width 3σ of recent vol", "Width 1.5σ of recent vol", "±10% range, leans with the trend"]

SERIES = {
    "edge": "edge_v5_blockdisp",  # Ukiyo's formula, as the hook computes it
    "truth": "truth",  # true hedged P&L: fees - true LVR - rebalancing cost
    "naive": "edge_v0_raw",  # fees - LVR at pool prices
    "fees": "fee_apr",  # fee income alone
    "hodl": "vs_hodl",  # position + fees vs holding the deposit
    "arbFees": "arb_fees",
    "userFees": "noise_fees",
    "lvrTrue": "lvr_true",
    "lvrPool": "lvr_pool_raw",
}


def r2(a):
    return np.round(np.asarray(a, dtype=float), 2).tolist()


def main():
    prices = np.load(os.path.join(HERE, "btc_2024_1m.npz"))
    t, c = prices["t"], prices["c"].astype(float)
    stats = json.load(open(os.path.join(HERE, "results", "results.json")))

    out = {
        "source": "Bitstamp BTC/USD 2024 replay (backtest/experiments.py). Weekly numbers in bps of the "
                  "start-of-week position value.",
        "curators": [{"name": n, "short": s, "style": st} for n, s, st in zip(CURATORS, SHORT, STYLE)],
        "tiers": {},
    }
    weeks = None
    for tier in ("5bps", "30bps"):
        m = np.load(os.path.join(HERE, "results", f"btc2024_{tier}.npz"))
        n = m["truth"].shape[0]
        if weeks is None:
            weeks = []
            for k in range(n):
                i0, i1 = k * WEEK_MINUTES, min((k + 1) * WEEK_MINUTES, len(c)) - 1
                weeks.append({
                    "start": datetime.fromtimestamp(int(t[i0]), timezone.utc).strftime("%Y-%m-%d"),
                    "btcOpen": round(float(c[i0]), 2),
                    "btcClose": round(float(c[i1]), 2),
                })
        e1 = stats[f"btc2024_{tier}"]["E1_estimators"]
        out["tiers"][tier] = {
            "series": {name: r2(m[key]) for name, key in SERIES.items()},
            "error": {
                "edge": {k: round(e1["edge_v5_blockdisp"][k], 4) for k in ("mae", "rmse", "corr", "bias")},
                "naive": {k: round(e1["edge_v0_raw"][k], 4) for k in ("mae", "rmse", "corr", "bias")},
            },
        }
    out["weeks"] = weeks
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", os.path.relpath(OUT, HERE), os.path.getsize(OUT), "bytes,", len(weeks), "weeks")

    # Hourly closes for the replay bot (web/scripts/bot.mts), which walks 2024 one hour per step.
    hourly = [int(round(x)) for x in c[59::60]]
    with open(OUT_HOURLY, "w") as f:
        json.dump({"source": "Bitstamp BTC/USD 2024, hourly closes", "start": "2024-01-01T00:59:00Z",
                   "close": hourly}, f, separators=(",", ":"))
    print("wrote", os.path.relpath(OUT_HOURLY, HERE), os.path.getsize(OUT_HOURLY), "bytes,", len(hourly), "hours")


if __name__ == "__main__":
    main()
