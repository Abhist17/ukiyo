#!/usr/bin/env bash
# Ukiyo in one command: the test suites, then the live hook on Unichain Sepolia, then a check that the live deployment
# is this repository's code and keeps its books to the wei.
#
#   ./demo.sh             pauses before each step (press Enter), for presenting
#   ./demo.sh --no-pause  runs straight through
#   ./demo.sh --offline   only the steps that need no network (tests, gas, the cost maths)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"

PAUSE=1
ONLINE=1
for a in "$@"; do
  case "$a" in
    --no-pause) PAUSE=0 ;;
    --offline) ONLINE=0 ;;
    *) echo "unknown option $a (use --no-pause or --offline)"; exit 1 ;;
  esac
done
[ -t 0 ] || PAUSE=0

bold=$'\e[1m'; dim=$'\e[2m'; cyan=$'\e[36m'; reset=$'\e[0m'
n=0
step() {
  n=$((n + 1))
  echo
  echo "${cyan}${bold}━━ $n. $1${reset}"
  echo "${dim}$2${reset}"
  if [ "$PAUSE" = 1 ]; then read -r -p "${dim}   ↵ Enter to run${reset}" _; fi
}
cli() { node sdk/dist/cli.js "$@"; }

# setup, quietly: build the contracts and the CLI if they are not built yet
command -v forge >/dev/null || { echo "forge not found: install Foundry (https://getfoundry.sh)"; exit 1; }
forge build >/dev/null
if [ ! -d sdk/node_modules ]; then (cd sdk && npm install --silent --no-audit --no-fund); fi
if [ ! -f sdk/dist/cli.js ] || [ -n "$(find sdk/src -newer sdk/dist/cli.js -print -quit)" ]; then (cd sdk && npm run -s build); fi

step "Every test" \
  "118 tests + 6 stateful invariants against Uniswap's canonical PoolManager bytecode, incl. a differential fuzz test"
forge test --summary 2>&1 | awk '/Test Suite/ { print prev; p = 1 } p; { prev = $0 }'

step "The off-chain maths equals the Solidity, to the wei" \
  "400 sleeves and moves plus 127 ticks, computed by the TypeScript SDK, replayed through EdgeMath and TickMath"
forge test --match-contract EdgeMathVectors 2>&1 | grep -E "PASS|FAIL|Suite"

step "Gas, against a plain v4 pool" \
  "a whole swap transaction as a user pays it, with and without the hook"
forge test --isolate --match-test test_gas -vv 2>&1 | grep "gas:"

step "Why the loss is quadratic" \
  "what a move costs a range, with the hook's own formula: half the move, a quarter of the loss"
cli cost --range 60000:80000 --from 70000 --to 70700

if [ "$ONLINE" = 1 ]; then
  step "The live scoreboard on Unichain Sepolia" \
    "read in one call through UkiyoLens; the last column is where a fee-APR dashboard would rank each curator"
  cli scoreboard

  step "How the hook booked a real swap, and why" \
    "the newest user swap through the hook, explained from the chain"
  cli explain latest-user

  step "Live: blocks as they happen (25 seconds)" \
    "the arbitrageur tips and goes first, users follow, and each curator's Edge moves"
  timeout 25 node sdk/dist/cli.js watch --edge || true

  step "The live deployment is this code, and its books check out" \
    "deployed bytecode = this repo; every recent swap classified by its real tip; real blocks replayed to the wei"
  (cd sdk && REPLAY="${REPLAY:-15}" npm run -s verify:live)
fi

echo
echo "${bold}Done.${reset} App: https://ukiyo-ochre.vercel.app · Code: https://github.com/Abhist17/ukiyo"
