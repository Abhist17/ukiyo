# Ukiyo 浮世

**An honest scoreboard for curated liquidity on Uniswap v4.**

Ukiyo is a Uniswap v4 hook that measures, block by block and with no oracle, how much skill each liquidity curator
actually has. Every curator runs a hook-owned position ("sleeve") in a hook-exclusive pool, and the hook keeps a
ledger per sleeve:

```
Edge = user fees + user price impact − arbitrage loss
```

Built for the Uniswap Hook Incubator, cohort 11 (theme: *Active Management and Curation*).

---

## The problem

Curator vaults are ranked by fee APR or by "did they beat holding?". Both mostly measure the market, not the manager:

- **Fee APR** rewards whoever takes the most volume, including the arbitrage volume that is costing their LPs money.
- **Beat-HODL** rewards being on the right side of the price. In a trending week every curator loses to holding; in a
  round-trip week every curator wins.

The LVR paper (Milionis, Moallemi, Roughgarden, Zhang) splits an LP's P&L into market exposure plus *fees − LVR*. Only
the second part is skill. Ukiyo computes it on-chain.

## What the backtest found (and why the obvious formula is wrong)

The obvious on-chain version, `fees − LVR at pool prices`, overstates every curator by 140–330 bps a week. Pool-marked
LVR is LVR *net of the fees arbitrageurs pay*:

```
LVR_true ≈ LVR_pool + fees_paid_by_arbitrageurs
```

so arbitrage fees are not income: they come straight back as loss. Ukiyo's formula keeps only the fees and price
impact paid by ordinary users, and measures the arbitrage loss at marks taken right after each block's first swap.

| | Old formula | Ukiyo |
| --- | --- | --- |
| Weekly error vs true hedged P&L (BTC/USD 2024 replay) | 206–364 bps | 12–13 bps |
| Correlation with true hedged P&L | −0.58 to 0.50 | 0.987 to 0.999 |
| Weeks it orders curators like their real P&L | 64–77% | 94–99% |
| Full-year ranking of six curators (5 bps pool) | wrong curator first | identical to the true order |

The backtest is in [`backtest/`](backtest/) (Python + Numba, ~20 s per run). It simulates a hook-exclusive pool with
six curator strategies, top-of-block arbitrage inside the fee band and random user flow, on 208 synthetic weeks and on
a full-year replay of Bitstamp BTC/USD 2024 prices.

## How the hook works

| Step | Where | What |
| --- | --- | --- |
| Classify | `beforeSwap` | A swap paying a priority fee (`tx.gasprice − block.basefee`) at or above `priorityFeeThreshold` is **arbitrage**. On Unichain, priority ordering makes arbitrageurs bid for the top of the block. Rule: *when in doubt, call it arbitrage* — the backtest shows a classifier that never misses an arbitrage never overstates Edge. |
| Credit impact | first `beforeSwap` of a block | The previous block closed at the current price. Credit each sleeve `l·(close − s*)²/s*`: user displacement that the next arbitrage reverts in the LPs' favour. Net per block, so a same-block round trip earns nothing. |
| Attribute fees | `afterSwap` | Each sleeve's LP fee is computed exactly from the price path and booked as user or arbitrage fee. Arbitrage fees never count toward Edge. |
| Mark and charge | first `afterSwap` of a block | Record `s*`, the price right after the arbitrage slot. Charge each sleeve `l·(s*_k − s*_{k−1})²/s*_{k−1}`. |

All formulas live in [`src/libraries/EdgeMath.sol`](src/libraries/EdgeMath.sol). Losses round up and credits round
down, so rounding can only understate Edge.

### Contracts

| File | Role |
| --- | --- |
| [`src/UkiyoHook.sol`](src/UkiyoHook.sol) | The meter: hook-exclusive pool, sleeves (≤ 8), per-block marks, priority-fee classifier, per-sleeve ledgers, `edge(sleeveId)` |
| [`src/libraries/EdgeMath.sol`](src/libraries/EdgeMath.sol) | Closed forms: rebalancing loss, impact credit, per-sleeve swap fee, clipping |

### Key lines

