"""Measure priority fees on real Uniswap v4 swaps on Unichain mainnet.

Question: do arbitrage swaps pay clearly different priority fees (tips) from user swaps, so that Ukiyo's classifier
can pick a `priorityFeeThreshold`?

Method. Sample `--windows` evenly spaced windows of `--window-blocks` blocks over the last `--days` days. For every
v4 `Swap` event in those windows, read the transaction and its block and record:

  - tip: effective priority fee per gas, min(maxPriorityFeePerGas, maxFeePerGas - baseFee) (or gasPrice - baseFee)
  - who sent it, labelled independently of the tip:
      router  the tx calls a contract that is source-verified on Blockscout (Universal Router, aggregators, ...)
      bot     the tx calls an unverified contract (searchers and market makers do not publish their code)
      other   anything else (EOA, EIP-7702 account, lookup failed)
  - atomic: the tx emits swaps in two or more pools (v2, v3 or v4), the signature of cross-pool arbitrage
  - first: the swap is the first v4 swap of its pool in the block, the slot Ukiyo marks as the arbitrage slot
  - informed (the label that matters for Ukiyo): the swap's markout. Take the pool's own price `h` seconds later and
    compare it with the swap's execution price |amount1 / amount0|, which includes the LP fee. If the trader is in
    profit at that later price, the swap was informed: its fee comes back to the LPs as LVR, exactly the flow Ukiyo
    must call arbitrage. Measured at h = 12 s and 60 s, only in pools with at least `--min-pool-swaps` swaps (in a
    thin pool nobody reverts a user's impact, so every large trade would look informed).

Router/bot and markout are proxies, not ground truth: they are what can be read from the chain without a CEX feed.

Stdlib only. The public RPC caps batches at 10 calls. Writes results/unichain_swaps.csv (one row per swap) and
results/priority_fees.json (the summary that README quotes).

    python priority_fees.py                     # last 7 days, 14 windows x 300 blocks
    python priority_fees.py --days 1 --windows 4
"""
import argparse
import bisect
import csv
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

POOL_MANAGER = "0x1f98400000000000000000000000000000000004"
V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
BLOCKSCOUT = "https://unichain.blockscout.com/api/v2/addresses/"
BATCH = 10  # mainnet.unichain.org answers 413 above this
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
LABEL_CACHE = os.path.join(RESULTS, "unichain_contract_labels.json")

# Thresholds (wei per gas) for the sweep. Unichain's base fee floor is 500,000 wei and the RPC suggests a 1,000,000
# wei tip, so the grid spans "anything above zero" to two orders of magnitude above the wallet default.
HORIZONS = (12, 60)  # markout horizons in seconds (= blocks)
THRESHOLDS = [1, 10, 100, 1_000, 10_000, 100_000, 500_000, 1_000_000, 1_500_000, 2_000_000, 5_000_000, 10_000_000,
              50_000_000, 100_000_000]


def http_json(url, payload=None, retries=6):
    """GET or POST JSON with backoff on rate limits and transient errors."""
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"content-type": "application/json", "user-agent": "ukiyo-backtest"}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == retries - 1:
                raise
            if isinstance(e, urllib.error.HTTPError) and e.code not in (429, 500, 502, 503, 504):
                raise
            time.sleep(1.5 * 2 ** attempt)


class Rpc:
    def __init__(self, url):
        self.url = url

    def batch(self, calls):
        """Run [(method, params), ...] in chunks of BATCH; return results in order."""
        out = []
        for i in range(0, len(calls), BATCH):
            chunk = calls[i:i + BATCH]
            payload = [{"jsonrpc": "2.0", "id": j, "method": m, "params": p} for j, (m, p) in enumerate(chunk)]
            resp = sorted(http_json(self.url, payload), key=lambda r: r["id"])
            for r in resp:
                if "error" in r:
                    raise RuntimeError(r["error"])
                out.append(r["result"])
        return out

    def call(self, method, params):
        return self.batch([(method, params)])[0]


def word(data, i, signed=False):
    """The i-th 32-byte word of hex log data, optionally as two's-complement."""
    v = int(data[2 + 64 * i: 2 + 64 * (i + 1)], 16)
    return v - (1 << 256) if signed and v >> 255 else v


def tip_of(tx, base_fee):
    """Effective priority fee per gas actually paid by `tx` in a block with `base_fee`."""
    if tx.get("maxPriorityFeePerGas") is not None:
        return min(int(tx["maxPriorityFeePerGas"], 16), int(tx["maxFeePerGas"], 16) - base_fee)
    return max(int(tx["gasPrice"], 16) - base_fee, 0)


