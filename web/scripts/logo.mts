// Writes the static logo files from the one definition in src/lib/logo.ts, so the favicon, the README logo and the
// site's <Logo> can never drift apart. Run: npm run logo
import { writeFileSync } from "node:fs";
import { logoSvg } from "../src/lib/logo.ts";

for (const path of ["../assets/logo.svg", "src/app/icon.svg"]) {
  writeFileSync(new URL(`../${path}`, import.meta.url), logoSvg());
  console.log("wrote", path);
}
