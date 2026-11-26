"""
Out-of-sample check: the same simulator, curators and Edge formula as experiments.py, on four calendar years of real
ETH/USDT prices (Binance, 2021-2024) instead of BTC/USD 2024. Nothing is re-tuned: SPIKE_FEE_WIDTHS, the curators and
the pool tiers are exactly the ones the BTC backtest uses.

For each year and pool tier it reports, against each curator's true hedged P&L:
  - weekly accuracy of Edge and of the obvious formula (fees - LVR at pool prices): correlation, RMSE, bias in bps;
  - whether the full-year ranking of the six curators by Edge, by fee income and by the obvious formula matches the
    true ranking (Kendall-style: share of curator pairs ordered right);
  - whether each yardstick gets the sign of each curator's year right (who actually lost money).

Run after fetch_eth.py:
    uv run --no-project --with numpy --with numba python multiyear.py
Writes results/eth_multiyear.json.
"""
import json
import time

import numpy as np

from experiments import CURATORS, metrics, pairwise_acc, simulate
from sim import real_path

YEARS = {2021: 1609459200, 2022: 1640995200, 2023: 1672531200, 2024: 1704067200, 2025: 1735689600}
YARDSTICKS = {"edge": "edge_v7_spike8", "naive": "edge_v0_raw", "fees": "fee_apr", "hodl": "vs_hodl"}


def year_slice(t, y):
    a = int(np.searchsorted(t, YEARS[y]))
    b = int(np.searchsorted(t, YEARS[y + 1]))
    return a, b - a


def summarise(m):
    truth = m["truth"]
    total_truth = truth.sum(0)
    row = {"weeks": int(truth.shape[0]), "true_weekly_sd_bps": float(truth.std()),
           "true_total_bps": dict(zip(CURATORS, np.round(total_truth, 1).tolist()))}
    for name, key in YARDSTICKS.items():
        x = m[key]
        err = x - truth
        tot = x.sum(0)
        row[name] = {
            "corr": float(np.corrcoef(x.ravel(), truth.ravel())[0, 1]),
            "rmse_bps": float(np.sqrt((err ** 2).mean())),
            # error relative to how much true P&L itself moves week to week, comparable across years
            "rmse_over_true_sd": float(np.sqrt((err ** 2).mean()) / truth.std()),
            "bias_bps": float(err.mean()),
            "year_pairs_in_true_order": float(pairwise_acc(tot, total_truth)),
            "year_order_exact": bool((np.argsort(-tot) == np.argsort(-total_truth)).all()),
            "picks_true_best": bool(np.argmax(tot) == np.argmax(total_truth)),
            "signs_right": int(((tot > 0) == (total_truth > 0)).sum()),
            "total_bps": dict(zip(CURATORS, np.round(tot, 1).tolist())),
        }
    return row


def main():
    t0 = time.time()
    d = np.load("eth_2021_2024_1m.npz")
    t = d["t"]
    res = {"source": "Binance ETH/USDT 1-minute klines, 2021-2024 (data.binance.vision)", "years": {}}
    for y in (2021, 2022, 2023, 2024):
        start, n = year_slice(t, y)
        P = real_path("eth_2021_2024_1m.npz", seed=7, start=start, minutes=n)
        move = float(d["c"][start + n - 1] / d["c"][start] - 1)
        res["years"][str(y)] = {"eth_return": round(move, 4)}
        for tier in ("5bps", "30bps"):
            out, est = simulate(P, y, tier)
            res["years"][str(y)][tier] = summarise(metrics(out, est))
            print(y, tier, "done", round(time.time() - t0, 1), "s", flush=True)
    json.dump(res, open("results/eth_multiyear.json", "w"), indent=1)
    for y, r in res["years"].items():
        for tier in ("5bps", "30bps"):
            s = r[tier]
            print(f"{y} {tier:5} ETH {r['eth_return']:+.0%} sd {s['true_weekly_sd_bps']:.0f} | Edge corr {s['edge']['corr']:.3f} "
                  f"rmse {s['edge']['rmse_bps']:.1f} ({s['edge']['rmse_over_true_sd']:.0%} of sd) "
                  f"bias {s['edge']['bias_bps']:+.1f} order {s['edge']['year_pairs_in_true_order']:.0%} "
                  f"exact {s['edge']['year_order_exact']} | naive corr {s['naive']['corr']:.2f} "
                  f"rmse {s['naive']['rmse_bps']:.0f} | fees order {s['fees']['year_pairs_in_true_order']:.0%} "
                  f"| signs edge {s['edge']['signs_right']}/6 fees {s['fees']['signs_right']}/6")


if __name__ == "__main__":
    main()
