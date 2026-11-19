"""
Runs the Ukiyo backtest experiments and writes results/ (JSON + CSV).

E1  Which on-chain Edge formula tracks true hedged P&L?
E2  Which scoring metric ranks curators by real skill, week by week?
E3  Which metric this week predicts next week's real hedged P&L?
"""
import json, os, sys, time
import numpy as np
from sim import run, synthetic_path, real_path, EPOCH, EST_NAMES, OUT_NAMES

os.makedirs("results", exist_ok=True)
E = {n: i for i, n in enumerate(EST_NAMES)}
O = {n: i for i, n in enumerate(OUT_NAMES)}

CURATORS = ["Passive wide (+-25%)", "Passive mid (+-8%)", "Tight chaser (+-1.5%)",
            "Vol-adaptive (3 sigma)", "Vol-adaptive (1.5 sigma)", "Momentum (+-10%)"]
TYP = np.array([0, 0, 1, 2, 2, 3])
WIDTH = np.array([0.25, 0.08, 0.015, 0.1, 0.1, 0.1])
KVOL = np.array([0.0, 0.0, 0.0, 3.0, 1.5, 0.0])
COST = 0.0005
CAP = 1e6
TIERS = {"5bps": dict(gamma=0.0005, lam=2.0, mean_usd=600.0),
         "30bps": dict(gamma=0.003, lam=0.5, mean_usd=150.0)}
N_PATHS = int(os.environ.get("N_PATHS", 8))
WEEKS = int(os.environ.get("WEEKS", 26))


def simulate(P, seed, tier):
    t = TIERS[tier]
    sig = 1.0
    mu = np.log(t["mean_usd"]) - sig ** 2 / 2
    return run(P, seed, t["gamma"], t["lam"], mu, sig, TYP, WIDTH, KVOL, COST, EPOCH, len(TYP), CAP)


def metrics(out, est):
    """All per-sleeve-epoch numbers in bps of start-of-week value."""
    v = out[:, :, O["v_start"]]
    f = out[:, :, O["fees"]]
    c = out[:, :, O["rebal_cost"]]
    b = lambda z: z / v * 1e4
    m = {
        "truth": b(f - out[:, :, O["lvr_true"]] - c),
        "fee_apr": b(f),
        "vs_hodl": b(out[:, :, O["v_end"]] + f - out[:, :, O["hodl_end"]]),
        "edge_v0_raw": b(f - est[:, :, E["raw_end"]] - c),
        "edge_v0_zhou": b(f - est[:, :, E["zhou_end"]] - c),
        "edge_v0_sparse60": b(f - est[:, :, E["avgsparse60"]] - c),
        "edge_v1_firstswap": b(f - est[:, :, E["first_fee"]] - est[:, :, E["raw_end"]] - c),
        "edge_v2_bandmark": b(f - est[:, :, E["band_mark"]] - c),
        "edge_v3_classified": b(est[:, :, E["flag_noise_fee"]] - est[:, :, E["raw_end"]] - c),
        "edge_oracle_split": b(out[:, :, O["noise_fees"]] - est[:, :, E["raw_end"]] - c),
        "edge_v3_post": b(est[:, :, E["flag_noise_fee"]] - est[:, :, E["raw_post"]] - c),
        "edge_v3_zhou": b(est[:, :, E["flag_noise_fee"]] - est[:, :, E["zhou_end"]] - c),
        "edge_v4_impact": b(est[:, :, E["flag_noise_fee"]] + est[:, :, E["flag_noise_impact"]] - est[:, :, E["raw_post"]] - c),
        "edge_v5_blockdisp": b(est[:, :, E["flag_noise_fee"]] + est[:, :, E["block_disp"]] - est[:, :, E["raw_post"]] - c),
        "edge_v4_impact_end": b(est[:, :, E["flag_noise_fee"]] + est[:, :, E["flag_noise_impact"]] - est[:, :, E["raw_end"]] - c),
        # decomposition check: pool-marked LVR vs (true LVR - arb fees)
        "lvr_true": b(out[:, :, O["lvr_true"]]),
        "lvr_pool_raw": b(est[:, :, E["raw_end"]]),
        "arb_fees": b(out[:, :, O["arb_fees"]]),
        "noise_fees": b(out[:, :, O["noise_fees"]]),
    }
    return m


def pairwise_acc(score, skill):
    """Share of curator pairs a weekly score orders the same way as true skill."""
    n = len(skill)
    ok = tot = 0
    for i in range(n):
        for j in range(i + 1, n):
            if abs(skill[i] - skill[j]) < 1e-9:
                continue
            tot += 1
            ok += (np.sign(score[i] - score[j]) == np.sign(skill[i] - skill[j]))
    return ok / tot


def spearman(a, b):
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return np.corrcoef(ra, rb)[0, 1]


SCORES = ["fee_apr", "vs_hodl", "edge_v0_raw", "edge_v1_firstswap", "edge_v2_bandmark",
          "edge_v3_classified", "edge_v3_post", "edge_v4_impact", "edge_v5_blockdisp", "edge_oracle_split", "truth"]
