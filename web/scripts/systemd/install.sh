#!/usr/bin/env bash
# Installs and starts the bot service and the health timer for the current user.
set -euo pipefail
cd "$(dirname "$0")"
# two bots on one key fight over nonces, so stop any bot started by hand before the service starts its own
pkill -f "node --env-file=../.env scripts/[b]ot.mts" && sleep 2 || true
mkdir -p ~/.config/systemd/user
cp ukiyo-bot.service ukiyo-health.service ukiyo-health.timer ~/.config/systemd/user/
loginctl enable-linger "$USER" 2>/dev/null || echo "could not enable lingering: the bot will start at login, not at boot"
systemctl --user daemon-reload
systemctl --user enable --now ukiyo-bot.service ukiyo-health.timer
systemctl --user --no-pager status ukiyo-bot.service | head -5
