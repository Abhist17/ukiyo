# Reviewing Ukiyo

**The idea.** Fee APR and "did it beat holding" mostly measure the market, not the curator. The skill in an LP's P&L
is *fees − LVR* (Milionis et al.), but the naive on-chain version, fees minus LVR at pool prices, overstates every
curator by 140–330 bps a week: pool-marked LVR is already net of the fees arbitrageurs pay. Ukiyo's hook measures

```
Edge = user fees + user price impact − arbitrage loss
```

per curator, block by block, with no oracle. On a full year of BTC/USD 2024 prices it tracks true hedged P&L with
correlation 0.987–0.999 and ranks six curators in exactly the true order (weekly error 13–14 bps vs 206–364 bps for
the naive formula).

## 1. See it live (two minutes)

Open [the app](https://ukiyo-ochre.vercel.app/app/). A bot replays real 2024 BTC prices through the pool on Unichain
Sepolia (arbitrage with a priority fee, users without).

- **Vaults**: curators ranked by *Edge return* (Edge over the capital that earned it, so size does not win), with
  each one's skill test (a t-statistic: "skill" only when Edge is statistically clear of zero). Switch to *Fee
  income* to compare the ranking the market uses today. With only four demo curators the two can agree on the live
  board; where they part is on `/research`, the BTC 2024 backtest with six curators.
- **Analytics**: every swap as the hook classified it, and what each curator's Edge is made of.
- **Invest**: one deposit split across curators by their skill tests.
- **Launch**: anyone can become a curator; the factory enforces depositor protections.
- **Faucet**: free test tokens, then deposit, trade or launch yourself.

## 2. Check the claims (a few minutes)

```bash
git clone --recurse-submodules https://github.com/Abhist17/ukiyo && cd ukiyo
./demo.sh --no-pause                         # everything below plus the live hook, in one command (needs Foundry, Node)
```

Or one piece at a time:

```bash
forge test                                   # 118 tests + 6 stateful invariants, canonical PoolManager bytecode
forge test --match-test testFuzz_ledgersMatchReferenceReplay   # differential fuzz: hook ledgers = independent replay
forge test --isolate --match-test test_gas -vv # gas of the swap path and the vault paths
cd sdk && npm install && npm run verify:live # the live deployment is this repo's code, its books replayed to the wei
cd backtest && pip install -r requirements.txt && python fetch_data.py && python experiments.py   # the backtest (~94 MB download)
```

## 3. Where to look (one minute)

- The integration map at the top of the [README](README.md#where-the-uniswap-v4-integration-lives).
- [`src/UkiyoHook.sol`](src/UkiyoHook.sol) and [`src/libraries/EdgeMath.sol`](src/libraries/EdgeMath.sol): the meter.
- [`src/UkiyoVault.sol`](src/UkiyoVault.sol): curators paid only on Edge above a high-water mark, bonded against LVR,
  put on probation after a drawdown.
- [`THREAT_MODEL.md`](THREAT_MODEL.md) and [`SECURITY.md`](SECURITY.md): every actor's powers, every review finding
  with its fix and test, and what is still open, stated plainly.

## What we do not claim

- The classifier is the priority fee. On real Unichain flow about 7% of informed swaps pay no tip; a 5 bps pool
  tolerates that (about 25% error), a 30 bps pool would not. Measured, not assumed: see the README.
- Every rule errs against the curator: roundings, doubtful swaps, and griefing, which can only make a rival's Edge
  read lower than it is (since spike-netted marks, by at most about 4× what it costs them; it was unbounded). Edge as a
  whole can still read high, because arbitrage that pays no tip counts as user flow: over whole backtest years, by up to
  7.6 bps a week on a 5 bps pool (ETH 2021) and up to about 25 bps on a 30 bps pool. See the README's backtest section
  and the threat model.
- A short record cannot pick a curator. Edge measures what a curator earned accurately, but a few weeks of true P&L
  are themselves a noisy read of skill: over 1–13 weeks of BTC 2024, even true hedged P&L orders curators as their
  full-year skill does only 71–73% of the time (fee income: 79–80%), and the skill test needs about 17–20 weeks for
  the replay's best curators and 60 or more for the rest (`backtest/track_record.py`).
- Unaudited hackathon code on a testnet.
