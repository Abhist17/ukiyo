// Writes test/vectors.json: inputs and the SDK's outputs for EdgeMath and TickMath. test/EdgeMathVectors.t.sol replays
// every vector through the Solidity libraries and requires the same wei, so the two can never drift apart.
// Run from sdk/:  npm run vectors
import { writeFileSync } from "node:fs";
import { vectors } from "../test/vectors.ts";

writeFileSync(new URL("../test/vectors.json", import.meta.url), JSON.stringify(vectors(), null, 1) + "\n");
console.log("wrote test/vectors.json");