def fetch_window(rpc, start, end, window_id):
    """All v4 swaps in [start, end] with their tx, block and per-tx swap count across v2/v3/v4."""
    v4 = rpc.call("eth_getLogs", [{"address": POOL_MANAGER, "topics": [V4_SWAP],
                                   "fromBlock": hex(start), "toBlock": hex(end)}])
    every = rpc.call("eth_getLogs", [{"topics": [[V4_SWAP, V3_SWAP, V2_SWAP]],
                                      "fromBlock": hex(start), "toBlock": hex(end)}])
    pools_in_tx = {}
    for log in every:
        pool = log["topics"][1] if log["topics"][0] == V4_SWAP else log["address"]
        pools_in_tx.setdefault(log["transactionHash"], set()).add(pool)

    numbers = sorted({log["blockNumber"] for log in v4}, key=lambda h: int(h, 16))
    blocks = {b["number"]: b for b in rpc.batch([("eth_getBlockByNumber", [n, True]) for n in numbers])}

    rows, seen_pool_in_block = [], set()
    for log in sorted(v4, key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16))):
        b = blocks[log["blockNumber"]]
        base = int(b["baseFeePerGas"], 16)
        tx = b["transactions"][int(log["transactionIndex"], 16)]
        pool = log["topics"][1]
        key = (log["blockNumber"], pool)
        first = key not in seen_pool_in_block
        seen_pool_in_block.add(key)
        rows.append({
            "window": window_id,
            "block": int(log["blockNumber"], 16),
            "timestamp": int(b["timestamp"], 16),
            "tx_index": int(log["transactionIndex"], 16),
            "block_txs": len(b["transactions"]),
            "tx_hash": log["transactionHash"],
            "pool": pool,
            "sender": "0x" + log["topics"][2][-40:],  # msg.sender of PoolManager.swap: what beforeSwap sees
            # Swap data: amount0, amount1 (swapper's deltas, fee included), sqrtPriceX96 after, liquidity, tick, fee
            "amount0": word(log["data"], 0, signed=True),
            "amount1": word(log["data"], 1, signed=True),
            "sqrt_price_x96": word(log["data"], 2),
            "fee_pips": word(log["data"], 5),
            "from": tx["from"],
            "to": (tx["to"] or "").lower(),
            "base_fee": base,
            "tip": tip_of(tx, base),
            "first_in_pool_block": int(first),
            "pools_in_tx": len(pools_in_tx.get(log["transactionHash"], {pool})),
        })
    return rows


def label_contracts(addresses):
    """Blockscout verification status and name for each `to` address, cached on disk."""
    cache = {}
    if os.path.exists(LABEL_CACHE):
        with open(LABEL_CACHE) as f:
            cache = json.load(f)
    todo = [a for a in addresses if a not in cache]

    def lookup(addr):
        try:
            d = http_json(BLOCKSCOUT + addr)
        except Exception as e:  # noqa: BLE001 - a failed lookup is labelled "other", never guessed
            return addr, {"error": str(e)}
        impl = (d.get("implementations") or [{}])[0].get("name")
        return addr, {"is_contract": d.get("is_contract"), "is_verified": d.get("is_verified"),
                      "name": d.get("name") or impl, "proxy_impl": impl}

    with ThreadPoolExecutor(4) as pool:
        for addr, info in pool.map(lookup, todo):
            cache[addr] = info
    with open(LABEL_CACHE, "w") as f:
        json.dump(dict(sorted(cache.items())), f, indent=1)
    return cache


def classify(row, labels):
    info = labels.get(row["to"], {})
    if info.get("is_contract") and info.get("is_verified"):
        return "router"
    if info.get("is_contract") and info.get("is_verified") is False:
        return "bot"
    return "other"


