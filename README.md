<p align="center"><img src="assets/logo.svg" width="96" alt="Ukiyo logo: a vermilion sun over a navy sea, drawn as a coin"></p>

<h1 align="center">Ukiyo 浮世</h1>

<p align="center"><b>An honest scoreboard for curated liquidity on Uniswap v4.</b></p>

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
| [`src/UkiyoVault.sol`](src/UkiyoVault.sol) | One curator vault per sleeve: two-token deposits, ERC-20 shares, entries and exits settled at epoch boundaries, curator rebalancing |
| [`src/libraries/EdgeMath.sol`](src/libraries/EdgeMath.sol) | Closed forms: rebalancing loss, impact credit, per-sleeve swap fee, clipping |

### Key lines

- Classification: `_beforeSwap` and `isArbitrage()` in [`UkiyoHook.sol`](src/UkiyoHook.sol)
- Arbitrage loss: `_chargeArbitrageLoss`; impact credit: `_creditImpact`; fees: `_attributeFees`
- The identity the meter relies on is proven against Uniswap's `SqrtPriceMath` in
  [`test/EdgeMath.t.sol`](test/EdgeMath.t.sol) (`testFuzz_rebalancingLoss_matchesInventoryIdentity`)

## Curator vaults

Each sleeve is run by a [`UkiyoVault`](src/UkiyoVault.sol). The hook owner hands the sleeve to its vault once
(`setSleeveManager`); from then on only the vault can move the sleeve's liquidity or range, and the owner has no way
back in. Removals pay the caller, so an owner who could re-point the manager could drain the vault.

| Step | Who | What |
| --- | --- | --- |
| `requestDeposit(amount0, amount1)` | depositor | Escrows both tokens for the end of the epoch; `cancelDeposit` takes them back until then |
| `requestRedeem(shares)` | holder | Hands shares to the vault for the end of the epoch |
| `settleEpoch()` | anyone, after `epochLength` | Collects the sleeve's fees, pays redemptions, mints deposits, deploys idle tokens, and records the Edge the sleeve earned that epoch |
| `claimRedemption(epoch)`, `claimRefund()` | user | Withdraws redemption payouts and the parts of deposits that did not fit |
| `rebalance(tickLower, tickUpper)` | curator only | Moves the range and redeploys; the hook anchors the new range at the current price |

- **Epochs.** Entries and exits settle in batches at the boundary, so the share price is fixed within an epoch. The
  Edge recorded for an epoch belongs to exactly the shares that held it, and no one can enter just before fees are
  collected and leave right after.
- **No oracle.** A deposit buys the same fraction of every token the vault holds, like a Uniswap v2 mint, and the rest
  is refunded. A redemption takes its fraction of the position's liquidity and of the idle tokens. Moving the pool
  price to game a deposit means trading against the sleeve, which leaves it worth more at the true price.
- **Rounding favours the vault.** 1,000 dead shares are minted on the first mint, and a deposit that would mint zero
  shares is refunded, so the share price cannot be inflated.
- **The curator cannot take funds.** Liquidity removed through the hook is always paid to the vault.

## Scoreboard site

[`web/`](web/) is the scoreboard frontend: Next.js, built as a static site. It shows the BTC/USD 2024 replay from the
backtest. [`backtest/export_web.py`](backtest/export_web.py) copies the backtest's weekly numbers into
`web/src/data/btc2024.json` without recomputing anything, so the site and the backtest always agree.

![Same curators, five rankings: only Ukiyo Edge puts them in the order of their true hedged P&L](assets/rankings.png)

- **Leaderboard:** curators ranked by Edge, next to true hedged P&L, fee income, beat-HODL and the naive formula, each
  with the rank it would give.
- **Rank shift:** the same six curators under five yardsticks. Only Edge and the truth run flat.
- **Year chart:** running Edge per curator with the true P&L dashed beneath it and the BTC price below, with a hover
  readout and a table view.
- **Method:** the four hook steps and the `LVR_true ≈ LVR_pool + arbitrage fees` decomposition, measured.

```bash
cd web && npm ci && npm run dev     # http://localhost:3000
npm run build                       # static site in web/out
```

## Does the priority fee identify arbitrage on Unichain? (measured, not assumed)

The classifier assumes arbitrageurs bid higher priority fees than users. We checked that on real flow:
[`backtest/priority_fees.py`](backtest/priority_fees.py) samples 14 windows of 600 blocks spread over the 7 days before
Unichain block 64,432,466 (20 Nov 2026) and reads all **6,714 v4 swaps** in them (97 pools). For each swap it records
the tip actually paid (base fee sat at its 500,000 wei floor) and labels the swap without looking at the tip:

