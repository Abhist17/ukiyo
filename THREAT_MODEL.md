# Ukiyo threat model

What each actor can and cannot do to the hook ([`UkiyoHook`](src/UkiyoHook.sol)) and the curator vaults
([`UkiyoVault`](src/UkiyoVault.sol)), what protects against it, and what is left open. Unaudited hackathon code.

## Assets

1. **Depositors' tokens** in a vault: idle tokens, the sleeve's liquidity in the PoolManager, and escrowed requests.
2. **The curator's bond** (token1).
3. **The scoreboard:** each sleeve's ledger and Edge. Fees and bond penalties are computed from it, so a wrong Edge
   moves money.

## Actors and what they control

| Actor | Can | Cannot |
| --- | --- | --- |
| Hook owner | Open sleeves (≤ 8), hand each to a manager once, name the launcher (factory), lower `priorityFeeThreshold` at once or queue a raise (2-day delay) | Touch a sleeve after hand-over (`setSleeveManager` is one-way), move any vault's tokens |
| Curator | Move its sleeve's range (`rebalance`, or `rebalanceWithSwap` with a swap bounded to a 1% price move), post and withdraw its bond, set its LVR budget | Take depositors' tokens (removed liquidity always returns to the vault), withdraw bond before the next settlement, change the budget for the current epoch, raise the fee above its immutable value |
| Depositor | Request deposits and redemptions, cancel an unsettled deposit, claim payouts and refunds, settle a finished epoch | Enter or leave mid-epoch, claim more than its pro-rata share |
| Swapper or arbitrageur | Trade in the pool, choose its priority fee | Add or remove liquidity (the pool is hook-exclusive; `beforeAddLiquidity` and `beforeRemoveLiquidity` reject everyone but the hook) |
| Anyone | Call `settleEpoch` once an epoch is over; launch a vault through the factory with a bond; add to any curator's bond | Settle early; launch a vault without the factory's depositor protections; touch another curator's sleeve |

## Threats and mitigations