def add_markouts(rows, window_blocks, min_pool_swaps):
    """Set markout_<h>s (bps, trader's view, fee included) on every swap where it can be measured, else None.

    Price is token1 per token0 in raw units, so decimals cancel between execution and pool price.
    """
    swaps_per_pool = {}
    for r in rows:
        swaps_per_pool[r["pool"]] = swaps_per_pool.get(r["pool"], 0) + 1
    path = {}  # (window, pool) -> ([block], [price after]) in log order
    for r in rows:
        blocks, prices = path.setdefault((r["window"], r["pool"]), ([], []))
        blocks.append(r["block"])
        prices.append((r["sqrt_price_x96"] / 2 ** 96) ** 2)
    window_end = {}
    for r in rows:
        window_end[r["window"]] = r["window_start"] + window_blocks - 1
    for r in rows:
        a0, a1 = r["amount0"], r["amount1"]
        measurable = (swaps_per_pool[r["pool"]] >= min_pool_swaps and a0 != 0 and a1 != 0
                      and (a0 > 0) != (a1 > 0) and min(abs(a0), abs(a1)) >= 1_000)
        exec_price = abs(a1) / abs(a0) if measurable else None
        direction = 1 if a0 > 0 else -1  # a0 > 0: the trader received token0, i.e. bought it
        blocks, prices = path[(r["window"], r["pool"])]
        for h in HORIZONS:
            key = f"markout_{h}s"
            if not measurable or r["block"] + h > window_end[r["window"]]:
                r[key] = None
                continue
            future = prices[bisect.bisect_right(blocks, r["block"] + h) - 1]
            r[key] = round(direction * (future / exec_price - 1) * 1e4, 2)


def percentile(sorted_vals, q):
    if not sorted_vals:
        return None
    return sorted_vals[min(len(sorted_vals) - 1, int(q * len(sorted_vals)))]


def describe(tips):
    s = sorted(tips)
    n = len(s)
    return {
        "swaps": n,
        **{f"p{int(q * 100)}": percentile(s, q) for q in (0.05, 0.25, 0.5, 0.75, 0.95)},
        "share_zero": round(sum(t == 0 for t in s) / n, 4) if n else None,
        "share_below_1e5": round(bisect.bisect_left(s, 100_000) / n, 4) if n else None,
        "share_1e6_to_2e6": round((bisect.bisect_right(s, 2_000_000) - bisect.bisect_left(s, 1_000_000)) / n, 4)
        if n else None,
    }


def sweep(rows):
    """For 'arb iff tip >= T': share of bot swaps caught and share of router swaps wrongly called arbitrage."""
    bot = sorted(r["tip"] for r in rows if r["class"] == "bot")
    rtr = sorted(r["tip"] for r in rows if r["class"] == "router")
    out = []
    for t in THRESHOLDS:
        out.append({
            "threshold": t,
            "bot_called_arb": round(1 - bisect.bisect_left(bot, t) / len(bot), 4) if bot else None,
            "router_called_arb": round(1 - bisect.bisect_left(rtr, t) / len(rtr), 4) if rtr else None,
        })
    return out


def _informed_share(rows, h):
    vals = [r[f"markout_{h}s"] for r in rows if r[f"markout_{h}s"] is not None]
    return {"measured": len(vals), "informed": round(sum(v > 0 for v in vals) / len(vals), 4) if vals else None}


def markout_sweep(rows, h):
    """For 'arb iff tip >= T', with informed = positive markout at horizon h as the truth.

    missed_informed: informed swaps called user. Their fees would be booked as user fees and overstate Edge.
    lost_uninformed: uninformed swaps called arbitrage. Their fees are dropped, which understates Edge (safe).
    """
    key = f"markout_{h}s"
    inf = sorted(r["tip"] for r in rows if r[key] is not None and r[key] > 0)
    uni = sorted(r["tip"] for r in rows if r[key] is not None and r[key] <= 0)
    out = []
    for t in THRESHOLDS:
        out.append({
            "threshold": t,
            "missed_informed": round(bisect.bisect_left(inf, t) / len(inf), 4) if inf else None,
            "lost_uninformed": round(1 - bisect.bisect_left(uni, t) / len(uni), 4) if uni else None,
        })
    return {"informed": len(inf), "uninformed": len(uni), "sweep": out}


