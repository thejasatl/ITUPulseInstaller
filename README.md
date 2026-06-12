# ITUPulse Agent

Lightweight, **zero-dependency** Node.js monitoring agent installed on customer servers. Reads the NGINX access log and system metrics (`/proc`), and ships them outbound over HTTPS to the ITUPulse backend. The customer's backend code is never copied, changed, restarted, wrapped, or injected.

This repository contains **only** the agent — no dashboard, no backend, no secrets (per the repository-separation spec).

---

## How it works

```
Customer Server
├── Existing Backend API   (unchanged)
├── Existing NGINX         (unchanged)
├── Existing Database      (unchanged)
└── ITUPulse Agent         (standalone systemd service, user: itupulse)
    ├── tails /var/log/nginx/access.log   (read-only)
    ├── reads CPU/RAM/Disk/Network/Uptime (/proc)
    ├── registers once with a one-time install key
    └── sends signed, outbound-only HTTPS requests to the backend
```

The agent accepts **no inbound connections**, executes **no remote commands**, and reads **only** the configured access log and `/proc`. If the backend is unreachable, data is buffered locally (50 MB cap, oldest dropped first) and flushed when connectivity returns — the agent never crashes because the backend is down.

## Install

Generate a one-time install key in the ITUPulse dashboard (Project → Install Keys), then on the target server:

```bash
# interactive (asks for API URL + install key)
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/itupulse-agent/main/install.sh -o install.sh
sudo bash install.sh

# non-interactive (piped)
ITUPULSE_API_URL=https://api.itupulse.com \
ITUPULSE_INSTALL_KEY=itp_xxxxxxxx \
  curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/itupulse-agent/main/install.sh | sudo bash
```

The installer: checks root + systemd + Node ≥ 18 (installs Node 20 if missing), creates the restricted `itupulse` system user (no shell, no home), creates `/opt/itupulse-agent`, `/etc/itupulse`, `/var/lib/itupulse-agent`, `/var/log/itupulse-agent`, writes `agent.env` with `640 root:itupulse`, installs the hardened systemd unit, **runs a registration test before starting anything**, then enables + starts the service. The server appears online in the dashboard within seconds.

```bash
sudo systemctl status itupulse-agent
journalctl -u itupulse-agent -f
```

## Security model

The install key registers **exactly one server** and dies (backend flips it atomically). Registration returns a per-server `serverId` + `agentSecret`, stored at `/var/lib/itupulse-agent/credentials.json` with mode `600` — the raw secret never travels on the wire again. A machine fingerprint `sha256(machine-id + hostname)` is sent at registration.

Every subsequent request is signed:

```
x-itupulse-server:    <serverId>
x-itupulse-timestamp: <unix ms>            # ±5 min window — replay protection
x-itupulse-signature: HMAC-SHA256(key = sha256hex(agentSecret),
                                  msg = `${timestamp}.${rawJsonBody}`)
```

HTTPS is mandatory — the agent refuses to start with an `http://` API URL (override only for local testing with `ITUPULSE_ALLOW_INSECURE=true`). Certificate validation is on (Node default). If the backend revokes the agent (compromised-server handling), the agent detects the 401, wipes its credentials, and stops — re-registration requires a brand-new install key.

systemd hardening: `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, `PrivateTmp`, `MemoryDenyWriteExecute`, read-write limited to its own state/log dirs, NGINX logs mounted read-only, `MemoryMax=200M`, `CPUQuota=20%`.

## Runtime behavior

| Mode | Trigger | Metrics | Log flush |
|---|---|---|---|
| Background | default | every 5 s | every 10 s (batched, ≤100/req) |
| Realtime | dashboard viewer opens this server | every 2 s | every 2 s |

The agent learns the mode from the heartbeat response (`streamingRequested`) every 30 s — no inbound connection needed. Log offset survives restarts (`state.json`); logrotate is handled via inode/truncation detection. Query strings are stripped from endpoints before sending (no sensitive data exfiltration).

## Configuration — /etc/itupulse/agent.env

```ini
ITUPULSE_API_URL=https://api.itupulse.com
ITUPULSE_INSTALL_KEY=itp_xxxxxxxxxxxx     # dead after first registration
ITUPULSE_SERVER_NAME=prod-api-01
ITUPULSE_ENVIRONMENT=production
ITUPULSE_NGINX_ACCESS_LOG=/var/log/nginx/access.log
ITUPULSE_METRIC_INTERVAL_MS=5000
ITUPULSE_LOG_BATCH_SIZE=100
ITUPULSE_STATE_DIR=/var/lib/itupulse-agent
```

## Recommended NGINX log format

Response-time analytics need `$request_time` in the log. The agent parses both standard `combined` and this format (latency will be 0 without `rt=`):

```nginx
log_format itupulse '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent" rt=$request_time';
access_log /var/log/nginx/access.log itupulse;
```

## Module layout

```
src/
├── agent.js            # main loop, mode switching, graceful shutdown
├── config.js           # reads agent.env, enforces HTTPS
├── register.js         # one-time install-key registration + fingerprint
├── credentials.js      # serverId/agentSecret storage (600)
├── nginxLogReader.js   # offset-persistent tail, logrotate-safe
├── nginxParser.js      # combined/itupulse format → JSON
├── metricsCollector.js # CPU/RAM/disk/network/uptime from /proc
├── bufferStore.js      # offline JSONL buffer, 50MB cap, rotation
├── transportHttp.js    # HMAC-signed HTTPS transport
└── logger.js           # JSON logs → journald
```

## Uninstall

```bash
sudo bash uninstall.sh
```

Stops/disables the service and removes `/opt/itupulse-agent`, `/etc/itupulse`, `/var/lib/itupulse-agent`, `/var/log/itupulse-agent`, and the `itupulse` user. Also revoke the server in the dashboard so its credentials are dead backend-side.
