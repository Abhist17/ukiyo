# Security

Unaudited hackathon code on a testnet. [`THREAT_MODEL.md`](THREAT_MODEL.md) sets out every actor's powers and what
is still open. Below: every finding from our own reviews, the fix, and the test that fails without it.

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| High | Push the price, settle a vault (anyone can) or rebalance so the batch's capital is added at it, push back and keep the difference | `settleEpoch`, `rebalance` and `rebalanceWithSwap` revert unless spot is within 1% of `referenceSqrtPrice`, a mark the transaction cannot set; `valueAtMark` uses it too | `test_settleAndRebalanceRefuseAManipulatedPrice`, `test_referencePriceIsAMarkThisTransactionCannotSet` |
| Medium | Liquidity added between marks (every epoch's deposits) was credited with user impact from before it existed, overstating Edge | Added liquidity is anchored at the price it joins at (`anchoredLiquidity`) | `test_addedLiquidityIsMeasuredFromWhereItJoined`, differential fuzz with random liquidity changes |
| Medium | Request-and-cancel loops could fill an epoch's 32 deposit slots for free | `cancelDeposit` frees the slot; the minimum must be met in a token the vault holds | `test_cancelFreesTheDepositSlot`, `test_minimumIsMetInAHeldToken` |
| Medium | Tokens sent to a vault mid-epoch and deployed by a rebalance earned Edge the epoch's return divided by smaller capital, inflating the Edge index and skill test | Mid-epoch redeploys are capped at the epoch's starting capital | `test_midEpochRebalanceDeploysNoMoreThanTheEpochsCapital` |
| Medium | A vault epoch longer than the threshold-raise delay would let a raised threshold apply before depositors could leave | Epochs must be shorter than `THRESHOLD_RAISE_DELAY` | `test_epochMustBeShorterThanTheThresholdDelay` |
| Medium | A curator could trade its own vault's tokens without a tip and be credited with the swap's fee and impact | A sleeve manager's swaps are always arbitrage | `test_vaultSwapIsBookedAsArbitrage` |
| Medium | A tipped push and a tipped push back made every sleeve's Edge read two arbitrage moves worse though LPs earned fees: cheap griefing of rivals, with leverage growing with the push | Spike-netted marks (backtested before shipping; netting every reversal was rejected because it overstates) | `test_spikePushedBackIsChargedOnce`, `test_smallReversalsAreChargedInFull`, `test_spikeIsNotNettedAcrossALiquidityChange`, differential fuzz |
| Low | Anyone could initialize a pool with a freshly deployed hook before the owner and leave it bound to that pool | Only the owner may initialize | `test_onlyOwnerInitializesThePool` |
| Low | A protocol fee switched on later would have overstated LP fees | Fee attribution reads the protocol fee and books only the LPs' part, as `Pool.swap` does | `test_feeAttributionMatchesPoolManagerWithProtocolFee`, `testFuzz_lpFeeRate_withProtocolFee` |
| Low | First-depositor share inflation | 1,000 dead shares on the first mint | `test_firstDepositMintsLiquidityAsShares` |

## Open, and documented

- Tipped push-and-revert swaps smaller than 8 fee-widths still make in-range sleeves' Edge read lower than it is
  (Edge errs low, never high), by at most about 4× what the attacker pays. Larger spikes are netted since 25 Nov.
- A curator can remove and re-add liquidity between a block's user flow and the next arbitrage to re-anchor it,
  lowering one block's booked loss.
- The priority-fee classifier misses about 7% of informed swaps on real Unichain flow.

Details and numbers in [`THREAT_MODEL.md`](THREAT_MODEL.md).
