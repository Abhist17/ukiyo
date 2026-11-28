# Integrating with Ukiyo

Ukiyo turns a curator's skill into on-chain numbers any protocol can read, rank by, or pay fees on.

## From TypeScript or a terminal: the SDK

[`sdk/`](sdk/) wraps everything below: `createUkiyo({ client })` gives the scoreboard, `edgeBetween`, `explain(tx)` and
a live `watch`, and `math` has the hook's formulas in exact bigint. The `ukiyo` CLI runs the same from a terminal
(`ukiyo scoreboard`, `ukiyo explain <tx>`, `ukiyo watch --edge`). See [`sdk/README.md`](sdk/README.md).

## From a contract: `IUkiyoEdge`

[`IUkiyoEdge`](src/interfaces/IUkiyoEdge.sol) is the hook's read side with no imports, for a contract that pays,
ranks or gates curators on Edge:

```solidity
import {IUkiyoEdge} from "ukiyo/src/interfaces/IUkiyoEdge.sol"; // forge install Abhist17/ukiyo

int256 start = IUkiyoEdge(hook).edge(sleeveId);   // at the start of a period
// ...
int256 earned = IUkiyoEdge(hook).edge(sleeveId) - start;  // Edge earned over it, raw token1
```

`EdgeMath` (`src/libraries/EdgeMath.sol`) is a plain library: a hook of your own can book the same loss, impact and fee
terms.

## Read the scoreboard in one call

[`UkiyoLens`](src/UkiyoLens.sol) returns the pool's state and one row per sleeve: ledger (user fees, user impact,
arbitrage loss, arbitrage fees), Edge, and for curator vaults the Edge index, skill test, probation, epoch, capital and
terms.

```ts
import { createPublicClient, http } from "viem";
import { unichainSepolia } from "viem/chains";
import { lensAbi } from "./abi"; // from out/UkiyoLens.sol/UkiyoLens.json

const client = createPublicClient({ chain: unichainSepolia, transport: http() });
const [pool, rows] = await client.readContract({
  address: "0x6BEdA8aBAd4d22cdc4737524ea257898E511149A", // UkiyoLens
  abi: lensAbi,
  functionName: "scoreboard",
  args: ["0x8040bd84e07EAfc25D5ED8053AB7ad3F99a9eAc0"], // UkiyoHook
});
// rank curators by size-neutral skill: rows.filter((r) => r.isVault).sort((a, b) => Number(b.edgeIndex - a.edgeIndex))
```

## Pay or judge a curator on Edge over a period

`edge(sleeveId)` only grows or shrinks as the hook books it. Snapshot it at the start of a period and subtract at the
end, exactly as `UkiyoVault` does each epoch for its performance fee (`epochStartEdge`). Money is in raw token1 units.

## Events worth indexing

| Event | Emitted by | Meaning |
| --- | --- | --- |
| `SwapClassified(blockNumber, isArbitrage, priorityFeePerGas)` | hook | How every swap was booked |
| `BlockMarked(blockNumber, sqrtPostMarkX96)` | hook | The post-arbitrage mark of each block |
| `EpochSettled(epoch, edgeDelta, …)` | vault | Edge earned in an epoch |
| `EdgeIndexUpdated(epoch, returnWad, index)` | vault | The epoch's Edge return and the compounded index |
| `Probation(epoch, index, peak, until)` | vault | A curator barred from rebalancing after a drawdown |
| `VaultLaunched(vault, curator, sleeveId, …)` | factory | A new curator |

## Launch a curator vault

`UkiyoFactory.launch(vaultCode, tickLower, tickUpper, terms, name, symbol)`, where `vaultCode` is exactly
`type(UkiyoVault).creationCode` (it is passed in because it is too large for the factory to embed; the factory checks
its hash). Approve the factory for `terms.minBond` of token1 first. The factory requires epochs of at least
`minEpochLength`, probation between 0.01% and `maxProbationBps`, and a permanent bond of at least `minLaunchBond`. `terms.depositCap` caps the vault's
capital (token1, at the hook's reference price; 0 for none); if the factory's `maxDepositCap` is set, every launch must
set a cap of at most that.

## Route deposits by skill

`UkiyoSkillRouter.deposit(vaults, amount0, amount1)` splits a deposit across the listed vaults in proportion to their
skill tests; `weights(vaults)` previews the split. Shares and refunds go to the depositor directly.

## Trade the pool

The pool is a standard v4 pool (static 5 bps fee, normal curve), so any v4 router can trade it. The hook books a swap
as arbitrage when its priority fee is at or above `priorityFeeThreshold()`: arbitrageurs should tip at least that,
ordinary users need not.

## Addresses (Unichain Sepolia, chain 1301)

| Contract | Address |
| --- | --- |
| UkiyoHook | `0x8040bd84e07EAfc25D5ED8053AB7ad3F99a9eAc0` |
| UkiyoLens | `0x6BEdA8aBAd4d22cdc4737524ea257898E511149A` |
| UkiyoFactory | `0x07F6Ecfc91b7c635518bb85F6616FbccA8eA26Bd` |
| UkiyoSkillRouter | `0x384F81f8aCdeb877555E948c4e97764802495924` |
| PoolManager (canonical) | `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |
