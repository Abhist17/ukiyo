"""Conservative classifier: never call an arbitrage 'uninformed' (miss=0), sometimes call users 'arbitrage'."""
import json, numpy as np
from sim import run, synthetic_path, EPOCH
from experiments import TYP, WIDTH, KVOL, COST, CAP, TIERS, metrics, pairwise_acc
res = {}
for tier, t in TIERS.items():
    res[tier] = []
    for miss, false in [(0.0, 0.0), (0.0, 0.10), (0.0, 0.25), (0.01, 0.25), (0.03, 0.03)]:
        ms = []
        for p in range(3):
            P, reg = synthetic_path(26, 300 + p)
            out, est = run(P, 500 + p, t["gamma"], t["lam"], np.log(t["mean_usd"]) - 0.5, 1.0,
                           TYP, WIDTH, KVOL, COST, EPOCH, len(TYP), CAP, miss, false)
            ms.append(metrics(out, est))
        m = {k: np.concatenate([x[k] for x in ms]) for k in ms[0]}
        e = m["edge_v5_blockdisp"] - m["truth"]
        agree = np.mean([pairwise_acc(m["edge_v5_blockdisp"][w], m["truth"][w]) for w in range(len(m["truth"]))])
        row = dict(miss_arb=miss, false_arb=false, bias=float(e.mean()), rmse=float(np.sqrt((e ** 2).mean())),
                   corr=float(np.corrcoef(m["edge_v5_blockdisp"].ravel(), m["truth"].ravel())[0, 1]),
                   same_week_agreement=float(agree), share_overstated=float((e > 0).mean()))
        res[tier].append(row)
        print(tier, {k: round(v, 3) for k, v in row.items()}, flush=True)
json.dump(res, open("results/asymmetric_classifier.json", "w"), indent=1)
