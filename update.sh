#!/usr/bin/env bash
#
# ITUPulse Agent updater — pulls the latest agent from GitHub and replaces the
# installed files in /opt/itupulse-agent. Keeps your registration, env, and
# state (no re-install, no new install key needed).
#
#   PUBLIC repo:
#     curl -fsSL https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/update.sh | sudo bash
#
#   PRIVATE repo (token with Contents:read):
#     curl -fsSL -H "Authorization: Bearer <TOKEN>" -H "Accept: application/vnd.github.raw" \
#       https://api.github.com/repos/thejasatl/ITUPulseInstaller/contents/update.sh?ref=main \
#       | sudo ITUPULSE_GH_TOKEN=<TOKEN> bash
#
set -euo pipefail

GH_OWNER="${ITUPULSE_GH_OWNER:-thejasatl}"
GH_REPO="${ITUPULSE_GH_REPO:-ITUPulseInstaller}"
GH_REF="${ITUPULSE_GH_REF:-main}"
GH_TOKEN="${ITUPULSE_GH_TOKEN:-}"
REPO_RAW="${ITUPULSE_REPO_RAW:-https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/$GH_REF}"

APP_DIR=/opt/itupulse-agent
SERVICE=/etc/systemd/system/itupulse-agent.service
AGENT_FILES=(src/agent.js src/config.js src/credentials.js src/logger.js src/transportHttp.js src/bufferStore.js src/nginxParser.js src/nginxLogReader.js src/metricsCollector.js src/register.js src/updater.js package.json)

say()  { echo -e "\033[1;36m[itupulse]\033[0m $*"; }
fail() { echo -e "\033[1;31m[itupulse] ERROR:\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root: sudo bash update.sh"
[ -d "$APP_DIR" ] || fail "$APP_DIR not found — the agent isn't installed. Run install.sh first."
command -v node >/dev/null 2>&1 || fail "node not found"

gh_fetch() {
  local path="$1" out="$2"
  if [ -n "$GH_TOKEN" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github.raw" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$GH_OWNER/$GH_REPO/contents/$path?ref=$GH_REF" \
      -o "$out"
  else
    curl -fsSL "$REPO_RAW/$path" -o "$out"
  fi
}

say "updating agent from $GH_OWNER/$GH_REPO@$GH_REF …"

# 1. Download everything to a temp dir FIRST — only swap in if all good.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/src"
for f in "${AGENT_FILES[@]}"; do
  gh_fetch "$f" "$TMP/$f" || fail "download failed: $f (private repo? set ITUPULSE_GH_TOKEN)"
done
gh_fetch "uninstall.sh" "$TMP/uninstall.sh" || say "WARNING: uninstall.sh not refreshed"
gh_fetch "systemd/itupulse-agent.service" "$TMP/itupulse-agent.service" || say "WARNING: systemd unit not refreshed"
gh_fetch "systemd/itupulse-updater.service" "$TMP/itupulse-updater.service" || true
gh_fetch "systemd/itupulse-updater.timer" "$TMP/itupulse-updater.timer" || true

# 2. Sanity-check the freshly downloaded JS before touching the live install.
for f in "${AGENT_FILES[@]}"; do
  case "$f" in
    *.js) node --check "$TMP/$f" >/dev/null 2>&1 || fail "downloaded $f failed syntax check — aborting (nothing changed)";;
  esac
done

# 3. Swap files in. Config (/etc/itupulse), credentials + state are NOT touched.
cp -f "$TMP"/src/*.js "$APP_DIR/src/"
cp -f "$TMP/package.json" "$APP_DIR/package.json"
[ -s "$TMP/uninstall.sh" ] && cp -f "$TMP/uninstall.sh" "$APP_DIR/uninstall.sh" || true
chown -R root:itupulse "$APP_DIR"
chmod -R 750 "$APP_DIR"

VER="$(node -e "try{process.stdout.write(String(require('$APP_DIR/package.json').version||''))}catch(e){}" 2>/dev/null || true)"
[ -n "$VER" ] && echo "$VER" > "$APP_DIR/VERSION"

# 4. Refresh the systemd unit (has hardening/path fixes) if present.
if [ -s "$TMP/itupulse-agent.service" ] && [ -d /run/systemd/system ]; then
  cp -f "$TMP/itupulse-agent.service" "$SERVICE"
  [ -s "$TMP/itupulse-updater.service" ] && cp -f "$TMP/itupulse-updater.service" /etc/systemd/system/itupulse-updater.service || true
  [ -s "$TMP/itupulse-updater.timer" ] && cp -f "$TMP/itupulse-updater.timer" /etc/systemd/system/itupulse-updater.timer || true
  systemctl daemon-reload
  systemctl enable --now itupulse-updater.timer >/dev/null 2>&1 || true
fi

# 5. Restart whichever runner is in use.
if systemctl list-unit-files 2>/dev/null | grep -q '^itupulse-agent\.service'; then
  systemctl restart itupulse-agent
  sleep 2
  systemctl --no-pager --lines=5 status itupulse-agent || true
elif command -v pm2 >/dev/null 2>&1 && pm2 describe itupulse-agent >/dev/null 2>&1; then
  pm2 restart itupulse-agent
else
  say "no running itupulse-agent service detected — start it manually."
fi

say ""
say "update complete${VER:+ (v$VER)}. Registration + config preserved — no new key needed."
say "  logs : journalctl -u itupulse-agent -f"
