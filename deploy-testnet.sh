#!/usr/bin/env bash
# Deploy the Ukiyo demo to a public testnet (Unichain Sepolia or Base Sepolia) and refresh the site's addresses.
# Needs a .env with PRIVATE_KEY and RPC_URL (see .env.example). Afterwards: cd web && npm run bot:testnet
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
: "${PRIVATE_KEY:?set PRIVATE_KEY in .env}"
: "${RPC_URL:?set RPC_URL in .env}"
export PATH="$HOME/.foundry/bin:$PATH"

me="$(cast wallet address --private-key "$PRIVATE_KEY")"
chain="$(cast chain-id --rpc-url "$RPC_URL")"
case "$chain" in
  1301) name="Unichain Sepolia" ;;
  84532) name="Base Sepolia" ;;
  *) echo "chain $chain is not supported (Unichain Sepolia 1301 or Base Sepolia 84532)"; exit 1 ;;
esac
echo "chain:    $name ($chain)"
echo "deployer: $me"
echo "balance:  $(cast balance "$me" --rpc-url "$RPC_URL" --ether) ETH"
EPOCH="${EPOCH:-600}" forge script script/DeployUkiyo.s.sol --rpc-url "$RPC_URL" --broadcast --slow \
  --private-key "$PRIVATE_KEY"
(cd web && node scripts/abi.mjs)
echo "deployed; addresses in web/src/deployments/$chain.json. Next: cd web && npm run bot:testnet"
