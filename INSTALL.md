# ITUPulse Agent — Server Installation Guide

The agent reads the server's NGINX access log + system metrics and ships them
to the ITUPulse API. One install key = one server.

---

## Step 0 — Get an install key (from the dashboard)

1. Open the dashboard → **Servers** → **Create Server**.
2. Pick the **company**, give the server a name + environment.
3. The dashboard shows a one-time **install key** like `itp_xxxxxxxx`.
   Copy it. It activates exactly one server, then it's consumed.

---

## Why your command returned `curl: (22) ... 404`

```
curl -fsSL https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/install.sh | sudo ...
curl: (22) The requested URL returned error: 404
```

`raw.githubusercontent.com` returns **404 for private repositories** when the
request is not authenticated. `thejasatl/ITUPulseInstaller` is **private**, so
the anonymous URL can't see it. (And even if it could, the script then pulls the
agent source files from the same private repo — those would 404 too.)

You have two ways to fix this. Pick ONE.

---

## Option A (recommended) — Make the installer repo public

The repo contains **no secrets**: the install key, API URL, and the per-server
agent secret are all supplied at runtime, never committed. So it is safe to
publish.

1. GitHub → repo **Settings** → **General** → **Danger Zone** →
   **Change repository visibility** → **Public**.
2. Then the original one-liner works as-is:

```bash
curl -fsSL https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/install.sh \
  | sudo ITUPULSE_INSTALL_KEY=itp_YOUR_KEY bash
```

---

## Option B — Keep it private, install with a GitHub token

Create a **fine-grained Personal Access Token** (GitHub → Settings → Developer
settings → Personal access tokens → Fine-grained):
- Repository access: **only** `ITUPulseInstaller`
- Permission: **Contents → Read-only**
- Short expiry (e.g. 7 days) — you only need it during install.

Then bootstrap through the GitHub **API** (which honors the token) and pass the
same token to the script so it can pull the agent files:

```bash
curl -fsSL \
  -H "Authorization: Bearer ghp_YOUR_TOKEN" \
  -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/thejasatl/ITUPulseInstaller/contents/install.sh?ref=main" \
  | sudo ITUPULSE_INSTALL_KEY=itp_YOUR_KEY ITUPULSE_GH_TOKEN=ghp_YOUR_TOKEN bash
```

The script auto-detects the token: if `ITUPULSE_GH_TOKEN` is set it downloads
every file via the authenticated API; otherwise it uses the public raw URL.

> Delete/revoke the token after the install completes.

---

## What the installer does (in order)

1. Checks root + systemd + OS.
2. Installs Node.js 20 LTS if Node ≥ 18 isn't present.
3. Creates the locked-down system user `itupulse` (no shell, no home).
4. Creates `/opt/itupulse-agent`, `/etc/itupulse`, `/var/lib/itupulse-agent`, `/var/log/itupulse-agent`.
5. Downloads the agent source (zero npm dependencies).
6. Prompts for / reads API URL, install key, server name, environment.
7. Writes `/etc/itupulse/agent.env` (perms `640 root:itupulse`).
8. Installs the hardened systemd unit.
9. **Registration test** — registers with the API using the key; nothing starts if this fails.
10. `enable` + `start` the service.

---

## Non-interactive (piped) install — all options

When you pipe `curl | bash` there is no TTY, so pass everything via env vars:

```bash
curl -fsSL <bootstrap-url> | sudo \
  ITUPULSE_INSTALL_KEY=itp_YOUR_KEY \
  ITUPULSE_API_URL=https://itupulseagentapi.indotruck-utama.co.id:4000 \
  ITUPULSE_SERVER_NAME=$(hostname) \
  ITUPULSE_ENVIRONMENT=production \
  ITUPULSE_GH_TOKEN=ghp_YOUR_TOKEN \
  bash
```

(Interactive install — download the script first, then run `sudo bash install.sh`
— will prompt for each value instead.)

---

## After install — verify

```bash
sudo systemctl status itupulse-agent      # should be active (running)
journalctl -u itupulse-agent -f           # live agent logs
```

In the dashboard, the server flips to **online** within a few seconds and API
hits start flowing on the Servers / Logs pages.

## Remove

```bash
sudo bash uninstall.sh
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `curl: (22) ... 404` on `install.sh` | Private repo + anonymous raw URL. Use Option A or B above. |
| `download failed: src/agent.js (private repo? ...)` | Token missing/expired, or repo still private. Set `ITUPULSE_GH_TOKEN`. |
| `registration failed` | Wrong/used install key, wrong API URL, or port 4000 blocked. Generate a fresh key; check `curl -k https://itupulseagentapi.indotruck-utama.co.id:4000/api/v1/health`. |
| Server stays offline | Check `journalctl -u itupulse-agent -f`; confirm the API is reachable on **4000** from this server. |
| No request logs | `/var/log/nginx/access.log` missing or unreadable — confirm NGINX is logging and `itupulse` is in group `adm`. |
