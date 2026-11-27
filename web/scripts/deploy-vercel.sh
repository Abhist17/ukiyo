#!/usr/bin/env bash
# Builds the static site and publishes it to Vercel production (uses your local `vercel login`).
# Only the built site goes up, from a copy named "ukiyo" so the Vercel project keeps that name; the repo is not sent.
set -euo pipefail
cd "$(dirname "$0")/.."
SITE="${NEXT_PUBLIC_SITE_URL:-https://ukiyo-ochre.vercel.app/}"
# ship the vault history with the site, so a visit reads only the blocks since this deploy (skipped if it fails)
node --experimental-strip-types --no-warnings scripts/history.mts || echo "history snapshot skipped"
NEXT_PUBLIC_SITE_URL="$SITE" npm run -s build
STAGE="$(mktemp -d)/ukiyo"
cp -r out "$STAGE"
cd "$STAGE" && npx -y vercel@latest deploy --prod --yes
