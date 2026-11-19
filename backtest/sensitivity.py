"""How accurate must the hook's arbitrage classifier be?"""
import json, numpy as np
from sim import run, synthetic_path, EPOCH
from experiments import TYP, WIDTH, KVOL, COST, CAP, TIERS, metrics, pairwise_acc
res = {}
for tier, t in TIERS.items():
    rows = []
    for err in [0.0, 0.03, 0.10, 0.25, 0.50]:
        ms = []
        for p in range(3):
            P, reg = synthetic_path(26, 300 + p)
            out, est = run(P, 500 + p, t["gamma"], t["lam"], np.log(t["mean_usd"]) - 0.5, 1.0,
                           TYP, WIDTH, KVOL, COST, EPOCH, len(TYP), CAP, err, err)
            ms.append(metrics(out, est))
        m = {k: np.concatenate([x[k] for x in ms]) for k in ms[0]}
        e = m["edge_v5_blockdisp"] - m["truth"]
        agree = np.mean([pairwise_acc(m["edge_v5_blockdisp"][w], m["truth"][w]) for w in range(len(m["truth"]))])
        agree_fee = np.mean([pairwise_acc(m["fee_apr"][w], m["truth"][w]) for w in range(len(m["truth"]))])
        rows.append(dict(error_rate=err, bias=float(e.mean()), rmse=float(np.sqrt((e**2).mean())),
                         corr=float(np.corrcoef(m["edge_v5_blockdisp"].ravel(), m["truth"].ravel())[0, 1]),
                         same_week_agreement=float(agree), fee_apr_agreement=float(agree_fee)))
        print(tier, rows[-1], flush=True)
    res[tier] = rows
json.dump(res, open("results/sensitivity.json", "w"), indent=1)
