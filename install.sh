#!/usr/bin/env bash
#
# ITUPulse Agent installer
#
#   PUBLIC repo:
#     curl -fsSL https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/install.sh \
#       | sudo ITUPULSE_INSTALL_KEY=<key> bash
#
#   PRIVATE repo (needs a GitHub token with 'repo'/'Contents:read' scope):
#     curl -fsSL -H "Authorization: Bearer <TOKEN>" \
#          -H "Accept: application/vnd.github.raw" \
#          https://api.github.com/repos/thejasatl/ITUPulseInstaller/contents/install.sh?ref=main \
#       | sudo ITUPULSE_INSTALL_KEY=<key> ITUPULSE_GH_TOKEN=<TOKEN> bash
#
# Responsibilities: OS check, root check, Node.js check, itupulse user,
# directories, agent download, install key, NGINX log detection, env file,
# systemd unit, registration test, enable + start.
#
set -euo pipefail

# ---- Source repo (override any of these via env) ----
GH_OWNER="${ITUPULSE_GH_OWNER:-thejasatl}"
GH_REPO="${ITUPULSE_GH_REPO:-ITUPulseInstaller}"
GH_REF="${ITUPULSE_GH_REF:-main}"
GH_TOKEN="${ITUPULSE_GH_TOKEN:-}"
REPO_RAW="${ITUPULSE_REPO_RAW:-https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/$GH_REF}"

APP_DIR=/opt/itupulse-agent
ETC_DIR=/etc/itupulse
STATE_DIR=/var/lib/itupulse-agent
LOG_DIR=/var/log/itupulse-agent
SERVICE=/etc/systemd/system/itupulse-agent.service
AGENT_FILES=(src/agent.js src/config.js src/credentials.js src/logger.js src/transportHttp.js src/bufferStore.js src/nginxParser.js src/nginxLogReader.js src/metricsCollector.js src/register.js package.json)

say()  { echo -e "\033[1;36m[itupulse]\033[0m $*"; }
fail() { echo -e "\033[1;31m[itupulse] ERROR:\033[0m $*" >&2; exit 1; }

