"""Ex-post classifiers vs the swap-time (priority-fee) classifier.

Unichain measurements (priority_fees.py) showed tips do not separate informed from uninformed swaps. The ex-post
alternative waits for the next block's post-arbitrage mark and decides then. This compares, on the synthetic
regime-switching paths used by asym.py (3 paths x 26 weeks per tier):

  - swap-time classifiers with injected error rates (oracle, conservative, symmetric 3%)
  - the ex-post rules in sim.py (cls_mode 1-4)

Error rates are fee-weighted against the simulator's truth: miss = arbitrage fees booked as user (overstates Edge),
false = user fees booked as arbitrage (understates Edge). Writes results/markout_classifier.json.
"""
import json
import numpy as np
from sim import run, synthetic_path, EPOCH, CLS_NAMES
from experiments import TYP, WIDTH, KVOL, COST, CAP, TIERS, metrics, pairwise_acc

CASES = [("swap-time, oracle", 0, 0.0, 0.0), ("swap-time, miss 0 / false 25%", 0, 0.0, 0.25),
         ("swap-time, miss 3 / false 3%", 0, 0.03, 0.03), ("swap-time, miss 7 / false 94% (Unichain, T=1)", 0, 0.07,
                                                            0.94)] + \
        [(CLS_NAMES[m], m, 0.0, 0.0) for m in (1, 2, 3, 4)]


def evaluate(tier, mode, miss, false, n_paths=3, weeks=26):
    t = TIERS[tier]
    ms, est16, est17, arbf, noisef = [], 0.0, 0.0, 0.0, 0.0
    for p in range(n_paths):
        P, _ = synthetic_path(weeks, 300 + p)
        out, est = run(P, 500 + p, t["gamma"], t["lam"], np.log(t["mean_usd"]) - 0.5, 1.0, TYP, WIDTH, KVOL, COST,
                       EPOCH, len(TYP), CAP, miss, false, mode)
        ms.append(metrics(out, est))
        est16 += est[:, :, 16].sum()
        est17 += est[:, :, 17].sum()
        arbf += out[:, :, 8].sum()
        noisef += out[:, :, 9].sum()
    m = {k: np.concatenate([x[k] for x in ms]) for k in ms[0]}
    edge, truth = m["edge_v5_blockdisp"], m["truth"]
    e = edge - truth
    return dict(miss_fee=float(est16 / arbf), false_fee=float(est17 / noisef), bias=float(e.mean()),
                rmse=float(np.sqrt((e ** 2).mean())), corr=float(np.corrcoef(edge.ravel(), truth.ravel())[0, 1]),
                same_week_agreement=float(np.mean([pairwise_acc(edge[w], truth[w]) for w in range(len(truth))])),
                share_overstated=float((e > 0).mean()))


def main():
    res = {}
    for tier in TIERS:
        res[tier] = []
        print(f"\n{tier}: {'classifier':44} {'miss':>6} {'false':>6} {'bias':>7} {'rmse':>7} {'corr':>6} {'agree':>6} "
              f"{'over':>5}")
        for name, mode, miss, false in CASES:
            r = dict(classifier=name, cls_mode=mode, injected_miss=miss, injected_false=false,
                     **evaluate(tier, mode, miss, false))
            res[tier].append(r)
            print(f"      {name:44} {r['miss_fee']:6.1%} {r['false_fee']:6.1%} {r['bias']:7.1f} {r['rmse']:7.1f} "
                  f"{r['corr']:6.3f} {r['same_week_agreement']:6.1%} {r['share_overstated']:5.0%}", flush=True)
    with open("results/markout_classifier.json", "w") as f:
        json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
