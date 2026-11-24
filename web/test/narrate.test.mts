// The scoreboard narration must say only what the numbers say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { narrate, signedPct, type CuratorLine } from "../src/lib/narrate.ts";

const money = (v: number) => `$${Math.round(v)}`;
const line = (o: Partial<CuratorLine>): CuratorLine => ({
  name: "X", edge: 0, edgeReturn: 0, edgeIndexed: true, tStat: 0, edgeEpochs: 5, hasSkill: false, onProbation: false,
  userFees: 0, userImpact: 0, arbLoss: 0, arbFees: 0, ...o,
});

test("before any epoch settles, it says so and ranks no one", () => {
  const s = narrate([line({ edgeIndexed: false }), line({ name: "Y", edgeIndexed: false })], money);
  assert.match(s[0], /No epoch with capital has settled yet/);
});

test("the leader is the best Edge return, and luck is called luck", () => {
  const s = narrate([line({ name: "A", edgeReturn: 0.01, tStat: 1.2 }), line({ name: "B", edgeReturn: 0.03, tStat: 0.8 })], money);
  assert.match(s[0], /^B leads with \+3\.00% Edge return, but its skill test says it could still be luck \(t = 0\.8/);
});

test("a passed skill test is reported as skill", () => {
  const s = narrate([line({ name: "A", edgeReturn: 0.02, tStat: 2.6, hasSkill: true })], money);
  assert.match(s[0], /skill test passes \(t = 2\.6\)/);
});

test("when fee income would rank differently, it says why", () => {
  const s = narrate(
    [
      line({ name: "Skilled", edgeReturn: 0.02, userFees: 100, edge: 50 }),
      line({ name: "Busy", edgeReturn: -0.01, userFees: 300, arbFees: 200, arbLoss: 900, edge: -400 }),
    ],
    money,
  );
  assert.ok(s.some((x) => x.startsWith("Ranked by fee income, Busy would be first with $500, but arbitrage took $900")));
});

test("probation and totals are reported", () => {
  const s = narrate([line({ name: "A", onProbation: true, userFees: 10, userImpact: 20, arbLoss: 40 })], money);
  assert.ok(s.some((x) => x === "A is on probation after a drawdown and cannot rebalance for now."));
  assert.ok(s.some((x) => x.includes("users paid $10 in fees and left $20 of price impact; arbitrage took $40")));
});

test("signedPct keeps digits on small returns", () => {
  assert.equal(signedPct(0.0334), "+3.34%");
  assert.equal(signedPct(-0.0005), "−0.050%");
});
