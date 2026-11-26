// Reviewers click the README's line links to find the integration; every one must land on a declaration, not on
// whatever drifted into that line after the code above it grew.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const DECLARATION = /^\s*(contract|library|function|struct|event|error|constructor|modifier|.*HookMiner\.find)/;

for (const doc of ["README.md", "REVIEWERS.md", "INTEGRATING.md", "THREAT_MODEL.md"]) {
  const links = [...read(doc).matchAll(/\(((?:src|script)\/[\w/.]+\.sol)#L(\d+)\)/g)];
  for (const [, file, line] of links) {
    test(`${doc}: ${file}#L${line} lands on a declaration`, () => {
      const text = read(file).split("\n")[Number(line) - 1] ?? "";
      assert.match(text, DECLARATION, `line ${line} of ${file} is now: ${text.trim() || "(blank)"}`);
    });
  }
}