### Scoreboard (Edge)

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Arbitrage booked as user flow inflates Edge (and the curator's fee) | Rule: when in doubt, call it arbitrage; recommended threshold is 1 wei | **Open.** On real Unichain flow ~7% of informed swaps pay no tip ([measured](README.md#does-the-priority-fee-identify-arbitrage-on-unichain-measured-not-assumed)). The classifier is only as good as priority ordering |
| Owner raises the threshold so every swap counts as user flow, inflating every curator's Edge and fees | A raise waits `THRESHOLD_RAISE_DELAY` (2 days, longer than any epoch), so depositors can leave first; lowering (stricter) applies at once (`test_thresholdRaisesWaitAndLoweringIsImmediate`) | The owner still chooses the threshold; a malicious owner can raise it after the delay |
| Same-block round trips farm the impact credit | Impact is credited per block from the block's close, net, so a same-block round trip earns nothing (`test_sameBlockRoundTripEarnsNoImpact`) | None known |
| A curator dodges arbitrage loss by changing range just before a move | The hook anchors liquidity at the price it is added at, so a re-ranged sleeve is measured from there | Bounded to one block per change for that sleeve; each rebalance costs ~369k gas |
| Liquidity added right after user flow (a deposit settling, timed by anyone) is credited with that flow's impact | Added liquidity is anchored at the price it joins at and measured from there until the next mark; only liquidity present at the mark is credited for the block's impact (`test_addedLiquidityIsMeasuredFromWhereItJoined`, and the differential fuzz test adds and removes liquidity at random points) | Liquidity removed between marks skips that block's partial move, credit and charge alike |
| A curator pushes the price with an untipped swap from another address, then reverts it as the next block's first swap, so its sleeve is credited the push's impact at the cost of two fees | Reverting the push is an arbitrage worth about the impact credited to the whole pool, so arbitrageurs compete for that top-of-block slot: winning it means bidding about that much in priority fees, which costs more than the 20% maximum performance fee the inflated Edge could earn | **Open** where the top-of-block slot is not competitive (thin or new pools); only a better classifier closes it |
| A curator trades its own vault's tokens with no tip so the hook credits its sleeve with the swap's fee and impact | Swaps sent by a sleeve manager are always arbitrage (`isSleeveManager`; `test_vaultSwapIsBookedAsArbitrage`) | None known |
| A curator uses `rebalanceWithSwap` to push the price and hurt other sleeves' Edge | The swap's price limit caps the move at 1%, and the vault pays the swap's fee and impact itself | A manager swap that leads a block becomes the mark, so others are charged for that move; bounded and costly |
| A protocol fee switched on later makes fees overstated | Fee attribution reads the pool's protocol fee for each swap's direction and books only the LPs' part, exactly as `Pool.swap` splits it (`test_feeAttributionMatchesPoolManagerWithProtocolFee`) | None known |
| Rounding overstates Edge | Losses round up, credits and fees round down; `edgePerShare` floors | None known |

### Open launches

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| A launch installs a fake vault that skips the depositor protections | The factory deploys only code hashing to `UkiyoVault`'s creation code, and checks epoch length, probation and bond (`test_launchRejectsOtherCode`, `test_launchEnforcesDepositorProtections`) | None known |
| The launcher (factory) takes over existing sleeves | `launchSleeve` only opens a new sleeve and hands over that one; the hand-over is one-way | The owner chooses the launcher |
| Someone fills the hook's eight sleeve slots | Each launch posts a permanent bond of at least `minLaunchBond` | **Open in part.** Slots are finite; a well-funded actor can still fill them, at a cost locked for good |
| A curator on a losing streak keeps trading depositors' capital | Probation: an Edge-index drawdown past `probationBps` blocks rebalancing for three epochs (`test_probationStopsALosingCurator`; invariant `invariant_probationBounded`) | The vault holds its range while on probation; it does not exit |
| The curator withdraws its whole bond | Withdrawals stop at `minBond` (`test_minBondCannotBeWithdrawn`) | None known |
| A lucky streak is read as skill | `edgeTStat`: the t-statistic of per-epoch Edge returns, rounded down, with skill only at t ≥ 2 | A t-test assumes epochs are roughly independent |

### Vault funds

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| First-depositor share inflation | 1,000 dead shares on the first mint; a deposit minting zero shares is refunded | None known |
| Deposit priced off a manipulated pool price | Deposits are proportional to the vault's holdings (no price used); moving the price means trading against the sleeve | The token mix a depositor gets can be skewed; the value cannot |
| Entering before fees are collected and leaving right after | Entries and exits settle only at epoch boundaries, after fee collection | None known |
| Curator drains the vault through the hook | Only the vault (the sleeve's manager) can move the sleeve, and the hook pays removals to the caller, which is the vault | None known |
| Reentrancy | All state-changing vault functions are `nonReentrant`; the only external calls are the trusted hook, the PoolManager and the two tokens | Fee-on-transfer, rebasing or callback tokens are unsupported |
| Griefing the deposit queue | At most 32 new depositors per epoch, and each must bring at least 0.01% of the vault's holdings of one token (`MIN_DEPOSIT_BPS`, no price needed; `test_dustCannotFillTheQueue`) | Filling all 32 slots ties up ~0.32% of the vault's holdings for an epoch (refundable), so a large holder could still delay others by one epoch |
| Insolvency | Fuzz test `testFuzz_alwaysSolvent`: balance ≥ reserved + bond after any mix of deposits, swaps and redemptions | None known |

### Fees and bond

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Curator paid for Edge it did not earn | Fee only on `edgePerShare` above a high-water mark; losses must be earned back first; fee capped at 20% | Inherits the classifier's error |
| Settler moves the spot price to change the fee's share count or the bond budget | Both use `valueAtMark()`: the position valued at the hook's post-arbitrage mark, not spot | The mark is set by the first swap of the block; a curator who outbids arbitrageurs for that slot can nudge it, paying impact against every sleeve |
| Curator pulls the bond before a bad epoch settles | Withdrawals are paid only at the next settlement, after its penalty | None known |
| Curator raises the budget to escape a penalty | Budget changes apply from the next epoch | None known |

## Out of scope

- The demo's test tokens (anyone can mint) and swap router (v4-core's `PoolSwapTest`): demo infrastructure, not part of
  the protocol.
- Native-currency pools: vaults reject them at construction.
