#!/usr/bin/env bash
# ITUPulse Agent uninstaller (spec section 19)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

# --- systemd install ---
systemctl stop itupulse-agent 2>/dev/null || true
systemctl disable itupulse-agent 2>/dev/null || true
rm -f /etc/systemd/system/itupulse-agent.service
systemctl daemon-reload 2>/dev/null || true

# --- pm2 install (if the agent was run under pm2 instead) ---
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete itupulse-agent 2>/dev/null || true
  pm2 save 2>/dev/null || true
fi

rm -rf /opt/itupulse-agent
rm -rf /etc/itupulse
rm -rf /var/lib/itupulse-agent
rm -rf /var/log/itupulse-agent
userdel itupulse 2>/dev/null || true

echo "[itupulse] agent removed. Revoke the server in the dashboard to kill its credentials backend-side."
