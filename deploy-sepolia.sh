#!/usr/bin/env bash
# Deploy the Ukiyo demo to Unichain Sepolia and refresh the site's addresses.
# Needs a .env with PRIVATE_KEY (see .env.example). Afterwards start the bot: cd web && npm run bot:sepolia
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
: "${PRIVATE_KEY:?set PRIVATE_KEY in .env}"
RPC_URL="${RPC_URL:-https://sepolia.unichain.org}"
export PATH="$HOME/.foundry/bin:$PATH"

echo "deployer: $(cast wallet address --private-key "$PRIVATE_KEY")"
echo "balance:  $(cast balance "$(cast wallet address --private-key "$PRIVATE_KEY")" --rpc-url "$RPC_URL" --ether) ETH"
EPOCH="${EPOCH:-600}" forge script script/DeployUkiyo.s.sol --rpc-url "$RPC_URL" --broadcast --slow \
  --private-key "$PRIVATE_KEY"
(cd web && node scripts/abi.mjs)
echo "deployed; addresses in web/src/deployments/1301.json"
