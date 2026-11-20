"""
Ukiyo backtest core: a block-by-block concentrated-liquidity pool with curator sleeves.

Each block:
  1. top-of-block arbitrage moves the pool to the edge of the fee band around the CEX price
  2. Poisson noise traders swap random sizes in random directions (each pays the fee)
  3. truth: each sleeve's LVR marked at CEX prices (what a per-block delta hedger loses)
  4. estimators: what the hook can compute from pool prices only
  5. curators may rebalance (at CEX price, paying a cost)

All values in token1 (USD) units, price normalised to 1 at start.
"""
import numpy as np
from numba import njit

# ---- estimator columns -------------------------------------------------------
EST_NAMES = [
    "raw_end",      # 0  l(ds)^2/s, block-close marks (old Ukiyo)
    "zhou_end",     # 1  + first-order autocovariance correction
    "raw_post",     # 2  marks taken right after the first swap of each block
    "zhou_post",    # 3  post-first-swap marks + correction
    "sparse10",     # 4  every 10th block-close mark
    "avgsparse10",  # 5  average of the 10 offset sparse grids
    "tsrv10",       # 6  two-scale (avgsparse10 - raw/10) / (1 - 1/10)
    "sparse60",     # 7
    "avgsparse60",  # 8
    "tsrv60",       # 9
    "zhou2_end",    # 10 two-lag flat kernel on close marks
    "band_mark",    # 11 LVR at reconstructed CEX marks: post-first-swap price shifted one fee-width in the swap's direction
    "first_fee",    # 12 fees earned on the first swap of each block (the arb slot under priority ordering)
    "flag_noise_fee",  # 13 fees from swaps the hook classifies as uninformed (priority-fee test, with error)
    "flag_noise_impact",  # 14 price impact of swaps classified as uninformed: l (ds)^2 / s per swap
    "block_disp",   # 15 net displacement after the arb slot, per block: l (s_close - s_post)^2 / s_post
    "cls_arb_fee_as_user",    # 16 fees from true arbitrage swaps the classifier booked as user (overstates Edge)
    "cls_noise_fee_as_arb",   # 17 fees from true noise swaps the classifier booked as arbitrage (understates Edge)
]
# Classifier modes for run(..., cls_mode=):
#   0  at swap time, with injected error rates miss_arb / false_arb (stands in for the priority-fee test)
#   1  ex post, pool markout: arbitrage iff the trader is in profit, fee included, at the next block's post-arb mark
#   2  ex post, band markout: as 1, with that mark pushed one fee-width in its first swap's direction (the band_mark
#      reconstruction of the external price; an arbitrage stops one fee-width short of it)
#   3  ex post, reverted: user iff the next post-arb mark is back beyond the swap's starting price
#   4  ex post, reverted per bucket (what the hook stores): one bucket for a block's up-swaps and one for its
#      down-swaps; a bucket is user iff the next post-arb mark is back beyond every start price in it
CLS_NAMES = ["swap-time (injected error)", "pool markout", "band markout", "reverted", "reverted, bucketed"]
MAXPEND = 64
NE = len(EST_NAMES)
K1 = 10
K2 = 60

# ---- epoch output columns ----------------------------------------------------
OUT_NAMES = ["fees", "lvr_true", "rebal_cost", "v_start", "v_end", "hodl_end",
             "in_range", "n_rebal", "arb_fees", "noise_fees"]
NO = len(OUT_NAMES)


@njit(cache=True)
def clip(s, a, b):
    if s < a:
        return a
    if s > b:
        return b
    return s


@njit(cache=True)
def xamt(l, s, a, b):
    c = clip(s, a, b)
    return l * (1.0 / c - 1.0 / b)


@njit(cache=True)
def yamt(l, s, a, b):
    c = clip(s, a, b)
    return l * (c - a)


