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
| Owner raises the threshold so every swap counts as user flow, inflating every curator's Edge and fees | A raise waits `THRESHOLD_RAISE_DELAY` (2 days), and every vault's epoch must be shorter than that delay (`EpochTooLong`, `test_epochMustBeShorterThanTheThresholdDelay`), so depositors can always leave first; lowering (stricter) applies at once (`test_thresholdRaisesWaitAndLoweringIsImmediate`) | The owner still chooses the threshold; a malicious owner can raise it after the delay |
| Same-block round trips farm the impact credit | Impact is credited per block from the block's close, net, so a same-block round trip earns nothing (`test_sameBlockRoundTripEarnsNoImpact`) | None known |
| A curator dodges arbitrage loss by changing range just before a move | The hook anchors liquidity at the price it is added at, so a re-ranged sleeve is measured from there | **Open in part.** A curator can remove and re-add its liquidity (`rebalance`, even with the same ticks) after user flow and before the next block's arbitrage, so the removed segment is neither credited nor charged. When flow moved the pool toward where arbitrage then takes it, that lowers the loss booked for one block. Bounded per block, but repeatable; each rebalance costs ~386k gas. A fix would charge removed liquidity its partial move as arbitrage loss |
| Liquidity added right after user flow (a deposit settling, timed by anyone) is credited with that flow's impact | Added liquidity is anchored at the price it joins at and measured from there until the next mark; only liquidity present at the mark is credited for the block's impact (`test_addedLiquidityIsMeasuredFromWhereItJoined`, and the differential fuzz test adds and removes liquidity at random points) | Liquidity removed between marks skips that block's partial move, credit and charge alike |
| A curator pushes the price with an untipped swap from another address, then reverts it as the next block's first swap, so its sleeve is credited the push's impact at the cost of two fees | Reverting the push is an arbitrage worth about the impact credited to the whole pool, so arbitrageurs compete for that top-of-block slot: winning it means bidding about that much in priority fees, which costs more than the 20% maximum performance fee the inflated Edge could earn | **Open** where the top-of-block slot is not competitive (thin or new pools); only a better classifier closes it |
| A curator trades its own vault's tokens with no tip so the hook credits its sleeve with the swap's fee and impact | Swaps sent by a sleeve manager are always arbitrage (`isSleeveManager`; `test_vaultSwapIsBookedAsArbitrage`) | None known |
| A curator uses `rebalanceWithSwap` to push the price and hurt other sleeves' Edge | The swap's price limit caps the move at 1%, and the vault pays the swap's fee and impact itself | A manager swap that leads a block becomes the mark, so others are charged for that move; bounded and costly |
| A protocol fee switched on later makes fees overstated | Fee attribution reads the pool's protocol fee for each swap's direction and books only the LPs' part, exactly as `Pool.swap` splits it (`test_feeAttributionMatchesPoolManagerWithProtocolFee`) | None known |
| Anyone makes a rival's Edge read as a loss: a tipped swap leads one block, a tipped swap back leads the next | Both are booked as arbitrage, so marks go P → P' → P and every in-range sleeve is charged arbitrage loss for both moves, though its LPs earned fees on the round trip. Edge errs low, never high Spike-netted marks: a move wider than `SPIKE_FEE_WIDTHS` (8) fee-widths that the next mark reverses by as much is charged as the single move around it (`test_spikePushedBackIsChargedOnce`; differential fuzz). Backtested: Edge keeps 0.9988 correlation with true hedged P&L on BTC 2024 and still errs low | **Bounded.** Pushes below the threshold are still charged twice, but hurt a rival's Edge by at most about 4× what they cost in fees (was unbounded: about 20× for a 1% push, 50× for 5%) |
| Tokens sent to a vault mid-epoch earn Edge that the epoch's return divides by the smaller starting capital, inflating `edgeIndex` and the skill test | A mid-epoch `rebalance` redeploys at most the capital the epoch started with (valued at the reference price); anything more waits, idle, for the next settlement (`test_midEpochRebalanceDeploysNoMoreThanTheEpochsCapital`) | None known |
| Someone initializes a pool of their own with a freshly deployed hook, before the owner does, leaving it bound to that pool | Only the owner may initialize the hook's pool (`NotOwnerInitialize`, `test_onlyOwnerInitializesThePool`) | None known |
| Rounding overstates Edge | Losses round up, credits and fees round down; `edgePerShare` floors | None known |

