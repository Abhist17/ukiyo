# Submission notes

**Ukiyo** · Uniswap Hook Incubator, cohort 11 · theme: *Active Management and Curation* · author: Abhist Kamle

An on-chain, oracle-free scoreboard for curated liquidity. Each curator runs a hook-owned position in a hook-exclusive
pool, and the hook keeps a per-curator ledger, block by block: `Edge = user fees + user price impact − arbitrage loss`.
Curator vaults, a permissionless launch factory and a skill-weighted deposit router are built on that number.

| | |
| --- | --- |
| Repository | this repo, branch `main` |
| Live app | https://ukiyo-ochre.vercel.app |
| Network | Unichain Sepolia (1301), canonical PoolManager `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |
| Addresses | [README → Live deployment](README.md#live-deployment-unichain-sepolia) |
| Partner integrations | None |
| Start here | [`REVIEWERS.md`](REVIEWERS.md) (five minutes), then the [README](README.md) |

## Built during the hookathon

The hookathon ran from 16 Nov 2026. The repository's first commit is from 19 Nov 2026, and every line of Solidity,
TypeScript and Python in it was written after that, in public commits. Nothing pre-existed.

| Date | What was built |
| --- | --- |
| 19 Nov | The backtest (LVR decomposition on real BTC/USD 2024 prices), `EdgeMath`, the metering hook, first tests |
| 20 Nov | Priority fees measured on 6,714 real Unichain swaps; ex-post classifiers backtested; curator vaults with an Edge-based performance fee, high-water mark and LVR bond; deploy script; replay bot; the app |
| 21 Nov | Live on Unichain Sepolia; manager swaps booked as arbitrage; `rebalanceWithSwap`; the stateful invariant suite; site on Vercel; web unit tests in CI |
| 22 Nov | Added liquidity anchored at the price it joins at; LP fees net of the protocol fee; differential fuzz with liquidity changes and protocol fees |
| 23 Nov | The Edge index: a size-neutral, compounding skill score per vault |
| 24 Nov | Skill t-statistic and probation; `UkiyoFactory` (permissionless launches) and `UkiyoSkillRouter`; security fixes from a full review (price guard on settle and rebalance, freed deposit slots, capped redeploys); `UkiyoLens`; wallet connect rework; line-anchored integration map |
| 25 Nov | Spike-netted marks, backtested before shipping (estimator v7 against the v5 and a rejected v6) |
| 26 Nov | Liquidity put back between marks can no longer be re-anchored, in the same range or a shifted one; impact section; this file and [`FEEDBACK.md`](FEEDBACK.md) |

`git log --reverse` shows the full history, one focused commit at a time.

## What is reused, and credited

Only pinned dependencies and standard tooling, listed in the README's [Credits](README.md#credits):

- OpenZeppelin `uniswap-hooks` (`BaseHook`, `CurrencySettler`) and OpenZeppelin Contracts (`SafeERC20`, `SafeCast`,
  `Math`, `ERC20`, `Ownable`).
- Uniswap v4-core libraries and its `PoolSwapTest` / `PoolModifyLiquidityTest` routers; v4-periphery's `HookMiner`.
- hookmate's canonical PoolManager bytecode, so tests run against the deployed PoolManager, not a recompiled one.
- The project layout follows Uniswap's `v4-template`.
- Public price data (Bitstamp BTC/USD minute bars) and the public Unichain RPC for the priority-fee measurement.

The formula's theory is credited to the LVR papers (Milionis, Moallemi, Roughgarden, Zhang) and to *Priority Is All
You Need* (Robinson and White). The on-chain decomposition, the post-arbitrage marks, the impact credit, the
spike netting, the anchoring and dual-measurement rules, and the vault mechanics are this project's own.

## How to check the claims

```bash
forge test                                   # 109 tests + 5 stateful invariants, canonical PoolManager bytecode
forge test --match-test test_gas -vv         # the README's gas table
cd backtest && uv run --no-project --with numpy --with numba python experiments.py   # every backtest number
cd web && npm test                           # the site's maths, the backtest claim it shows, the README's code links
```

Every number in the README is produced by one of these commands. Known limitations are listed in the README and in
[`THREAT_MODEL.md`](THREAT_MODEL.md), including the ones that cut against the project (the priority-fee classifier
misses about 7% of informed swaps on today's Unichain flow).