@njit(cache=True)
def apply_move(s_old, s_new, P, gamma, L, SA, SB, fees, fee_src, src, flag_noise, flagbuf, impbuf):
    """Move pool from s_old to s_new; credit fees on the input token to each sleeve."""
    n = L.shape[0]
    for i in range(n):
        if L[i] <= 0.0:
            continue
        if s_new > s_old:   # token1 in
            dy = yamt(L[i], s_new, SA[i], SB[i]) - yamt(L[i], s_old, SA[i], SB[i])
            f = gamma * dy
        else:               # token0 in
            dx = xamt(L[i], s_new, SA[i], SB[i]) - xamt(L[i], s_old, SA[i], SB[i])
            f = gamma * dx * P
        fees[i] += f
        fee_src[i, src] += f
        if flag_noise:
            flagbuf[i] += f
            c0 = clip(s_old, SA[i], SB[i])
            c1 = clip(s_new, SA[i], SB[i])
            impbuf[i] += L[i] * (c1 - c0) * (c1 - c0) / c0


@njit(cache=True)
def book_resolved(est_e, fee, imp, user, src):
    """Book one classified swap's per-sleeve fee and impact; track errors against the simulator's truth."""
    for i in range(fee.shape[0]):
        if user:
            est_e[i, 13] += fee[i]
            est_e[i, 14] += imp[i]
            if src == 0:
                est_e[i, 16] += fee[i]
        elif src == 1:
            est_e[i, 17] += fee[i]


@njit(cache=True)
def record_move(s_old, s_new, P, gamma, L, SA, SB, fees, fee_src, src, flag_noise, flagbuf, impbuf, cls_mode, t,
                pend_n, pend_fee, pend_imp, pend_dir, pend_s0, pend_px, pend_src, pend_blk, scratch_f, scratch_i,
                est_e):
    """Apply a swap. Mode 0 classifies now (flag_noise); ex-post modes queue it for the next block's mark."""
    scratch_f[:] = 0.0
    scratch_i[:] = 0.0
    apply_move(s_old, s_new, P, gamma, L, SA, SB, fees, fee_src, src, True, scratch_f, scratch_i)
    if cls_mode == 0:
        for i in range(L.shape[0]):
            if flag_noise:
                flagbuf[i] += scratch_f[i]
                impbuf[i] += scratch_i[i]
                if src == 0:
                    est_e[i, 16] += scratch_f[i]
            elif src == 1:
                est_e[i, 17] += scratch_f[i]
        return pend_n
    if pend_n >= pend_fee.shape[0]:
        book_resolved(est_e, scratch_f, scratch_i, False, src)  # no room: call it arbitrage
        return pend_n
    d = 1.0 if s_new > s_old else -1.0
    pend_fee[pend_n, :] = scratch_f
    pend_imp[pend_n, :] = scratch_i
    pend_dir[pend_n] = d
    pend_s0[pend_n] = s_old
    # execution price per token0, LP fee included: buyers pay s0 s1 / (1 - fee), sellers get s0 s1 (1 - fee)
    pend_px[pend_n] = s_old * s_new / (1.0 - gamma) if d > 0 else s_old * s_new * (1.0 - gamma)
    pend_src[pend_n] = src
    pend_blk[pend_n] = t
    return pend_n + 1


@njit(cache=True)
def solve_up(s, Y, L, SA, SB):
    """New sqrt price after Y token1 (net of fee) are swapped in."""
    n = L.shape[0]
    it = 0
    while Y > 1e-15 and it < 64:
        it += 1
        Lact = 0.0
        nb = 1e30
        for i in range(n):
            if L[i] <= 0.0:
                continue
            if SA[i] <= s < SB[i]:
                Lact += L[i]
            if SA[i] > s and SA[i] < nb:
                nb = SA[i]
            if SB[i] > s and SB[i] < nb:
                nb = SB[i]
        if Lact > 0.0:
            s_need = s + Y / Lact
            if s_need <= nb:
                return s_need
            Y -= Lact * (nb - s)
            s = nb
        else:
            if nb >= 1e29:
                return s
            s = nb
    return s


@njit(cache=True)
def solve_down(s, X, L, SA, SB):
    """New sqrt price after X token0 (net of fee) are swapped in."""
    n = L.shape[0]
    it = 0
    while X > 1e-15 and it < 64:
        it += 1
        Lact = 0.0
        nb = 0.0
        for i in range(n):
            if L[i] <= 0.0:
                continue
            if SA[i] < s <= SB[i]:
                Lact += L[i]
            if SA[i] < s and SA[i] > nb:
                nb = SA[i]
            if SB[i] < s and SB[i] > nb:
                nb = SB[i]
        if Lact > 0.0:
            inv = 1.0 / s + X / Lact
            s_need = 1.0 / inv
            if s_need >= nb:
                return s_need
            X -= Lact * (1.0 / nb - 1.0 / s)
            s = nb
        else:
            if nb <= 0.0:
                return s
            s = nb
    return s


