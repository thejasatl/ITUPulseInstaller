#!/usr/bin/env bash
# ITUPulse Agent uninstaller (spec section 19)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

# --- tell the backend we're going offline (BEFORE deleting creds) ---
# Signed request with the agent's own credentials so the dashboard flips the
# server to offline + raises an "agent uninstalled" alert immediately, instead
# of waiting for the heartbeat timeout. Best-effort; ignore any failure.
if [ -f /opt/itupulse-agent/src/transportHttp.js ] && [ -f /etc/itupulse/agent.env ]; then
  sudo -u itupulse ITUPULSE_ENV_FILE=/etc/itupulse/agent.env node -e 'require("/opt/itupulse-agent/src/transportHttp").post("/api/v1/agent/shutdown",{reason:"uninstall"},{timeoutMs:4000}).then(function(){process.exit(0)}).catch(function(){process.exit(0)})' 2>/dev/null || true
fi

# --- systemd install ---
systemctl stop itupulse-agent 2>/dev/null || true
systemctl disable itupulse-agent 2>/dev/null || true
rm -f /etc/systemd/system/itupulse-agent.service
# root updater service + timer
systemctl stop itupulse-updater.timer 2>/dev/null || true
systemctl disable itupulse-updater.timer 2>/dev/null || true
rm -f /etc/systemd/system/itupulse-updater.service /etc/systemd/system/itupulse-updater.timer
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

echo "[itupulse] agent removed. The dashboard will show this server OFFLINE with an 'agent uninstalled' alert."
echo "[itupulse] To fully remove it, delete the server in the dashboard (Servers -> Delete)."