- **Informed or not, by markout.** The pool's own price 60 s later is compared with the swap's execution price, fee
  included. If the trader is in profit, the swap was informed and its fee comes back to the LPs as LVR. This is
  exactly the flow Ukiyo must call arbitrage. Measured in the 19 pools with ≥ 50 swaps (5,036 swaps).
- **Router or bot,** by whether the transaction calls a source-verified contract (Universal Router, aggregators) or
  an unverified one (searchers).

**Result: on Unichain today, no threshold separates informed from uninformed flow.**

| Rule `arbitrage iff tip ≥ T` | T = 1 wei | T = 100,000 | T = 1,000,000 | T = 1,500,000 |
| --- | --- | --- | --- | --- |
| Informed swaps called user (overstates Edge) | 7.5% | 17.9% | 31.3% | 64.5% |
| Uninformed swaps called arbitrage (understates Edge) | 93.9% | 73.3% | 57.7% | 28.6% |
| Same, 5 bps pools only: informed called user | 6.4% | 18.7% | 37.8% | 52.5% |

- Tips cluster around wallet defaults, not around who is informed. Median tip is 1,450,000 wei for informed swaps
  and 1,000,001 for uninformed ones. 45% of zero-tip swaps are informed.
- Router flow is *more* informed than bot flow (52% vs 34% at 60 s). The Universal Router's 1,515 swaps came from 9
  addresses, one of them sending 71%, so automated traders use public routers too.
- The first swap of a block is barely more informed than later ones (41% vs 37%), so priority ordering has not
  produced a clean "arbitrage at the top of the block" pattern on Unichain.

**Recommended setting, and what it means.** `priorityFeeThreshold = 1` wei: any swap that pays a tip at all is
arbitrage. This is the lowest setting that still counts some user fees (0 calls every swap arbitrage). On real Unichain flow that misses ~7% of informed swaps. The
backtest only validated classifiers that miss at most 3% (and at 3% it already overstated Edge in 36% of weeks on a 5
bps pool), so **the tip classifier on its own is not yet trustworthy on mainnet flow**. In the Ukiyo demo the replay bot's
arbitrageur bids priority by construction, so the demo shows the mechanism working, not this question answered. Raw rows (with tx hashes),
contract labels and the summary are in [`backtest/results/`](backtest/results/).

**Could the hook classify after the fact instead?** We tested that too
([`backtest/markout_classifier.py`](backtest/markout_classifier.py)). Each swap waits for the next block's
post-arbitrage mark and is classified then. The results are fee-weighted, on 3 × 26 synthetic weeks of a 5 bps pool:

| Classifier | Arbitrage fees booked as user | User fees booked as arbitrage | Curator pairs ordered right, same week | Weeks overstated |
| --- | --- | --- | --- | --- |
| Priority fee, arbitrage bids for priority (no error) | 0% | 0% | 99.4% | 1% |
| Priority fee, error rates measured on Unichain (T = 1) | 7% | 94% | 51.5% | 0% |
| Ex post: trader in profit at the next mark | 63% | 4% | 75.1% | 100% |
| Ex post: same, mark pushed one fee-width (band) | 26% | 43% | 97.0% | 45% |
| Ex post: next mark reverts past the swap's start | 0.9% | 71% | 66.2% | 0% |

No ex-post rule beats a working priority-fee classifier. Profit at the pool's next mark misses most arbitrage,
because an arbitrage stops one fee-width short of the external price. The band version overstates Edge in 45% of
weeks, which breaks Ukiyo's rule that Edge is never overstated, and it collapses on 30 bps pools (correlation 0.12).
The "reverted" rule never overstates but drops most user fees. So the hook keeps the priority-fee classifier: it is the
right rule wherever arbitrage competes on priority, With the error rates measured on today's Unichain flow,
Edge on a 5 bps pool is understated (never overstated in the backtest) but orders curators poorly; on 30 bps pools it
overstates in 25% of weeks.

## Run it

```bash
git clone --recurse-submodules https://github.com/Abhist17/ukiyo && cd ukiyo
forge build
forge test                          # 51 tests: unit, fuzz, integration, differential
forge test --match-test test_gas -vv
```

`forge test --gas-report` runs each call as an isolated transaction, and Foundry's `vm.txGasPrice` cheat does not carry
into it, so swaps there are all classified as user flow. Use `test_gas_swapPath` for gas numbers.