@njit(cache=True)
def sleeve_value(l, s, a, b, P):
    return xamt(l, s, a, b) * P + yamt(l, s, a, b)


@njit(cache=True)
def set_range(i, center_price, w, s, P, value, cost_rate, L, SA, SB, x_cur):
    """Redeploy `value` (at CEX price P) into range [c e^-w, c e^w]; pay cost on swapped notional."""
    pa = center_price * np.exp(-w)
    pb = center_price * np.exp(w)
    a = np.sqrt(pa)
    b = np.sqrt(pb)
    c = clip(s, a, b)
    x1 = 1.0 / c - 1.0 / b
    y1 = c - a
    per_l = x1 * P + y1
    l0 = value / per_l
    swapped = abs(x1 * l0 - x_cur) * P
    cost = cost_rate * swapped
    L[i] = (value - cost) / per_l
    SA[i] = a
    SB[i] = b
    return cost


@njit(cache=True)
def run(P, seed, gamma, lam, size_mu, size_sig, typ, width, kvol, cost_rate,
        epoch_len, n_sleeves, capital, miss_arb=0.03, false_arb=0.03, cls_mode=0):
    """
    P: CEX price per block (normalised)
    typ: 0 passive, 1 chaser, 2 vol-adaptive, 3 momentum
    width: log half-width of each sleeve's price range
    Returns per-epoch arrays out[E, N, NO], est[E, N, NE]
    """
    np.random.seed(seed)
    T = P.shape[0]
    E = T // epoch_len
    N = n_sleeves
    out = np.zeros((E, N, NO))
    est = np.zeros((E, N, NE))
    fee_src = np.zeros((N, 2))
    flagbuf = np.zeros(N)
    impbuf = np.zeros(N)
    # ex-post classifier: swaps of the last block with a swap, waiting for the next block's post-arb mark
    pend_n = 0
    pend_fee = np.zeros((MAXPEND, N))
    pend_imp = np.zeros((MAXPEND, N))
    pend_dir = np.zeros(MAXPEND)
    pend_s0 = np.zeros(MAXPEND)
    pend_px = np.zeros(MAXPEND)
    pend_src = np.zeros(MAXPEND, dtype=np.int64)
    pend_blk = np.zeros(MAXPEND, dtype=np.int64)
    scratch_f = np.zeros(N)
    scratch_i = np.zeros(N)

    L = np.zeros(N)
    SA = np.zeros(N)
    SB = np.zeros(N)
    fees = np.zeros(N)
    s = np.sqrt(P[0])
    W = width.copy()
    for i in range(N):
        set_range(i, P[0], W[i], s, P[0], capital, 0.0, L, SA, SB, 0.0)
        # momentum starts neutral

    x_prev = np.zeros(N)
    vc_prev = np.zeros(N)
    for i in range(N):
        x_prev[i] = xamt(L[i], s, SA[i], SB[i])
        vc_prev[i] = sleeve_value(L[i], s, SA[i], SB[i], P[0])

    # estimator state
    last_end = np.full(N, s)
    last_post = np.full(N, s)
    d_end = np.zeros(N)
    d_end2 = np.zeros(N)
    d_post = np.zeros(N)
    grid1 = np.zeros((N, K1))
    grid2 = np.zeros((N, K2))
    for i in range(N):
        for j in range(K1):
            grid1[i, j] = s
        for j in range(K2):
            grid2[i, j] = s
    phat_prev = P[0]
    xh_prev = np.zeros(N)
    vh_prev = np.zeros(N)
    for i in range(N):
        xh_prev[i] = x_prev[i]
        vh_prev[i] = vc_prev[i]
    rv_sub1 = np.zeros(N)
    rv_sub2 = np.zeros(N)

    out_since = np.zeros(N, dtype=np.int64)
    last_rebal = np.zeros(N, dtype=np.int64)
    ewma_var = (0.6 / np.sqrt(365.0 * 7200.0)) ** 2
    alpha = 1.0 - np.exp(np.log(0.5) / 7200.0)

    # epoch-start bookkeeping
    hx = np.zeros(N)
    hy = np.zeros(N)
    blocks_in_epoch = 0
    e = 0
    for i in range(N):
        hx[i] = xamt(L[i], s, SA[i], SB[i])
        hy[i] = yamt(L[i], s, SA[i], SB[i])
        out[0, i, 3] = vc_prev[i]

    P_prev = P[0]
    for t in range(1, T):
        if e >= E:
            break
        Pt = P[t]
        r = np.log(Pt / P_prev)
        ewma_var = (1 - alpha) * ewma_var + alpha * r * r
        fees[:] = 0.0
        fee_src[:, :] = 0.0
        flagbuf[:] = 0.0
        impbuf[:] = 0.0

        # ---- 1. top-of-block arbitrage ----
        first = False
        s_post = s
        fdir = 0.0
        ld = np.log(Pt) - 2.0 * np.log(s)
        if ld > gamma:
            s_new = np.sqrt(Pt * np.exp(-gamma))
            pend_n = record_move(s, s_new, Pt, gamma, L, SA, SB, fees, fee_src, 0, np.random.rand() < miss_arb,
                                     flagbuf, impbuf, cls_mode, t, pend_n, pend_fee, pend_imp, pend_dir, pend_s0,
                                     pend_px, pend_src, pend_blk, scratch_f, scratch_i, est[e])
            s = s_new
            first = True
            s_post = s
            fdir = 1.0
        elif ld < -gamma:
            s_new = np.sqrt(Pt * np.exp(gamma))
            pend_n = record_move(s, s_new, Pt, gamma, L, SA, SB, fees, fee_src, 0, np.random.rand() < miss_arb,
                                     flagbuf, impbuf, cls_mode, t, pend_n, pend_fee, pend_imp, pend_dir, pend_s0,
                                     pend_px, pend_src, pend_blk, scratch_f, scratch_i, est[e])
            s = s_new
            first = True
            s_post = s
            fdir = -1.0
        if first:
            for i in range(N):
                est[e, i, 12] += fees[i]

        # ---- 2. noise traders ----
        nt = np.random.poisson(lam)
        for k in range(nt):
            usd = np.exp(size_mu + size_sig * np.random.randn())
            if np.random.rand() < 0.5:
                s_new = solve_up(s, usd * (1.0 - gamma), L, SA, SB)
            else:
                s_new = solve_down(s, usd * (1.0 - gamma) / Pt, L, SA, SB)
            s_before = s
            if s_new != s:
                pend_n = record_move(s, s_new, Pt, gamma, L, SA, SB, fees, fee_src, 1, np.random.rand() >= false_arb,
                                     flagbuf, impbuf, cls_mode, t, pend_n, pend_fee, pend_imp, pend_dir, pend_s0,
                                     pend_px, pend_src, pend_blk, scratch_f, scratch_i, est[e])
                s = s_new
            if not first:
                first = True
                s_post = s
                fdir = 1.0 if s > s_before else (-1.0 if s < s_before else 0.0)
                for i in range(N):
                    est[e, i, 12] += fees[i]

        # reconstructed external price: where the first swap left the pool, one fee-width further
        if fdir != 0.0:
            phat = s_post * s_post * np.exp(gamma * fdir)
        else:
            phat = phat_prev

        # ex-post classification of the previous swap block, at this block's post-arb mark
        if cls_mode != 0 and fdir != 0.0:
            if cls_mode == 2:
                F = phat
            else:
                F = s_post * s_post
            lo_up = 1e300
            hi_dn = -1e300
            for k in range(pend_n):
                if pend_blk[k] != t:
                    if pend_dir[k] > 0 and pend_s0[k] < lo_up:
                        lo_up = pend_s0[k]
                    if pend_dir[k] < 0 and pend_s0[k] > hi_dn:
                        hi_dn = pend_s0[k]
            keep = 0
            for k in range(pend_n):
                if pend_blk[k] == t:
                    # this block's own swaps wait for the next mark; compact them to the front
                    pend_fee[keep, :] = pend_fee[k, :]
                    pend_imp[keep, :] = pend_imp[k, :]
                    pend_dir[keep] = pend_dir[k]
                    pend_s0[keep] = pend_s0[k]
                    pend_px[keep] = pend_px[k]
                    pend_src[keep] = pend_src[k]
                    pend_blk[keep] = pend_blk[k]
                    keep += 1
                    continue
                if cls_mode == 3:
                    user = pend_dir[k] * (s_post - pend_s0[k]) < 0.0
                elif cls_mode == 4:
                    user = s_post < lo_up if pend_dir[k] > 0 else s_post > hi_dn
                else:
                    user = pend_dir[k] * (F - pend_px[k]) <= 0.0
                book_resolved(est[e], pend_fee[k], pend_imp[k], user, pend_src[k])
            pend_n = keep

        # ---- 3. truth + 4. estimators ----
        for i in range(N):
            a = SA[i]
            b = SB[i]
            xi = xamt(L[i], s, a, b)
            vc = xi * Pt + yamt(L[i], s, a, b)
            lvr_true = x_prev[i] * (Pt - P_prev) - (vc - vc_prev[i])
            out[e, i, 0] += fees[i]
            out[e, i, 1] += lvr_true
            out[e, i, 8] += fee_src[i, 0]
            out[e, i, 9] += fee_src[i, 1]
            est[e, i, 13] += flagbuf[i]
            est[e, i, 14] += impbuf[i]
            if SA[i] < s < SB[i]:
                out[e, i, 6] += 1.0
            l = L[i]
            # close marks
            c0 = clip(last_end[i], a, b)
            c1 = clip(s, a, b)
            d = c1 - c0
            est[e, i, 0] += l * d * d / c0
            est[e, i, 1] += l * (d * d + 2.0 * d * d_end[i]) / c0
            est[e, i, 10] += l * (d * d + 2.0 * d * d_end[i] + 2.0 * d * d_end2[i]) / c0
            d_end2[i] = d_end[i]
            d_end[i] = d
            last_end[i] = s
            q0 = clip(s_post, a, b)
            est[e, i, 15] += l * (c1 - q0) * (c1 - q0) / q0
            # post-first-swap marks
            p0 = clip(last_post[i], a, b)
            p1 = clip(s_post, a, b)
            dp = p1 - p0
            est[e, i, 2] += l * dp * dp / p0
            est[e, i, 3] += l * (dp * dp + 2.0 * dp * d_post[i]) / p0
            d_post[i] = dp
            last_post[i] = s_post
            # sparse grids
            j1 = t % K1
            g0 = clip(grid1[i, j1], a, b)
            inc1 = l * (c1 - g0) ** 2 / g0
            rv_sub1[i] += inc1
            est[e, i, 5] += inc1 / K1
            if j1 == 0:
                est[e, i, 4] += inc1
            grid1[i, j1] = s
            j2 = t % K2
            g0 = clip(grid2[i, j2], a, b)
            inc2 = l * (c1 - g0) ** 2 / g0
            est[e, i, 8] += inc2 / K2
            if j2 == 0:
                est[e, i, 7] += inc2
            grid2[i, j2] = s
            vh = xi * phat + yamt(L[i], s, a, b)
            est[e, i, 11] += xh_prev[i] * (phat - phat_prev) - (vh - vh_prev[i])
            xh_prev[i] = xi
            vh_prev[i] = vh
            x_prev[i] = xi
            vc_prev[i] = vc
        phat_prev = phat

        # ---- 5. curator decisions ----
        sigb = np.sqrt(ewma_var)
        for i in range(N):
            inr = SA[i] < s < SB[i]
            if inr:
                out_since[i] = 0
            else:
                out_since[i] += 1
            do = False
            center = s * s
            w = W[i]
            if typ[i] == 0:      # passive: recentre after 1h out of range
                do = out_since[i] >= 300
            elif typ[i] == 1:    # chaser: recentre as soon as out, 5 min cooldown
                do = (not inr) and (t - last_rebal[i] >= 25)
            elif typ[i] == 2:    # vol-adaptive width, checked hourly
                if t % 300 == 0:
                    target = kvol[i] * sigb * np.sqrt(7200.0)
                    if target < 0.01:
                        target = 0.01
                    if target > 0.6:
                        target = 0.6
                    cur = 0.5 * np.log((SB[i] * SB[i]) / (SA[i] * SA[i]))
                    if (not inr) or abs(np.log(cur / target)) > np.log(1.5):
                        do = True
                        w = target
                        W[i] = target
            elif typ[i] == 3:    # momentum: daily, skew range toward last day's move
                if t % 7200 == 0 and t >= 7200:
                    ret = np.log(Pt / P[t - 7200])
                    sgn = 1.0 if ret > 0 else -1.0
                    center = s * s * np.exp(sgn * 0.8 * w)
                    do = True
            if do:
                v = vc_prev[i]
                xc = x_prev[i]
                cost = set_range(i, center, w, s, Pt, v, cost_rate, L, SA, SB, xc)
                out[e, i, 2] += cost
                out[e, i, 7] += 1.0
                last_rebal[i] = t
                x_prev[i] = xamt(L[i], s, SA[i], SB[i])
                vc_prev[i] = x_prev[i] * Pt + yamt(L[i], s, SA[i], SB[i])
                xh_prev[i] = x_prev[i]
                vh_prev[i] = x_prev[i] * phat + yamt(L[i], s, SA[i], SB[i])
                last_end[i] = s
                last_post[i] = s
                d_end[i] = 0.0
                d_end2[i] = 0.0
                d_post[i] = 0.0
                for j in range(K1):
                    grid1[i, j] = s
                for j in range(K2):
                    grid2[i, j] = s

        P_prev = Pt
        blocks_in_epoch += 1
        if blocks_in_epoch == epoch_len:
            for i in range(N):
                out[e, i, 4] = vc_prev[i]
                out[e, i, 5] = hx[i] * Pt + hy[i]
                out[e, i, 6] /= epoch_len
                # TSRV from the averaged grid and raw
                est[e, i, 6] = (est[e, i, 5] - est[e, i, 0] / K1) / (1.0 - 1.0 / K1)
                est[e, i, 9] = (est[e, i, 8] - est[e, i, 0] / K2) / (1.0 - 1.0 / K2)
            e += 1
            blocks_in_epoch = 0
            if e < E:
                for i in range(N):
                    hx[i] = x_prev[i]
                    hy[i] = vc_prev[i] - x_prev[i] * Pt
                    out[e, i, 3] = vc_prev[i]
    return out, est