- Classification: `_beforeSwap` and `isArbitrage()` in [`UkiyoHook.sol`](src/UkiyoHook.sol)
- Arbitrage loss: `_chargeArbitrageLoss`; impact credit: `_creditImpact`; fees: `_attributeFees`
- The identity the meter relies on is proven against Uniswap's `SqrtPriceMath` in
  [`test/EdgeMath.t.sol`](test/EdgeMath.t.sol) (`testFuzz_rebalancingLoss_matchesInventoryIdentity`)

## Run it

```bash
git clone --recurse-submodules https://github.com/Abhist17/ukiyo && cd ukiyo
forge build
forge test                          # 32 tests: unit, fuzz, integration, differential
forge test --match-test test_gas -vv
```

`forge test --gas-report` runs each call as an isolated transaction, and Foundry's `vm.txGasPrice` cheat does not carry
into it, so swaps there are all classified as user flow. Use `test_gas_swapPath` for gas numbers.

Backtest:

```bash
cd backtest && pip install -r requirements.txt
python fetch_data.py && python experiments.py && python scorecard.py
```

### Tests

| Suite | What it proves |
| --- | --- |
| `EdgeMath.t.sol` | The closed-form loss equals the exact holding-vs-position gap from Uniswap's amount math (1,024 fuzz runs); fee attribution matches `SqrtPriceMath`; credits never exceed losses |
| `UkiyoHook.t.sol` | Against the canonical PoolManager bytecode: pool binding, hook-only liquidity, access control, classification, fee attribution matching the PoolManager's own fee growth, marks, loss, impact, round-trip immunity, anchors on range change, and a differential fuzz test where every ledger field equals an independent replay of random blocks of swaps |

### Gas (two sleeves, measured inside one test transaction)

| Path | Gas, including the PoolManager swap |
| --- | --- |
| First swap of a block | ~143k |
| Later swap in the same block | ~75k |

## Judging criteria map

| Criterion (weight) | Where to look |
| --- | --- |
| Original Idea (30%) | The decomposition `LVR_true ≈ LVR_pool + arbitrage fees` and a curator benchmark built on it; no other hook measures curator skill against LVR |
| Unique Execution (25%) | Two marks per block, a priority-fee classifier and exact per-sleeve fee attribution, all inside the hook with no oracle |
| Impact (20%) | Any curator vault can adopt the meter as its scoring and performance-fee standard |
| Functionality (15%) | 32 passing tests including a differential fuzz test; backtest on real prices |
| Presentation (10%) | Demo video (≤ 5 min) |

## Partner integrations

No partner integrations.

## Status

- [x] Backtest: equation derived and validated (synthetic + BTC/USD 2024)
- [x] Phase 1: LVR meter hook, EdgeMath, tests
- [ ] Phase 2: curator vaults, Edge-based performance fee, LVR bond
- [ ] Phase 3: leaderboard frontend, replay demo on Unichain Sepolia

### Known limitations

- Liquidity and range changes take effect immediately, so the block in which a sleeve changes is measured with its new
  shape (bounded to one block for one sleeve).
- Fee attribution assumes no protocol fee.
- Classifier accuracy on real Unichain flow is not yet measured; the threshold is owner-set.
- Unaudited hackathon code.

## Credits

- [OpenZeppelin Uniswap Hooks](https://github.com/OpenZeppelin/uniswap-hooks): `BaseHook`, `CurrencySettler`
- [Uniswap v4-core](https://github.com/Uniswap/v4-core): libraries and the `PoolSwapTest` / `PoolModifyLiquidityTest`
  test routers
- [hookmate](https://github.com/akshatmittal/hookmate): canonical PoolManager bytecode for tests
- Project layout follows [Uniswap/v4-template](https://github.com/Uniswap/v4-template)
- Price data: [ff137/bitstamp-btcusd-minute-data](https://github.com/ff137/bitstamp-btcusd-minute-data)
- Theory: Milionis, Moallemi, Roughgarden, Zhang, *Automated Market Making and Loss-Versus-Rebalancing* (2022);
  Milionis, Moallemi, Roughgarden, *Automated Market Making and Arbitrage Profits in the Presence of Fees* (2023);
  Robinson and White, *Priority Is All You Need* (Paradigm, 2024)

## License

MIT