# ---- Repo fetch: token-authenticated GitHub API for private repos,
#      plain raw.githubusercontent for public repos. ----
gh_fetch() {
  # $1 = repo-relative path, $2 = output file
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

# ---- 1. Preconditions ----
[ "$(id -u)" -eq 0 ] || fail "run as root: sudo bash install.sh"
[ -d /run/systemd/system ] || fail "systemd is required"
grep -qiE 'ubuntu|debian|centos|rhel|rocky|alma|fedora' /etc/os-release 2>/dev/null \
  || say "WARNING: untested distribution — continuing anyway"

# ---- 2. Node.js >= 18 ----
if command -v node >/dev/null 2>&1 && [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 18 ]; then
  say "Node.js $(node -v) found"
else
  say "Installing Node.js 20 LTS…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    dnf install -y nodejs >/dev/null
  else
    fail "no supported package manager found — install Node.js >= 18 manually, then re-run"
  fi
fi

# ---- 3. Dedicated restricted user (no shell, no home login) ----
if ! id itupulse >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin itupulse
  say "created system user 'itupulse'"
fi
# Read access to nginx logs (commonly group 'adm' on Debian/Ubuntu)
if [ -d /var/log/nginx ]; then
  getent group adm >/dev/null && usermod -aG adm itupulse || true
fi

# ---- 4. Directories ----
mkdir -p "$APP_DIR/src" "$ETC_DIR" "$STATE_DIR" "$LOG_DIR"
chown root:root "$APP_DIR"
chown itupulse:itupulse "$STATE_DIR" "$LOG_DIR"
chmod 750 "$STATE_DIR" "$LOG_DIR"

# ---- 5. Download agent ----
say "downloading agent…"
for f in "${AGENT_FILES[@]}"; do
  gh_fetch "$f" "$APP_DIR/$f" || fail "download failed: $f (private repo? set ITUPULSE_GH_TOKEN)"
done
gh_fetch "uninstall.sh" "$APP_DIR/uninstall.sh" || say "WARNING: could not fetch uninstall.sh (you can remove manually later)"
gh_fetch "update.sh" "$APP_DIR/update.sh" || say "WARNING: could not fetch update.sh"
echo "1.0.0" > "$APP_DIR/VERSION"
chown -R root:itupulse "$APP_DIR"
chmod -R 750 "$APP_DIR"

# ---- 6. Gather configuration ----
if [ -t 0 ]; then
  read -rp "ITUPulse API URL [https://itupulseagentapi.indotruck-utama.co.id:4000]: " API_URL
  read -rp "Install key (from dashboard): " INSTALL_KEY
  read -rp "Server name [$(hostname)]: " SERVER_NAME
  read -rp "Environment [production]: " ENVIRONMENT
  read -rp "Access log to monitor [/var/log/nginx/access.log]: " ACCESS_LOG
else
  # piped install (curl | bash): values must come from environment
  API_URL="${ITUPULSE_API_URL:-}"
  INSTALL_KEY="${ITUPULSE_INSTALL_KEY:-}"
  SERVER_NAME="${ITUPULSE_SERVER_NAME:-}"
  ENVIRONMENT="${ITUPULSE_ENVIRONMENT:-}"
  ACCESS_LOG="${ITUPULSE_ACCESS_LOG:-}"
fi
API_URL="${API_URL:-https://itupulseagentapi.indotruck-utama.co.id:4000}"
SERVER_NAME="${SERVER_NAME:-$(hostname)}"
ENVIRONMENT="${ENVIRONMENT:-production}"
[ -n "$INSTALL_KEY" ] || fail "install key is required (set ITUPULSE_INSTALL_KEY when piping)"

# Access log to tail: NGINX's, OR an app's own request log (JSON lines auto-detected).
ACCESS_LOG="${ACCESS_LOG:-/var/log/nginx/access.log}"
[ -f "$ACCESS_LOG" ] || say "WARNING: $ACCESS_LOG not found yet — agent will poll until it appears (set ITUPULSE_ACCESS_LOG to your app log)"

# ---- 7. Write env file (restricted permissions per spec) ----
cat > "$ETC_DIR/agent.env" <<ENVEOF
ITUPULSE_API_URL=$API_URL
ITUPULSE_INSTALL_KEY=$INSTALL_KEY
ITUPULSE_SERVER_NAME=$SERVER_NAME
ITUPULSE_ENVIRONMENT=$ENVIRONMENT
ITUPULSE_ACCESS_LOG=$ACCESS_LOG
ITUPULSE_METRIC_INTERVAL_MS=15000
ITUPULSE_LOG_BATCH_SIZE=100
ITUPULSE_STATE_DIR=$STATE_DIR
ITUPULSE_INSECURE_TLS=${ITUPULSE_INSECURE_TLS:-false}
ENVEOF
chown root:itupulse "$ETC_DIR/agent.env"
chmod 640 "$ETC_DIR/agent.env"
say "wrote $ETC_DIR/agent.env (640 root:itupulse)"

# ---- 8. systemd unit ----
gh_fetch "systemd/itupulse-agent.service" "$SERVICE" || fail "download failed: systemd unit"
systemctl daemon-reload

# ---- 9. Registration test (runs as itupulse, exactly like the service will) ----
say "testing registration…"
if sudo -u itupulse ITUPULSE_ENV_FILE="$ETC_DIR/agent.env" node -e "
  require('$APP_DIR/src/register.js').register().then(ok => process.exit(ok ? 0 : 1));
"; then
  say "registration OK"
else
  fail "registration failed — check install key, API URL, and network. Nothing was started."
fi

# ---- 10. Enable + start ----
systemctl enable itupulse-agent >/dev/null
systemctl restart itupulse-agent
sleep 2
systemctl --no-pager --lines=5 status itupulse-agent || true

say ""
say "ITUPulse Agent installed and running."
say "  status : sudo systemctl status itupulse-agent"
say "  logs   : journalctl -u itupulse-agent -f"
say "  update : sudo bash /opt/itupulse-agent/update.sh"
say "  remove : sudo bash /opt/itupulse-agent/uninstall.sh"
