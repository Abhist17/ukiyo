import { test } from "node:test";
import assert from "node:assert/strict";
import { misranked, positions, rank } from "../src/rank.ts";
import { narrateExplanation, toNumber, type Explanation, type Row } from "../src/client.ts";

const E = 10n ** 18n;
function row(sleeveId: number, name: string, userFees: number, arbFees: number, impact: number, arbLoss: number, edgeIndex = E): Row {
  const ledger = { userFees: BigInt(userFees) * E, userImpact: BigInt(impact) * E, arbLoss: BigInt(arbLoss) * E, arbFees: BigInt(arbFees) * E };
  return {
    sleeveId, name, curator: "0x0000000000000000000000000000000000000001", manager: "0x0000000000000000000000000000000000000002",
    tickLower: -100, tickUpper: 100, liquidity: 1n, ledger, edge: ledger.userFees + ledger.userImpact - ledger.arbLoss,
    isVault: true, symbol: "", edgeIndex, edgeTStat: 0n, edgeEpochs: 0n, hasSkill: false, onProbation: false, epoch: 0n,
    capital: 0n, bond: 0n, performanceFeeBps: 0n,
  };
}

// the money-changer example: the busiest booth earns the most fees and still loses
const rows = [row(0, "Wide", 5, 1, 2, 3), row(1, "Chaser", 20, 15, 4, 40), row(2, "Mid", 8, 3, 3, 6)];

test("ranking by Edge and by fee income disagree, and misranked() says where", () => {
  assert.deepEqual(rank(rows, "edge").map((r) => r.name), ["Mid", "Wide", "Chaser"]);
  assert.deepEqual(rank(rows, "fees").map((r) => r.name), ["Chaser", "Mid", "Wide"]);
  const wrong = misranked(rows);
  assert.equal(wrong[0].row.name, "Chaser");
  assert.equal(wrong[0].feeRank, 1);
  assert.equal(wrong[0].edgeRank, 3);
});

test("ties keep sleeve order; positions are 1-based", () => {
  const tied = [row(1, "B", 1, 0, 0, 0), row(0, "A", 1, 0, 0, 0)];
  assert.deepEqual(rank(tied).map((r) => r.name), ["A", "B"]);
  assert.equal(positions(rows, "edge").get(2), 1);
});

test("toNumber keeps sign and fractions", () => {
  assert.equal(toNumber(-15n * 10n ** 17n), -1.5);
  assert.equal(toNumber(1234n, 3), 1.234);
});

test("an explanation narrates the classification rule it applied", () => {
  const tok = { address: "0x0000000000000000000000000000000000000003", symbol: "tUSD", decimals: 18 } as const;
  const base = {
    sender: tok.address, tip: 0n, threshold: 2_000_000n, firstInBlock: false, amount0: 0n, amount1: 0n, sqrtBefore: 1n,
    sqrtAfter: 1n, priceBefore: 100, priceAfter: 101, spikeNetted: false, sleeveFees: [{ sleeveId: 0, fee: E }],
  };
  const ex: Explanation = {
    hash: "0x" + "00".repeat(32) as `0x${string}`, blockNumber: 7n, from: tok.address, swapsInBlock: 1,
    swaps: [{ ...base, isArbitrage: false, reason: "user" }], block: [{ sleeveId: 0, name: "Wide", delta: { userFees: E, userImpact: 0n, arbLoss: 0n, arbFees: 0n }, edgeDelta: E }],
    token0: { ...tok, symbol: "tBTC" }, token1: tok, narrative: [],
  };
  const user = narrateExplanation(ex).join(" ");
  assert.match(user, /below the 0\.002 gwei threshold, so it is booked as user flow/);
  assert.match(user, /count toward their Edge/);
  const vault = narrateExplanation({ ...ex, swaps: [{ ...base, isArbitrage: true, reason: "sleeve-manager" }] }).join(" ");
  assert.match(vault, /curator vault trading for itself/);
  assert.match(vault, /never counts as Edge/);
  assert.match(narrateExplanation({ ...ex, swaps: [] })[0], /No swap/);
});