def summarize(rows, labels, args, head):
    groups = {
        "router": [r for r in rows if r["class"] == "router"],
        "bot": [r for r in rows if r["class"] == "bot"],
        "bot_atomic": [r for r in rows if r["class"] == "bot" and r["pools_in_tx"] >= 2],
        "bot_single_pool": [r for r in rows if r["class"] == "bot" and r["pools_in_tx"] == 1],
        "other": [r for r in rows if r["class"] == "other"],
        **{f"informed_{h}s": [r for r in rows if r[f"markout_{h}s"] is not None and r[f"markout_{h}s"] > 0]
           for h in HORIZONS},
        **{f"uninformed_{h}s": [r for r in rows if r[f"markout_{h}s"] is not None and r[f"markout_{h}s"] <= 0]
           for h in HORIZONS},
        "first_in_pool_block": [r for r in rows if r["first_in_pool_block"]],
        "later_in_pool_block": [r for r in rows if not r["first_in_pool_block"]],
    }
    by_to = {}
    for r in rows:
        by_to.setdefault(r["to"], []).append(r["tip"])
    top = sorted(by_to.items(), key=lambda kv: -len(kv[1]))[:15]
    return {
        "chain": "Unichain mainnet (130)",
        "head_block": head,
        "days": args.days,
        "windows": args.windows,
        "window_blocks": args.window_blocks,
        "min_pool_swaps": args.min_pool_swaps,
        "swaps": len(rows),
        "base_fee_values": sorted({r["base_fee"] for r in rows})[:10],
        "tips_by_class": {k: describe([r["tip"] for r in v]) for k, v in groups.items()},
        "first_swap_class_mix": {c: round(sum(r["class"] == c for r in groups["first_in_pool_block"])
                                          / max(1, len(groups["first_in_pool_block"])), 4)
                                 for c in ("router", "bot", "other")},
        "threshold_sweep": sweep(rows),
        "markout_sweep": {f"{h}s": markout_sweep(rows, h) for h in HORIZONS},
        "informed_share_by_class": {
            f"{h}s": {c: _informed_share([r for r in rows if r["class"] == c], h) for c in ("router", "bot")}
            for h in HORIZONS},
        "informed_share_first_vs_later": {
            f"{h}s": {"first": _informed_share([r for r in rows if r["first_in_pool_block"]], h),
                      "later": _informed_share([r for r in rows if not r["first_in_pool_block"]], h)}
            for h in HORIZONS},
        "top_targets": [{"to": a, "label": labels.get(a, {}).get("name") or
                         ("unverified" if labels.get(a, {}).get("is_verified") is False else "?"),
                         **describe(t)} for a, t in top],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--rpc", default="https://mainnet.unichain.org")
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--windows", type=int, default=14)
    ap.add_argument("--window-blocks", type=int, default=600)
    ap.add_argument("--min-pool-swaps", type=int, default=50)
    ap.add_argument("--head", type=int, default=None, help="pin the last block, for a reproducible sample")
    args = ap.parse_args()

    rpc = Rpc(args.rpc)
    head = args.head or int(rpc.call("eth_blockNumber", []), 16)
    span = int(args.days * 86_400)  # Unichain makes one block per second
    starts = [head - span + i * span // args.windows for i in range(args.windows)]

    rows = []
    with ThreadPoolExecutor(4) as pool:
        jobs = pool.map(lambda iw: fetch_window(Rpc(args.rpc), iw[1], iw[1] + args.window_blocks - 1, iw[0]),
                        enumerate(starts))
        for i, part in enumerate(jobs):
            for r in part:
                r["window_start"] = starts[i]
            rows += part
            print(f"window {i + 1}/{args.windows}: {len(part)} swaps")

    labels = label_contracts(sorted({r["to"] for r in rows}))
    for r in rows:
        r["class"] = classify(r, labels)
    add_markouts(rows, args.window_blocks, args.min_pool_swaps)

    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "unichain_swaps.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    summary = summarize(rows, labels, args, head)
    with open(os.path.join(RESULTS, "priority_fees.json"), "w") as f:
        json.dump(summary, f, indent=1)

    print(f"\n{len(rows)} swaps, head {head}, base fee values {summary['base_fee_values']}")
    print(f"{'class':22} {'n':>6} {'p5':>11} {'p25':>11} {'p50':>11} {'p75':>11} {'p95':>11} {'zero':>6}")
    for k, d in summary["tips_by_class"].items():
        if d["swaps"]:
            print(f"{k:22} {d['swaps']:>6} {d['p5']:>11,} {d['p25']:>11,} {d['p50']:>11,} {d['p75']:>11,} "
                  f"{d['p95']:>11,} {d['share_zero']:>6.1%}")
    print("\nfirst-in-block class mix:", summary["first_swap_class_mix"])
    print(f"\n{'threshold':>12} {'bots called arb':>16} {'routers called arb':>19}")
    for s in summary["threshold_sweep"]:
        print(f"{s['threshold']:>12,} {s['bot_called_arb']:>16.1%} {s['router_called_arb']:>19.1%}")
    for h, m in summary["markout_sweep"].items():
        print(f"\nmarkout {h}: {m['informed']} informed, {m['uninformed']} uninformed")
        print(f"{'threshold':>12} {'informed called user':>21} {'uninformed called arb':>22}")
        for s in m["sweep"]:
            print(f"{s['threshold']:>12,} {s['missed_informed']:>21.1%} {s['lost_uninformed']:>22.1%}")
    print("\ninformed share by class:", summary["informed_share_by_class"])
    print("informed share first vs later in block:", summary["informed_share_first_vs_later"])


if __name__ == "__main__":
    main()
