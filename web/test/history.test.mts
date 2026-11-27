// The deploy-time history snapshot (scripts/history.mts) is read back by the browser sync (src/lib/logs.ts); both
// sides go through these helpers, so bigints and event names must survive the round trip exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog, encodeEventTopics, encodeAbiParameters } from "viem";
import { VAULT_EVENTS, decodeBig, encodeBig, historyPath } from "../src/lib/vaultEvents.ts";

test("bigints survive the snapshot encoding, at any size and sign", () => {
  const v = { to: 68_915_210n, logs: [{ block: 1n, args: { edgeDelta: -(2n ** 200n), epoch: 0n, user: "0xabc" } }] };
  assert.deepEqual(decodeBig(encodeBig(v)), v);
});

test("the vault events decode from raw logs as the app expects", () => {
  const ev = VAULT_EVENTS.find((e) => e.name === "EpochSettled")!;
  const topics = encodeEventTopics({ abi: VAULT_EVENTS, eventName: "EpochSettled", args: { epoch: 7n } });
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), [-5n, 1n, 2n, 3n]);
  const out = decodeEventLog({ abi: VAULT_EVENTS, data, topics: topics as [`0x${string}`] });
  assert.equal(out.eventName, "EpochSettled");
  assert.equal((out.args as { edgeDelta: bigint }).edgeDelta, -5n);
});

test("one snapshot file per chain", () => {
  assert.equal(historyPath(1301), "/history-1301.json");
});
