import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  MathRevert,
  Q96,
  getSqrtPriceAtTick,
  impactCredit,
  lpFeeRate,
  mulDivRoundingUp,
  priceToSqrt,
  rebalancingLoss,
  sqrtToPrice,
  swapFee,
} from "../src/math.ts";
import { vectors } from "./vectors.ts";

test("vectors.json is what the maths produces now (Foundry checks the same file against Solidity)", () => {
  const file = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
  assert.deepEqual(file, JSON.parse(JSON.stringify(vectors())), "stale: run `npm run vectors`");
});

test("TickMath ends and middle match v4's constants", () => {
  assert.equal(getSqrtPriceAtTick(MIN_TICK), MIN_SQRT_PRICE);
  assert.equal(getSqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE);
  assert.equal(getSqrtPriceAtTick(0), Q96);
  assert.throws(() => getSqrtPriceAtTick(MAX_TICK + 1), MathRevert);
});

test("loss rounds up and credit rounds down: they differ by at most 2 wei on the same move", () => {
  const lo = getSqrtPriceAtTick(-10_000);
  const hi = getSqrtPriceAtTick(10_000);
  for (const [a, b] of [[-3000, 2500], [100, 101], [0, 9999], [-9999, -9998]]) {
    const s0 = getSqrtPriceAtTick(a);
    const s1 = getSqrtPriceAtTick(b);
    const l = 123456789012345678901234n;
    const loss = rebalancingLoss(l, s0, s1, lo, hi);
    const credit = impactCredit(l, s0, s1, lo, hi);
    assert.ok(loss >= credit && loss - credit <= 2n, `${loss} vs ${credit}`);
  }
});

test("the loss is quadratic in the move: twice the move costs about four times as much", () => {
  const l = 10n ** 24n;
  const lo = priceToSqrt(30_000);
  const hi = priceToSqrt(60_000);
  const s0 = priceToSqrt(40_000);
  const small = rebalancingLoss(l, s0, s0 + s0 / 1000n, lo, hi);
  const big = rebalancingLoss(l, s0, s0 + s0 / 500n, lo, hi);
  assert.ok(Math.abs(Number(big) / Number(small) - 4) < 1e-6);
});

test("moves outside a range cost nothing; a range only pays for the part of the move inside it", () => {
  const lo = getSqrtPriceAtTick(0);
  const hi = getSqrtPriceAtTick(100);
  const l = 10n ** 20n;
  assert.equal(rebalancingLoss(l, getSqrtPriceAtTick(200), getSqrtPriceAtTick(300), lo, hi), 0n);
  assert.equal(
    rebalancingLoss(l, getSqrtPriceAtTick(50), getSqrtPriceAtTick(500), lo, hi),
    rebalancingLoss(l, getSqrtPriceAtTick(50), hi, lo, hi),
  );
});

test("lpFeeRate: f / (1 − f) with no protocol fee; nothing at a 100% fee", () => {
  assert.deepEqual(lpFeeRate(500, 0), [500n, 999_500n]);
  assert.deepEqual(lpFeeRate(1_000_000, 0), [0n, 1n]);
  const [n, d] = lpFeeRate(3000, 1000);
  assert.ok(n < 3000n && d < 1_000_000n); // the protocol takes its cut before the LPs
});

test("swapFee pays 5 bps on what a sleeve absorbs, either direction", () => {
  const lo = getSqrtPriceAtTick(-1000);
  const hi = getSqrtPriceAtTick(1000);
  const l = 10n ** 24n;
  const [num, den] = lpFeeRate(500, 0);
  const up = swapFee(l, Q96, getSqrtPriceAtTick(10), lo, hi, num, den);
  const net1 = (l * (getSqrtPriceAtTick(10) - Q96)) / Q96;
  assert.equal(up, (net1 * num) / den);
  assert.ok(swapFee(l, getSqrtPriceAtTick(10), Q96, lo, hi, num, den) > 0n);
});

test("overflow reverts like Solidity instead of wrapping", () => {
  assert.throws(() => mulDivRoundingUp(1n << 200n, 1n << 200n, 1n), MathRevert);
});

test("price helpers round-trip", () => {
  assert.ok(Math.abs(sqrtToPrice(priceToSqrt(42_268)) / 42_268 - 1) < 1e-12);
  assert.ok(Math.abs(sqrtToPrice(getSqrtPriceAtTick(6932)) / 1.0001 ** 6932 - 1) < 1e-9);
});
