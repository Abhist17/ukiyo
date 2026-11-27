# ukiyo-sdk

TypeScript SDK and `ukiyo` CLI for [Ukiyo](../README.md), the Uniswap v4 hook that scores liquidity curators by
**Edge = user fees + user impact − arbitrage loss**.

- **Read the scoreboard** in one call, ranked by Edge, by size-neutral Edge index, by skill t-stat, or by fee income
  (to show where a fee-APR dashboard would mislead).
- **Explain a transaction**: how the hook booked each swap and why (tip vs threshold, or a vault trading for itself),
  what each sleeve earned from it, and the whole block's ledger change.
- **Edge over any period**, for paying or judging a curator without waiting for a vault epoch.
- **Watch live**: classifications, marks, netted spikes and each sleeve's Edge change, block by block. Polls with
  `eth_getLogs`, so it works on public RPCs without websockets or filters.
- **The hook's maths, to the wei**: `rebalancingLoss`, `impactCredit`, `swapFee`, `lpFeeRate`, `getSqrtPriceAtTick`
  as exact bigint ports, rounding included.

## Exact, and checked both ways

The SDK computes the same wei as the contracts, and two tests enforce it:

- `test/vectors.json` holds 400 random sleeves and moves (inside and outside ranges, ten fee settings) plus 127 ticks,
  with the SDK's outputs. [`test/EdgeMathVectors.t.sol`](../test/EdgeMathVectors.t.sol) replays every vector through
  the Solidity `EdgeMath` and v4 `TickMath`, and needs the same wei. The SDK's own test fails if the file is stale.
- On live Unichain Sepolia blocks, the per-swap fees `explain` computes add up exactly to the `userFees` and `arbFees`
  the hook booked for the block.

## CLI

```bash
cd sdk && npm install && npm run build
node dist/cli.js help            # or `npm link` once, then just `ukiyo`
```

```text
$ ukiyo scoreboard --rank fees
Ukiyo scoreboard · block 68914206 · 69,850.23 tUSD/tBTC · ranked by fee income · money in tUSD
#  Curator                          Edge  User fees      Impact    Arb loss   Arb fees   Index  t-stat  Fee rank
1  Ukiyo Tight Chaser ✓skill  +65,787.70  95,856.23  180,883.44  210,951.98  56,017.33  1.1085     3.0         1
…

$ ukiyo explain 0xa13a2dab…
  moved the price from 70,271.86 to 70,591.87 tUSD per tBTC; its tip of 0 gwei is below the 0.002 gwei
  threshold, so it is booked as user flow.
  It paid the sleeves 30.8437 tUSD in fees, which count toward their Edge.
  Over block 68914195 (with 2 other swaps), Edge changed by Ukiyo Tight Chaser +41.359 tUSD, …

$ ukiyo watch --edge
block 68914450  arb(0.006 gwei) user user  mark 68,161.08
    Ukiyo Tight Chaser     Edge −423.4081
    Ukiyo Vol Adaptive     Edge −74.0989

$ ukiyo cost --range 60000:80000 --from 70000 --to 70700
  If arbitrage made the move:   arbitrage loss 6.581512  (l·(c1 − c0)²/c0, rounded up)
  Half the move costs 1.649473: 3.99× less. The loss is quadratic in the move.
```

| Command | What it does |
| --- | --- |
| `scoreboard [--rank edge\|index\|tstat\|fees] [--block N]` | Every curator's ledger and Edge, ranked; flags where fee income ranks differently |
| `explain <txHash>` | Each swap's classification and why, fee per sleeve, and the block's bookings |
| `edge <sleeveId> --from N [--to N]` | Edge and its parts earned between two blocks |
| `watch [--edge]` | Live feed of blocks with swaps through the hook |
| `cost --range LO:HI --from P0 --to P1 [--liquidity L]` | What a price move costs a range, with the hook's exact formula |
| `info` | The deployment's contracts and settings |

Every command takes `--json` (bigints as strings), `--rpc`, `--chain`, `--hook` and `--lens`.

## Library

```ts
import { createPublicClient, http } from "viem";
import { unichainSepolia } from "viem/chains";
import { createUkiyo, rank, misranked, math } from "ukiyo-sdk";

const ukiyo = createUkiyo({ client: createPublicClient({ chain: unichainSepolia, transport: http() }) });

const board = await ukiyo.scoreboard();              // { pool, rows, token0, token1, blockNumber }
const best = rank(board.rows, "index")[0];           // size-neutral skill
const misleading = misranked(board.rows);            // where fee APR would rank a curator above its Edge

const period = await ukiyo.edgeBetween(2, 68_871_179n); // { userFees, userImpact, arbLoss, arbFees, edge }
const ex = await ukiyo.explain("0x…");                  // ex.narrative: plain sentences
const stop = ukiyo.watch({ withEdge: true, onBlock: (b) => console.log(b) });

// the hook's maths off-chain, to the wei
const loss = math.rebalancingLoss(l, s0, s1, math.getSqrtPriceAtTick(lo), math.getSqrtPriceAtTick(hi));
```

With no `hook` given, `createUkiyo` uses the known deployment on the client's chain (Unichain Sepolia, `DEPLOYMENTS`).
Pass `{ hook, lens }` for another one. Without a lens it reads the hook directly and leaves the vault fields empty.
`scoreboard(block)`, `edgeBetween` and `explain` read past state, so they need an RPC that serves it (the public
Unichain Sepolia one does).

## Develop

```bash
npm run gen        # ABIs from ../out (after forge build) and deployments from ../web/src/deployments
npm run vectors    # regenerate test/vectors.json; then `forge test --match-contract EdgeMathVectors` from the root
npm test           # node --test, no network
npm run typecheck
npm run ukiyo -- scoreboard   # run the CLI from source (Node ≥ 22.18 strips the types)
```
