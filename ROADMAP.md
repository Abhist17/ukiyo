# Roadmap: from hookathon to real users

Where Ukiyo stands, and the honest path from here to people trusting it with money. Each step says what it unlocks
and what it needs. Nothing below is built unless it says so.

## At submission (December 2026)

- **Built and live on Unichain Sepolia:** the hook, curator vaults (Edge-based fee, LVR bond, skill test, probation),
  open launches, the skill router, the Lens, the app, and a developer kit (TypeScript SDK and `ukiyo` CLI, its maths
  matching the contracts to the wei). 118 tests and 6 stateful invariants, a differential fuzz test
  against an independent model, a threat model, and backtests on BTC/USD 2024 and on four years of ETH/USDT.
- **Built since:** a per-vault deposit cap, which the factory can require of every launch (28 Nov; not yet deployed).
- **Not yet:** audited, on mainnet, or used by a real curator. The four curators on the live board are bots replaying
  2024 prices.
- **The main limit on adoption:** every scored curator must sit in Ukiyo's own hook-exclusive pool. A v4 hook is fixed
  when its pool is created, so existing pools and the vaults on them cannot be scored on-chain without moving.

## 1. An off-chain scoreboard for existing pools (no migration)

**What:** an indexer that computes Edge for any existing Uniswap v3 or v4 position from public chain data. The formula
needs only what is already on-chain: every swap's price path, its priority fee (`gasPrice - baseFee` from the
transaction), and its order in the block. Marks, impact credits, arbitrage loss and the spike rule are the same closed
forms as in `EdgeMath`.

**Unlocks:** ranking the curator vaults people already use, on mainnet, this month. No audit is needed, because it
holds no money. It is also the best way to win curators over: they see their own Edge before choosing to opt in
on-chain.

**Needs:** porting the hook's accounting to an indexer (the backtest's `sim.py` already implements it, and the SDK's
`math` module already has the closed forms in exact bigint, checked against the Solidity), and a public page per vault. The on-chain hook stays the version nobody has to trust.

## 2. Security review

**What:** run the standard static analysers and fix or document every finding; then apply to the Uniswap Foundation's
Security Fund for an independent review of the hook and vault, the path other UHI projects have taken.

**Unlocks:** the right to hold real money.

**Needs:** the review itself; every finding fixed with a regression test, as the existing test suite is already set up
for.

## 3. Guarded mainnet pilot on Unichain

**What:** one 5 bps ETH/USDC pool, a few invited curators, a deposit cap per vault, and the classifier threshold at
1 wei (what our measurement of real Unichain swaps recommends).

**Unlocks:** a real track record, which is the product: Edge and its skill test only mean something once real
curators have run for months.

**Needs:** curators willing to run in the pilot, and monitoring. The per-vault deposit cap is built (28 Nov):
`depositCap` in each vault's terms, and `maxDepositCap` on the factory so every open launch in the pilot must set one.
It is not yet deployed to the testnet.

## 4. Scoring positions in any Ukiyo pool, not just exclusive sleeves

**What:** today the hook loops over at most 8 sleeves on every swap. To score any number of positions in a pool that
anyone can provide liquidity to, accumulate Edge the way Uniswap accumulates fees: per unit of liquidity, per tick,
updated only when a swap crosses ticks (like `feeGrowthInside`). Each position then reads its own Edge when it changes,
and a swap's cost stops growing with the number of curators.

**Unlocks:** Ukiyo as a meter for open pools, with no cap on curators and the same per-swap cost as one.

**Needs:** research. Rebalancing loss is a square of the price move, not linear like fees, so it accumulates exactly
only within a tick range and needs care at range boundaries. This is the main open design problem, and the reason
today's version uses a small number of exclusive sleeves.

## 5. A better classifier as Unichain matures

**What:** Ukiyo classifies arbitrage by priority fee, and today about 7% of informed swaps on Unichain pay none. As
searchers compete for the top of the block, tips should separate arbitrage better; the threshold is owner-set, and
raising it waits two days. An ex-post check is already backtested in `markout_classifier.py`, and in our tests none
beat a working tip classifier.

**Unlocks:** Edge accurate enough for 30 bps pools, which need about 97% classifier accuracy (5 bps pools tolerate
about 25% error).

**Needs:** repeating the priority-fee measurement (`backtest/priority_fees.py`) as Unichain's flow changes.

## 6. Integrations

**What:** vault platforms and allocators reading Edge from `UkiyoLens` to rank curators, set fees, or route deposits
like `UkiyoSkillRouter` does; performance fees based on Edge for any vault that wants to pay only for skill.

**Unlocks:** Edge as a standard the market prices curators by, which is the point of the project.