### Open launches

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| A launch installs a fake vault that skips the depositor protections | The factory deploys only code hashing to `UkiyoVault`'s creation code, and checks epoch length, probation and bond (`test_launchRejectsOtherCode`, `test_launchEnforcesDepositorProtections`) | None known |
| The launcher (factory) takes over existing sleeves | `launchSleeve` only opens a new sleeve and hands over that one; the hand-over is one-way | The owner chooses the launcher |
| Someone fills the hook's eight sleeve slots | Each launch posts a permanent bond of at least `minLaunchBond` | **Open in part.** Slots are finite; a well-funded actor can still fill them. A curator that is also its vault's only depositor can recover the bond: grief its own Edge (below) until penalties move the bond into the vault, then redeem |
| A curator on a losing streak keeps trading depositors' capital | Probation: an Edge-index drawdown past `probationBps` blocks rebalancing for three epochs (`test_probationStopsALosingCurator`; invariant `invariant_probationBounded`) | The vault holds its range while on probation; it does not exit |
| The curator withdraws its whole bond | Withdrawals stop at `minBond` (`test_minBondCannotBeWithdrawn`) | None known |
| The skill router keeps or misroutes deposits | It never holds capital: slices are escrowed in the depositor's name (`requestDepositFor`), refused slices and rounding dust are returned in the same transaction, and only the deployment's own and factory-launched vaults are eligible (`test_routerReturnsRefusedSlices`, `test_routerRejectsBadLists`) | None known |
| A curator games the skill test to attract routed deposits | Weights use the same Edge as everything else, capped at t = 10, and nothing goes to a curator on probation | Inherits Edge's residual risks (the classifier, cross-block self-trades) |
| A lucky streak is read as skill | `edgeTStat`: the t-statistic of per-epoch Edge returns, rounded down, with skill only at t ≥ 2 | A t-test assumes epochs are roughly independent |

### Vault funds

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| First-depositor share inflation | 1,000 dead shares on the first mint; a deposit minting zero shares is refunded | None known |
| Deposit priced off, or capital added at, a manipulated pool price: push the price, settle (anyone can) or rebalance so the batch's capital is added at it, push back and keep the difference | `settleEpoch`, `rebalance` and `rebalanceWithSwap` revert unless spot is within 1% of the hook's `referenceSqrtPrice`, a post-arbitrage mark the current transaction cannot have set (within a marked block, the mark before it) (`test_settleAndRebalanceRefuseAManipulatedPrice`, `test_referencePriceIsAMarkThisTransactionCannotSet`). Deposits are also proportional to holdings, so no price is used to price them | Manipulation across blocks needs the price held off-market through a block boundary, against arbitrageurs bidding for the top of the next block |
| Entering before fees are collected and leaving right after | Entries and exits settle only at epoch boundaries, after fee collection | None known |
| Curator drains the vault through the hook | Only the vault (the sleeve's manager) can move the sleeve, and the hook pays removals to the caller, which is the vault | None known |
| Reentrancy | All state-changing vault functions are `nonReentrant`; the only external calls are the trusted hook, the PoolManager and the two tokens | Fee-on-transfer, rebasing or callback tokens are unsupported |
| Griefing the deposit queue | At most 32 new depositors per epoch; cancelling frees the slot, so request-and-cancel loops cost nothing but also block nothing (`test_cancelFreesTheDepositSlot`); each request must bring at least 0.01% of the vault's holdings of a token the vault actually holds (`test_minimumIsMetInAHeldToken`) | Filling all 32 slots ties up ~0.32% of the vault's holdings for an epoch (refundable), so a large holder could still delay others by one epoch |
| Insolvency | Fuzz test `testFuzz_alwaysSolvent`: balance ≥ reserved + bond after any mix of deposits, swaps and redemptions | None known |

### Fees and bond

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Curator paid for Edge it did not earn | Fee only on `edgePerShare` above a high-water mark; losses must be earned back first; fee capped at 20% | Inherits the classifier's error |
| Settler moves the spot price to change the fee's share count or the bond budget | Both use `valueAtMark()`, which values the position at `referenceSqrtPrice`, not spot, and settlement refuses an off-mark spot price | None known |
| Curator pulls the bond before a bad epoch settles | Withdrawals are paid only at the next settlement, after its penalty | None known |
| Curator raises the budget to escape a penalty | Budget changes apply from the next epoch | None known |

## Out of scope

- The demo's test tokens (anyone can mint) and swap router (v4-core's `PoolSwapTest`): demo infrastructure, not part of
  the protocol.
- Native-currency pools: vaults reject them at construction.
