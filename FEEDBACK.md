# Developer feedback on the Uniswap v4 stack

What we hit building Ukiyo, a hook that keeps a per-position ledger of fees, user price impact and arbitrage loss on
every swap. Each point names where it shows up in our code, and what would have helped.

## What worked well

- **Hook-owned liquidity through `unlock`.** Owning every position in the pool (salt = sleeve id), with
  `beforeAddLiquidity` / `beforeRemoveLiquidity` refusing everyone else, gave us a hook-exclusive pool in a few lines
  ([`src/UkiyoHook.sol`](src/UkiyoHook.sol), `unlockCallback`). This is the primitive that makes per-curator scoring
  possible at all.
- **Transient storage.** One swap's scratch state (price before the swap, its classification, whether it opens the
  block) lives in `transient` variables between `beforeSwap` and `afterSwap`. Cheap and clean.
- **`StateLibrary` reads.** `getSlot0` gives price and protocol fee in one `extsload`, which is all the hook needs to
  price a swap's LP fee exactly.
- **OpenZeppelin's `BaseHook`** removed the permission boilerplate, and `HookMiner` made the CREATE2 address step
  routine.

## Friction, and what would help

1. **`afterSwap` does not receive the price before the swap.** Every hook that measures a swap's price path has to read
   `slot0` in `beforeSwap` and carry it across in storage. Passing the pre-swap `sqrtPriceX96` (or the swap's
   start and end ticks) to `afterSwap` would remove a read and a class of bookkeeping bugs.

2. **No way to learn a position's share of a swap's fee inside the swap.** Fee growth is global per tick range, so a
   hook that wants each position's fee from one swap re-derives it from the price path and mirrors `Pool.swap`'s fee
   maths, protocol fee included (`EdgeMath.lpFeeRate`, `EdgeMath.swapFee`). We test it against the PoolManager's own
   fee growth to the wei, but a library function exposing "LP fee per unit of net input, given lp fee and protocol
   fee" would make this one call, and keep hooks correct if the formula ever changes.

3. **Block-level hooks.** Ukiyo marks the price after each block's first swap and credits the previous block's close
   on the next block's first swap, tracking `lastMarkedBlock` itself. A documented pattern (or library) for "first
   swap of the block" logic would help the many LVR-related hooks that need it, because every one of them is
   reimplementing it.

4. **Testing against the real PoolManager.** v4-core is compiled with via-IR and its own optimizer settings; a hook
   project compiling it with different settings tests against a PoolManager that is not the deployed one. We use
   hookmate's canonical bytecode (`V4PoolManagerDeployer`). Shipping canonical bytecode with v4-core's test utilities
   would make this the default.

5. **Foundry gas reports misclassify priority-fee logic.** `forge test --gas-report` runs each call as an isolated
   transaction and `vm.txGasPrice` does not carry into it, so any hook that reads `tx.gasprice` sees every swap as
   untipped. We measure gas inside one test instead (`test_gas_*`). Worth a note in the hook docs, since priority
   ordering is a selling point of Unichain.

6. **Unichain: tips do not identify arbitrage today.** We measured priority fees on 6,714 real Unichain v4 swaps
   (`backtest/priority_fees.py`): they cluster at wallet defaults rather than separating informed flow, so even a
   1 wei threshold misses about 7% of informed swaps. Hooks that rely on "arbitrage bids for the top of the block"
   should expect this until searchers tip competitively; data on tip distributions in the Unichain docs would help
   hook authors calibrate.

7. **Public RPC log limits.** The Unichain Sepolia public RPC caps `eth_getLogs` at 1,000 blocks, so a dApp reading a
   hook's history must chunk its requests ([`web/src/lib/logs.ts`](web/src/lib/logs.ts)). That is fine, but it is not
   documented next to the endpoint, and we found it by error message.

8. **Editor tooling.** The VS Code Solidity extension resolved v4-core imports differently from `forge` (it applied the
   last matching remapping and auto-detected remappings in nested packages), showing false errors in a project that
   builds cleanly. An explicit `remappings.txt` plus `auto_detect_remappings = false` fixed it; the v4-template could
   ship that way.
