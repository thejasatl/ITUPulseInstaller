# Registration, Uninstall & Multi-API — ITUPulse Agent

## 1. Why "registration failed — fetch failed" happened

`fetch failed` = the agent could not open the HTTPS connection to your API.
It is NOT a key problem (the download + key parsing already succeeded). The
agent now prints the real reason (re-run the install after `git pull` of the
installer, or just read the cause below). Common causes:

| Real cause | Meaning | Fix |
|---|---|---|
| `ECONNREFUSED` | Nothing is listening on `:4000` at that host | Start the API on 4000; confirm `systemctl status` / `pm2 status` of the API |
| `ENOTFOUND` / `EAI_AGAIN` | DNS can't resolve `itupulseagentapi.indotruck-utama.co.id` from this server | Fix DNS, or add a `/etc/hosts` entry to the API's IP |
| `ETIMEDOUT` | Port 4000 is firewalled | Open 4000 (ufw/security group); test from the server |
| `SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `CERT_*` | API's TLS cert is self-signed / not trusted | Use a real CA cert for the domain (Let's Encrypt). Test only: `NODE_TLS_REJECT_UNAUTHORIZED=0` |

### Diagnose in 30 seconds (run ON the server that's installing)

```bash
# DNS
getent hosts itupulseagentapi.indotruck-utama.co.id

# Can we reach the API + is the cert valid?  (drop -k once a real cert is in place)
curl -v https://itupulseagentapi.indotruck-utama.co.id:4000/api/v1/health
curl -vk https://itupulseagentapi.indotruck-utama.co.id:4000/api/v1/health   # -k = ignore cert (proves it's a TLS issue)
```

- `curl` works but `curl -k` is needed  -> **self-signed cert**: install a real cert, or set `NODE_TLS_REJECT_UNAUTHORIZED=0` for a test.
- both fail with "connection refused"     -> API isn't running on 4000.
- both hang/timeout                        -> firewall on 4000.

> The API and the dashboard share the box: 4000 = API (HTTPS), 4001 = API (HTTP),
> 443 = Angular dashboard (untouched). The agent must talk to **4000**.

---

## 2. How the dashboard now knows the install worked

When you click **Create Server**, the dashboard shows the one-time key AND starts
**polling the key's status** every 3 seconds. The modal updates live:

- **Waiting** — key issued, agent hasn't registered yet (run the command).
- **Agent registered** — the agent consumed the key; server record activated.
- **Connected** — server is online and sending heartbeats. ✅
- **Key expired / revoked** — terminal, generate a new key.
- **Still waiting** (after 5 min) — you can close the modal; the server appears in
  the table automatically once it registers.

So the popup no longer just sits there — it reflects success/failure in real time.
(Note: a pure *network* failure on the server, like the cert error above, never
reaches the API, so the modal stays on **Waiting** — check the server's terminal
output for the cause in that case.)

Backend endpoint powering this: `GET /api/v1/dashboard/install-keys/:id/status`.

---

## 3. Uninstall

The installer now drops the uninstaller on the box:

```bash
sudo bash /opt/itupulse-agent/uninstall.sh
```

Or fetch it directly (repo public):

```bash
curl -fsSL https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/uninstall.sh | sudo bash
```

It stops + removes the service (systemd **and** pm2), deletes
`/opt/itupulse-agent`, `/etc/itupulse`, `/var/lib/itupulse-agent`,
`/var/log/itupulse-agent`, and the `itupulse` user.

**Important:** also **delete/revoke the server in the dashboard** (Servers → Delete)
to invalidate its credentials backend-side. Uninstalling only removes the local
agent; the server record + agentSecret live in the database until you remove them.

---

## 4. One server hosting more than one API — how it's handled

The model is **one agent = one machine = one server record** in the dashboard.
The agent tails **one NGINX access log** (`ITUPULSE_NGINX_ACCESS_LOG`).

- **Multiple APIs behind the same NGINX (one access.log):** already fully handled.
  Every request to every API/site on that box is in the same access log, and the
  dashboard separates them by **endpoint path** (e.g. `/api/v1/orders`,
  `/payments/charge`). You see per-endpoint hits, latency, and error rates across
  all the APIs on that server. Nothing extra to do.

- **Each API writes to its OWN separate log file:** the agent reads only the one
  file you configure. Two options:
  1. Point the agent at NGINX's **combined** access log (recommended — configure
     all server blocks to log to `/var/log/nginx/access.log`), so one agent sees
     everything; or
  2. Run **one agent process per log file**. The current packaging is one
     systemd/pm2 unit per machine, so this would mean a second unit with its own
     env file and its own server record (and its own install key). Treat each as a
     separate "server" in the dashboard.

- **System metrics (CPU/RAM/disk)** are per-machine, so they're reported once for
  the whole box regardless of how many APIs run on it.

Rule of thumb: if all your APIs log to one NGINX access log, a single agent covers
them all and you do nothing special. Only split into multiple agents if your APIs
keep strictly separate log files and you want them as separate dashboard servers.
