"""Download Bitstamp BTC/USD 1-minute OHLC (ff137/bitstamp-btcusd-minute-data, MIT) and keep calendar 2024.

Writes btc_2024_1m.npz next to this file. Run once before experiments.py.
"""
import gzip
import io
import time
import urllib.request

import numpy as np

URL = ("https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/"
       "data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz")
START, END = 1704067200, 1735689600  # 2024-01-01 .. 2025-01-01 UTC


def main():
    for attempt in range(1, 4):
        try:
            return fetch()
        except (OSError, EOFError) as e:  # a reset or a cut-off download: try again from the start
            if attempt == 3:
                raise
            print(f"download failed ({e}); retrying in {5 * attempt} s")
            time.sleep(5 * attempt)


def fetch():
    # Stream the 94 MB file and parse only 2024's rows: parsing all of 2012-2025 with genfromtxt took minutes and GBs.
    with urllib.request.urlopen(URL, timeout=60) as resp, gzip.GzipFile(fileobj=resp) as gz:
        lines = io.TextIOWrapper(gz, encoding="ascii")
        cols = next(lines).strip().split(",")
        it, io_, ih, il, ic = (cols.index(k) for k in ("timestamp", "open", "high", "low", "close"))
        out = []
        for line in lines:
            f = line.split(",")
            t = float(f[it])
            if t < START:
                continue
            if t >= END:
                break
            out.append((t, float(f[io_]), float(f[ih]), float(f[il]), float(f[ic])))
    a = np.array(out)
    np.savez_compressed("btc_2024_1m.npz", t=a[:, 0], o=a[:, 1], h=a[:, 2], l=a[:, 3], c=a[:, 4])
    print(f"saved {len(a)} minutes")


if __name__ == "__main__":
    main()
