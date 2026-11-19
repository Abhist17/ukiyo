"""Download Bitstamp BTC/USD 1-minute OHLC (ff137/bitstamp-btcusd-minute-data, MIT) and keep calendar 2024.

Writes btc_2024_1m.npz next to this file. Run once before experiments.py.
"""
import gzip
import io
import urllib.request

import numpy as np

URL = ("https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/"
       "data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz")
START, END = 1704067200, 1735689600  # 2024-01-01 .. 2025-01-01 UTC


def main():
    raw = urllib.request.urlopen(URL).read()
    rows = np.genfromtxt(io.BytesIO(gzip.decompress(raw)), delimiter=",", names=True)
    rows = rows[(rows["timestamp"] >= START) & (rows["timestamp"] < END)]
    np.savez_compressed("btc_2024_1m.npz", t=rows["timestamp"], o=rows["open"], h=rows["high"],
                        l=rows["low"], c=rows["close"])
    print(f"saved {len(rows)} minutes")


if __name__ == "__main__":
    main()
