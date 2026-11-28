#!/usr/bin/env bash
# Run every 5 minutes by ukiyo-health.timer. Restarts the bot if it has stopped advancing, and if the live site stops
# answering 200, promotes the last deployment that deploy-vercel.sh saw serving (web/.last-good-deploy).
set -uo pipefail
cd "$(dirname "$0")"
LOG=.health.log
log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

# the bot rewrites its state file after every replayed hour (every STEP_MS), so an old file means it is stuck
STATE=.bot-state-1301.json
if [ -f "$STATE" ]; then
  age=$(($(date +%s) - $(stat -c %Y "$STATE")))
  if [ "$age" -gt 600 ]; then
    log "bot has not advanced for ${age}s: restarting it"
    systemctl --user restart ukiyo-bot.service
  fi
fi
systemctl --user is-active --quiet ukiyo-bot.service || { log "bot service not active: starting it"; systemctl --user start ukiyo-bot.service; }

SITE="${SITE_URL:-https://ukiyo-ochre.vercel.app/}"
check() { curl -s -m 20 -o /dev/null -w '%{http_code}' "$SITE"; }
code=$(check)
if [ "$code" != 200 ]; then
  sleep 30
  code=$(check)
  GOOD="$(cat ../.last-good-deploy 2>/dev/null || true)"
  if [ "$code" != 200 ] && [ -n "$GOOD" ]; then
    log "site answered $code: promoting $GOOD"
    (cd /tmp && npx -y vercel@latest promote "$GOOD" --yes) >>"$LOG" 2>&1 || log "promote failed"
    log "site now answers $(check)"
  fi
fi
# keep the log short
tail -n 500 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
