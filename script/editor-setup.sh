#!/usr/bin/env bash
# Makes VS Code's Solidity extension (Nomic Foundation) read this repo the way forge does.
#
# The extension treats every folder with a hardhat.config.{js,ts} as its own project. Several libraries under lib/
# (OpenZeppelin's uniswap-hooks and openzeppelin-contracts) ship one, so the extension resolves their files outside
# our Foundry project and reports false errors in src/, such as "IPoolManager is not convertible to IPoolManager".
# forge never reads those files, so hiding them changes nothing for the build. Run once after cloning, then
# "Developer: Reload Window" in VS Code. `script/editor-setup.sh --undo` puts them back.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--undo" ]; then
  find lib -name "hardhat.config.*.ukiyo-off" -not -path "*/node_modules/*" | while read -r f; do mv "$f" "${f%.ukiyo-off}"; echo "restored ${f%.ukiyo-off}"; done
  exit 0
fi
find lib \( -name "hardhat.config.js" -o -name "hardhat.config.ts" \) -not -path "*/node_modules/*" | while read -r f; do
  mv "$f" "$f.ukiyo-off"
  echo "hid $f"
done
echo "Done. In VS Code: Ctrl+Shift+P, then 'Developer: Reload Window'."
