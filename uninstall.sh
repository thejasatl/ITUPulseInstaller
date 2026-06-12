#!/usr/bin/env bash
# ITUPulse Agent uninstaller (spec section 19)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

systemctl stop itupulse-agent 2>/dev/null || true
systemctl disable itupulse-agent 2>/dev/null || true
rm -f /etc/systemd/system/itupulse-agent.service
systemctl daemon-reload

rm -rf /opt/itupulse-agent
rm -rf /etc/itupulse
rm -rf /var/lib/itupulse-agent
rm -rf /var/log/itupulse-agent
userdel itupulse 2>/dev/null || true

echo "[itupulse] agent removed. Revoke the server in the dashboard to kill its credentials backend-side."