EDGES = ["edge_v0_raw", "edge_v0_zhou", "edge_v0_sparse60", "edge_v1_firstswap",
         "edge_v2_bandmark", "edge_v3_classified", "edge_v3_post", "edge_v3_zhou", "edge_v4_impact", "edge_v5_blockdisp", "edge_v4_impact_end", "edge_oracle_split"]


def analyse(m, regimes, label):
    truth = m["truth"]
    res = {"label": label, "epochs": int(truth.shape[0])}
    # E1: estimator accuracy
    e1 = {}
    for k in EDGES:
        err = m[k] - truth
        e1[k] = dict(bias=float(err.mean()), rmse=float(np.sqrt((err ** 2).mean())),
                     mae=float(np.abs(err).mean()),
                     corr=float(np.corrcoef(m[k].ravel(), truth.ravel())[0, 1]))
    res["E1_estimators"] = e1
    gap = (m["lvr_true"] - m["arb_fees"]) - m["lvr_pool_raw"]
    res["decomposition"] = dict(
        mean_lvr_true=float(m["lvr_true"].mean()), mean_lvr_pool=float(m["lvr_pool_raw"].mean()),
        mean_arb_fees=float(m["arb_fees"].mean()),
        mean_abs_gap_lvrtrue_minus_arbfees_minus_lvrpool=float(np.abs(gap).mean()))
    # E2: ranking vs true skill (skill = mean true hedged P&L over the whole sample)
    skill = truth.mean(0)
    res["true_skill_bps_per_week"] = dict(zip(CURATORS, map(float, skill)))
    res["true_skill_sd"] = dict(zip(CURATORS, map(float, truth.std(0))))
    e2 = {}
    best = int(np.argmax(skill))
    for k in SCORES:
        acc = [pairwise_acc(m[k][w], skill) for w in range(truth.shape[0])]
        top = [int(np.argmax(m[k][w]) == best) for w in range(truth.shape[0])]
        row = dict(pairwise=float(np.mean(acc)), picks_best=float(np.mean(top)))
        if regimes is not None:
            trend = np.array([abs(r[1]) > 0 for r in regimes])
            hv = np.array([r[0] >= 0.99 for r in regimes])
            acc = np.array(acc)
            row["pairwise_trending_weeks"] = float(acc[trend].mean())
            row["pairwise_flat_weeks"] = float(acc[~trend].mean())
            row["pairwise_high_vol_weeks"] = float(acc[hv].mean()) if hv.any() else None
        e2[k] = row
    res["E2_ranking"] = e2
    # E2b: does the scoreboard order curators the way their real hedged P&L did that week?
    res["E2b_same_week_truth"] = {k: float(np.mean([pairwise_acc(m[k][w], truth[w]) for w in range(truth.shape[0])])) for k in SCORES}
    # E2c: longer scoring windows (sum over H weeks) against long-run skill
    e2c = {}
    for H in (1, 4, 13):
        row = {}
        nw = truth.shape[0] // H
        for k in SCORES:
            acc = [pairwise_acc(m[k][w * H:(w + 1) * H].sum(0), skill) for w in range(nw)]
            row[k] = float(np.mean(acc))
        e2c[str(H)] = row
    res["E2c_window_vs_skill"] = e2c
    # E3: does this week's score predict next week's true hedged P&L?
    e3 = {}
    for k in SCORES:
        rho = [spearman(m[k][w], truth[w + 1]) for w in range(truth.shape[0] - 1)]
        e3[k] = float(np.nanmean(rho))
    res["E3_predict_next_week"] = e3
    return res


def main():
    t0 = time.time()
    allres = {}
    for tier in TIERS:
        # synthetic, regime-switching
        ms, regs = [], []
        for p in range(N_PATHS):
            P, reg = synthetic_path(WEEKS, 100 + p)
            out, est = simulate(P, 1000 + p, tier)
            ms.append(metrics(out, est))
            regs += reg[:out.shape[0]]
        m = {k: np.concatenate([x[k] for x in ms]) for k in ms[0]}
        allres[f"synthetic_{tier}"] = analyse(m, regs, f"Synthetic regime-switching paths, {tier} pool")
        np.savez_compressed(f"results/synthetic_{tier}.npz", **m)
        print(tier, "synthetic done", round(time.time() - t0, 1), "s", flush=True)
        # real BTC/USD 2024
        P = real_path("btc_2024_1m.npz", seed=7)
        out, est = simulate(P, 2024, tier)
        m = metrics(out, est)
        allres[f"btc2024_{tier}"] = analyse(m, None, f"Bitstamp BTC/USD 2024 replay, {tier} pool")
        np.savez_compressed(f"results/btc2024_{tier}.npz", **m)
        print(tier, "btc2024 done", round(time.time() - t0, 1), "s", flush=True)
    json.dump(allres, open("results/results.json", "w"), indent=1)


if __name__ == "__main__":
    main()