# ---- price paths -------------------------------------------------------------
BLOCKS_PER_DAY = 7200          # 12-second blocks
EPOCH = 7 * BLOCKS_PER_DAY      # one week


def synthetic_path(n_weeks, seed, vols=(0.3, 0.6, 1.0), vol_p=(0.4, 0.4, 0.2),
                   drifts=(-0.12, 0.0, 0.12), drift_p=(0.25, 0.5, 0.25)):
    """Regime-switching GBM: each week draws an annual vol and a weekly drift."""
    rng = np.random.default_rng(seed)
    n = EPOCH
    rets = []
    regimes = []
    for w in range(n_weeks):
        sv = rng.choice(vols, p=vol_p)
        mu = rng.choice(drifts, p=drift_p)
        sb = sv / np.sqrt(365.0 * BLOCKS_PER_DAY)
        r = rng.normal(mu / n - 0.5 * sb * sb, sb, n)
        rets.append(r)
        regimes.append((sv, mu))
    r = np.concatenate(rets)
    P = np.exp(np.concatenate([[0.0], np.cumsum(r)]))
    return P, regimes


def real_path(npz_path, seed, start=None, minutes=None):
    """Bitstamp BTC/USD minute closes, Brownian-bridged to 12-second blocks.
    Bridge variance per minute from the Parkinson high-low estimator."""
    d = np.load(npz_path)
    c = d["c"].astype(float)
    h = d["h"].astype(float)
    lo = d["l"].astype(float)
    if start is not None:
        c, h, lo = c[start:start + minutes], h[start:start + minutes], lo[start:start + minutes]
    rng = np.random.default_rng(seed)
    lc = np.log(c)
    park = (np.log(np.maximum(h, c) / np.maximum(np.minimum(lo, c), 1e-9))) ** 2 / (4 * np.log(2))
    sub = 5
    out = [lc[0]]
    for m in range(1, len(lc)):
        a, b = lc[m - 1], lc[m]
        var = max(park[m], (b - a) ** 2 * 0.25, 1e-12)
        z = rng.normal(0, np.sqrt(var / sub), sub)
        walk = np.cumsum(z)
        tt = np.arange(1, sub + 1) / sub
        bridge = a + (b - a) * tt + walk - tt * walk[-1]
        out.extend(bridge.tolist())
    lp = np.array(out)
    return np.exp(lp - lp[0])
