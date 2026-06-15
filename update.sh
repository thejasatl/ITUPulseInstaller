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

# Pull config (GH token, optional post-update vars) so manual + updater runs match.
if [ -f /etc/itupulse/agent.env ]; then set -a; . /etc/itupulse/agent.env 2>/dev/null || true; set +a; fi
GH_TOKEN="${ITUPULSE_GH_TOKEN:-$GH_TOKEN}"

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

OLD_VER="$(node -e "try{process.stdout.write(String(require('$APP_DIR/package.json').version||''))}catch(e){}" 2>/dev/null || true)"

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
say "agent version: ${OLD_VER:-?} -> ${VER:-?}"

# 4. Refresh the systemd unit (has hardening/path fixes) if present.
if [ -s "$TMP/itupulse-agent.service" ] && [ -d /run/systemd/system ]; then
  cp -f "$TMP/itupulse-agent.service" "$SERVICE"
  [ -s "$TMP/itupulse-updater.service" ] && cp -f "$TMP/itupulse-updater.service" /etc/systemd/system/itupulse-updater.service || true
  [ -s "$TMP/itupulse-updater.timer" ] && cp -f "$TMP/itupulse-updater.timer" /etc/systemd/system/itupulse-updater.timer || true
  systemctl daemon-reload
  systemctl enable --now itupulse-updater.timer >/dev/null 2>&1 || true
fi

# 5. Restart the agent so the NEW code actually runs. This is the step that used
#    to need a manual `systemctl restart`. We launch it DETACHED (a transient
#    systemd timer, or setsid fallback) so the restart can never be killed when
#    the agent stops and there is no self-restart deadlock — works the same
#    whether this script is run by the root updater, by hand, or by the agent.
restart_agent_detached() {
  if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemd-run --quiet --collect --on-active=2 \
      systemctl restart itupulse-agent >/dev/null 2>&1 && return 0
  fi
  setsid bash -c 'sleep 2; systemctl restart itupulse-agent' </dev/null >/dev/null 2>&1 &
  return 0
}

if [ -d /run/systemd/system ] && { systemctl list-unit-files 2>/dev/null | grep -q '^itupulse-agent\.service' || [ -f "$SERVICE" ]; }; then
  say "restarting itupulse-agent to load v${VER:-new} (detached, ~2s) …"
  restart_agent_detached
  say "restart scheduled — the new version goes live in ~2s (no manual restart needed)."
elif command -v pm2 >/dev/null 2>&1 && pm2 describe itupulse-agent >/dev/null 2>&1; then
  pm2 restart itupulse-agent || true
else
  say "no running itupulse-agent service detected — start it manually."
fi

# 6. Optional: reload the app's web server (e.g. to re-open rotated logs) + custom hook.
if [ "${ITUPULSE_RELOAD_NGINX:-false}" = "true" ] && command -v nginx >/dev/null 2>&1; then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
  say "reloaded nginx"
fi
if [ -n "${ITUPULSE_POST_UPDATE:-}" ]; then
  say "running post-update hook: ${ITUPULSE_POST_UPDATE}"
  bash -lc "${ITUPULSE_POST_UPDATE}" || say "post-update hook failed (continuing)"
fi

say ""
say "update complete${VER:+ (v$VER)}. Registration + config preserved — no new key needed."
say "  logs : journalctl -u itupulse-agent -f"
