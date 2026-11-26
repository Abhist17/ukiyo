"""Download Binance ETH/USDT 1-minute klines for 2021-2024 from Binance's public data archive (data.binance.vision)
and save them in the same layout as btc_2024_1m.npz. Run once before multiyear.py. Standard library and numpy only.

Four calendar years with very different markets: the 2021 bull run, the 2022 crash, a flat 2023 and the 2024 recovery.
"""
import csv
import io
import urllib.request
import zipfile

import numpy as np

URL = "https://data.binance.vision/data/spot/monthly/klines/ETHUSDT/1m/ETHUSDT-1m-{y}-{m:02d}.zip"
YEARS = range(2021, 2025)


def month(y, m):
    raw = urllib.request.urlopen(URL.format(y=y, m=m), timeout=60).read()
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        rows = list(csv.reader(io.TextIOWrapper(z.open(z.namelist()[0]))))
    # columns: open time (ms), open, high, low, close, volume, ...
    a = np.array([[float(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4])] for r in rows if r[0].isdigit()])
    return a


def main():
    parts = []
    for y in YEARS:
        for m in range(1, 13):
            parts.append(month(y, m))
            print(f"{y}-{m:02d}: {len(parts[-1])} minutes", flush=True)
    a = np.concatenate(parts)
    a = a[np.argsort(a[:, 0], kind="stable")]
    t = (a[:, 0] // 1000).astype(np.int64)
    keep = np.concatenate([[True], np.diff(t) > 0])  # drop any duplicate minute
    a, t = a[keep], t[keep]
    np.savez_compressed("eth_2021_2024_1m.npz", t=t, o=a[:, 1], h=a[:, 2], l=a[:, 3], c=a[:, 4])
    print(f"saved {len(t)} minutes")


if __name__ == "__main__":
    main()