Backtest:

```bash
cd backtest && pip install -r requirements.txt
python fetch_data.py && python experiments.py && python scorecard.py
python priority_fees.py --head 64432466   # Unichain tip measurement (stdlib only, ~3 min, public RPC)
python markout_classifier.py               # priority-fee vs ex-post classifiers (~2 min)
python export_web.py                       # refresh the site's data after experiments.py
```

### Tests

| Suite | What it proves |
| --- | --- |
| `EdgeMath.t.sol` | The closed-form loss equals the exact holding-vs-position gap from Uniswap's amount math (1,024 fuzz runs); fee attribution matches `SqrtPriceMath`; credits never exceed losses |
| `UkiyoHook.t.sol` | Against the canonical PoolManager bytecode: pool binding, hook-only liquidity, access control, classification, fee attribution matching the PoolManager's own fee growth, marks, loss, impact, round-trip immunity, anchors on range change, `sleeveAmounts` equal to a full withdrawal to the wei, and a differential fuzz test where every ledger field equals an independent replay of random blocks of swaps |
| `UkiyoVault.t.sol` | On a 5 bps pool: one-time hand-over that locks the owner out, epoch gating, first-mint shares and dead shares, proportional deposits with refunds, pro-rata redemptions, fees reaching shareholders, per-epoch Edge snapshots, curator-only rebalancing, the depositor cap, and fuzz tests that a deposit-redeem round trip never pays out more than went in and that the vault always holds what it owes |

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
| Functionality (15%) | 51 passing tests (10,000 fuzz runs each in CI) including a differential fuzz test; curator vaults; backtest on real prices; classifier measured on real Unichain swaps |
| Presentation (10%) | Scoreboard site ([`web/`](web/)), seal logo, demo video (≤ 5 min) |

## Partner integrations

No partner integrations.

## Status

- [x] Backtest: equation derived and validated (synthetic + BTC/USD 2024)
- [x] Phase 1: LVR meter hook, EdgeMath, tests
- [x] Priority fees measured on real Unichain swaps; ex-post classifiers backtested
- [x] Phase 2a: curator vaults (two-token deposits, ERC-20 shares, epoch settlement)
- [ ] Phase 2b: Edge-based performance fee, LVR bond
- [x] Scoreboard site on backtest data, logo
- [ ] Phase 3: live on-chain leaderboard, replay demo on Unichain Sepolia

### Known limitations

- Liquidity and range changes take effect immediately, so the block in which a sleeve changes is measured with its new
  shape (bounded to one block for one sleeve).
- Fee attribution assumes no protocol fee.
- On real Unichain flow the priority fee does not separate informed from uninformed swaps: even at 1 wei, ~7% of
  informed swaps are called user flow (see the measurement above). The threshold is owner-set.
- Vaults support ERC-20 pairs only: no native ETH, no fee-on-transfer or rebasing tokens.
- A vault never swaps. When a new range needs a different token mix, what does not fit stays idle; it still counts
  toward every share but earns no fees until the price or the range lets it in.
- At most 32 new depositors per epoch, to bound the settlement loop; the rest wait for the next epoch.
- Unaudited hackathon code.

## Credits

- [OpenZeppelin Uniswap Hooks](https://github.com/OpenZeppelin/uniswap-hooks): `BaseHook`, `CurrencySettler`
- [Uniswap v4-core](https://github.com/Uniswap/v4-core): libraries and the `PoolSwapTest` / `PoolModifyLiquidityTest`
  test routers
- [hookmate](https://github.com/akshatmittal/hookmate): canonical PoolManager bytecode for tests
- Project layout follows [Uniswap/v4-template](https://github.com/Uniswap/v4-template)
- Site: [Next.js](https://nextjs.org) and React; fonts Shippori Mincho, Inter and JetBrains Mono from Google Fonts
- Price data: [ff137/bitstamp-btcusd-minute-data](https://github.com/ff137/bitstamp-btcusd-minute-data)
- Unichain swap data: the public RPC `mainnet.unichain.org`; contract verification labels from the
  [Blockscout](https://unichain.blockscout.com) API
- Theory: Milionis, Moallemi, Roughgarden, Zhang, *Automated Market Making and Loss-Versus-Rebalancing* (2022);
  Milionis, Moallemi, Roughgarden, *Automated Market Making and Arbitrage Profits in the Presence of Fees* (2023);
  Robinson and White, *Priority Is All You Need* (Paradigm, 2024)

## License

MIT
