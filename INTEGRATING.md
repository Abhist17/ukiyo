# Integrating with Ukiyo

Ukiyo turns a curator's skill into on-chain numbers any protocol can read, rank by, or pay fees on.

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
  address: "0x6c494A09EE8B16A96AfD7b5D24572a30072439bE", // UkiyoLens
  abi: lensAbi,
  functionName: "scoreboard",
  args: ["0xDf718121e527ACcAd0D59FaA9D4BEF345948aAC0"], // UkiyoHook
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
`minEpochLength`, probation between 0.01% and `maxProbationBps`, and a permanent bond of at least `minLaunchBond`.

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
| UkiyoHook | `0xDf718121e527ACcAd0D59FaA9D4BEF345948aAC0` |
| UkiyoLens | `0x6c494A09EE8B16A96AfD7b5D24572a30072439bE` |
| UkiyoFactory | `0x55aD00575622bD0FF3b22D8221c08208e46E9196` |
| UkiyoSkillRouter | `0xC28cd92bde73F94cBfF0E5F138d89684a0611D4F` |
| PoolManager (canonical) | `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |
