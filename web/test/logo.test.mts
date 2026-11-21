// The mark must be identical everywhere: the static SVGs are generated from src/lib/logo.ts and must not drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { logoSvg } from "../src/lib/logo.ts";

for (const path of ["../../assets/logo.svg", "../src/app/icon.svg"]) {
  test(`${path.replace(/^(\.\.\/)+/, "")} matches the logo definition`, () => {
    assert.equal(readFileSync(new URL(path, import.meta.url), "utf8"), logoSvg(), "run `npm run logo` after editing src/lib/logo.ts");
  });
}
