// Unit tests for the scoring and price maths the site displays, and for the backtest claims it shows.
// Run: npm test   (node's built-in runner; no extra dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pairAgreement, pct, quoteToTick, ranks, sqrtToPrice, tickToQuote } from "../src/lib/math.ts";

test("ranks: 1 is the highest value", () => {
  assert.deepEqual(ranks([3, 1, 2]), [1, 3, 2]);
  assert.deepEqual(ranks([-5, 10, 0]), [3, 1, 2]);
});

test("pairAgreement: identical orders agree fully, reversed orders not at all", () => {
  assert.equal(pairAgreement([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(pairAgreement([1, 2, 3, 4], [4, 3, 2, 1]), 0);
  // one swapped pair out of six
  assert.equal(pairAgreement([1, 2, 3, 4], [2, 1, 3, 4]), 5 / 6);
});

test("pct: bps to a signed percent with a real minus sign", () => {
  assert.equal(pct(2428), "+24.3%");
  assert.equal(pct(-314.9), "−3.1%");
  assert.equal(pct(0), "0.0%");
  assert.equal(pct(41463, 0), "+415%");
});

test("sqrtToPrice: Q64.96 at 2^96 is a price of 1, and orientation inverts it", () => {
  const one = 2n ** 96n;
  assert.equal(sqrtToPrice(one, true), 1);
  assert.equal(sqrtToPrice(one, false), 1);
  // sqrt price of 4 → price 4 for token0 as base, 1/4 the other way
  assert.equal(sqrtToPrice(2n * one, true), 4);
  assert.equal(sqrtToPrice(2n * one, false), 0.25);
});

test("ticks and prices round-trip in both orientations", () => {
  for (const baseIs0 of [true, false]) {
    for (const price of [0.5, 1, 1.5, 42_268, 100_000]) {
      const t = quoteToTick(price, baseIs0);
      const back = tickToQuote(t, baseIs0);
      // a tick is 1 bp wide, so the price at the rounded-down tick is within 1 bp
      assert.ok(Math.abs(back / price - 1) <= 1.0001e-4, `${price} → tick ${t} → ${back}`);
    }
  }
  assert.ok(Math.abs(tickToQuote(10_000, true) - Math.E) < 0.01, "1.0001^10000 ≈ e");
});

test("backtest claim shown on the site: Edge orders the six curators exactly like true hedged P&L (5 bps)", () => {
  const d = JSON.parse(readFileSync(new URL("../src/data/btc2024.json", import.meta.url), "utf8"));
  const total = (key: string) =>
    d.curators.map((_: unknown, i: number) => d.tiers["5bps"].series[key].reduce((s: number, row: number[]) => s + row[i], 0));
  assert.deepEqual(ranks(total("edge")), ranks(total("truth")));
  assert.equal(pairAgreement(total("edge"), total("truth")), 1);
  // and fee income does not
  assert.ok(pairAgreement(total("fees"), total("truth")) < 1);
});
