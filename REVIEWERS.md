# Reviewing Ukiyo in five minutes

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
  income* to see the ranking the market uses today flip.
- **Analytics**: every swap as the hook classified it, and what each curator's Edge is made of.
- **Invest**: one deposit split across curators by their skill tests.
- **Launch**: anyone can become a curator; the factory enforces depositor protections.
- **Faucet**: free test tokens, then deposit, trade or launch yourself.

## 2. Check the claims (two minutes)

```bash
forge test                                   # 109 tests + 5 stateful invariants, canonical PoolManager bytecode
forge test --match-test testFuzz_ledgersMatchReferenceReplay   # differential fuzz: hook ledgers = independent replay
forge test --match-test test_gas -vv         # gas of the swap path and the vault paths
cd backtest && python experiments.py         # the backtest behind the numbers above
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
- Edge errs low, never high, by design; someone paying fees can still make a rival's Edge read lower than it is, but
  since spike-netted marks only by about 4× what it costs them (it was unbounded). See the README's backtest section
  and the threat model.
- Unaudited hackathon code on a testnet.
