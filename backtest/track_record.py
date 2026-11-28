"""How long a track record has to be before it says anything. Reads results/results.json (from experiments.py) and
recomputes nothing. Standard library only.

Two questions a depositor choosing a curator from a short history would ask:

1. Over a window of H weeks, how often does a score order two curators the way their skill over the whole sample does
   (E2c in experiments.py)? Even true hedged P&L is a noisy read of skill over a few weeks, so this has a ceiling.
2. How many weeks until a curator's record clears the vault's skill test, t >= 2 (`UkiyoVault.hasSkill`)? Estimated
   from the backtest's weekly mean and spread of true hedged P&L: t = mean / (sd / sqrt(weeks)), so
   weeks = (2 * sd / |mean|)^2. The vault's test runs on Edge returns, which track true P&L at 0.99+ correlation.
"""
import json
from pathlib import Path

RESULTS = Path(__file__).with_name("results") / "results.json"
SCORES = [("fee_apr", "Fee income"), ("edge_v0_raw", "Fees - pool LVR"), ("edge_v7_spike8", "Ukiyo Edge"),
          ("truth", "True hedged P&L")]


def main():
    res = json.loads(RESULTS.read_text())
    for run in ("btc2024_5bps", "synthetic_5bps"):
        r = res[run]
        print(f"\n{r['label']}")
        print("  Pairs ordered as full-sample skill, by window length:")
        print("    " + "".join(f"{name:>18}" for _, name in SCORES))
        for h, row in r["E2c_window_vs_skill"].items():
            print(f"    {h + ' wk':>6}" + "".join(f"{row[k]:>18.0%}" for k, _ in SCORES)[6:])
        print("  Weeks until the skill test reads t >= 2:")
        for c, mean in r["true_skill_bps_per_week"].items():
            sd = r["true_skill_sd"][c]
            weeks = (2 * sd / abs(mean)) ** 2 if mean else float("inf")
            if mean > 0:
                print(f"    {c:28s} {mean:+7.1f} bps/week, sd {sd:6.1f}: ~{weeks:,.0f} weeks")
            else:
                print(f"    {c:28s} {mean:+7.1f} bps/week, sd {sd:6.1f}: never (a loss; ~{weeks:,.0f} weeks to read t <= -2)")


if __name__ == "__main__":
    main()
