# Updating the agent + getting real data showing

## A. Why RAM / storage / network / live event / RPS / traffic show "no data"

There are only two causes, and they're easy to confirm:

1. **The agent on the server is running OLD code** (the real-GB metrics, the
   JSON log parser, and the systemd fix aren't deployed). → update it (section B).
2. **The agent has no real access log to read** → no request data, so the Live
   API Event Stream, Live API Flow, Realtime RPS, Traffic Over Time, and endpoint
   stats stay empty. CPU/RAM/disk/network come from `/proc` and appear as soon as
   the agent runs; the request-based widgets need an access log (section D).

First, confirm the agent is actually running (not crash-looping):
```
sudo systemctl status itupulse-agent      # want: active (running), not 226/NAMESPACE
journalctl -u itupulse-agent -n 50 --no-pager
```
If you see `status=226/NAMESPACE`, you're on the old unit — update (section B).

## B. Update the agent on a server

The agent files live in `/opt/itupulse-agent`. Re-run the installer to pull the
latest agent + unit (it keeps your existing registration & env):

```
# 1) make sure the repo is reachable (public, or use the token method)
# 2) refresh the systemd unit (has the 226/NAMESPACE fix)
#    NOTE: /etc is root-only — pipe through `sudo tee`, or curl -o fails with (23).
curl -fsSL https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/systemd/itupulse-agent.service \
  | sudo tee /etc/systemd/system/itupulse-agent.service > /dev/null

# 3) refresh the agent source (no re-register needed — credentials are kept)
for f in agent config credentials logger transportHttp bufferStore nginxParser nginxLogReader metricsCollector register; do
  sudo curl -fsSL "https://raw.githubusercontent.com/thejasatl/ITUPulseInstaller/main/src/$f.js" \
    -o "/opt/itupulse-agent/src/$f.js"
done

sudo systemctl daemon-reload
sudo systemctl restart itupulse-agent
journalctl -u itupulse-agent -f
```

(Or simplest: `sudo bash /opt/itupulse-agent/uninstall.sh` then re-run the
install one-liner with a fresh key — clean reinstall.)

> Also remember to RESTART THE API (so the real-GB `buildServerModels` + socket
> logging load) and REBUILD THE DASHBOARD (`ng build --configuration=production`).

## C. Will the agent find the API logs by default?

No magic discovery. It tails exactly **one** file: `ITUPULSE_ACCESS_LOG`
(default `/var/log/nginx/access.log`). The installer now PROMPTS for this path,
and you can change it any time (section D). It auto-detects NGINX vs JSON lines.

## D. Point the agent at your app's log (after install)

```
sudo nano /etc/itupulse/agent.env
#   ITUPULSE_ACCESS_LOG=/opt/itucareer-api/logs/access.log
sudo systemctl restart itupulse-agent
```
The `itupulse` user must be able to read that file/dir. If it's outside the
sandbox-allowed paths, add it to the unit:
```
sudo systemctl edit itupulse-agent
#   [Service]
#   ReadOnlyPaths=-/opt/itucareer-api/logs
sudo systemctl daemon-reload && sudo systemctl restart itupulse-agent
```

## E. More than one API project on one server — how data is taken

One agent = one log file = one "server" record. Three ways to handle multiple
APIs on the same machine:

1. **One combined log (recommended, simplest).** If both APIs sit behind one
   NGINX, or both append to the same access log, point ONE agent at it. The
   dashboard separates them by **endpoint path** (`/api/orders`, `/billing/...`),
   so you see all APIs' traffic, latency, and errors in one server view. CPU/RAM/
   disk are per-machine anyway.

2. **One agent per API (separate dashboards).** If each API has its own log and
   you want them as separate "servers": create a server in the dashboard for each
   (each gives its own install key), then run one agent instance per API. With
   systemd, copy the unit to `itupulse-agent-billing.service` etc., each with its
   own `EnvironmentFile` pointing at that API's log + key + server name. With pm2:
   `ITUPULSE_ENV_FILE=/etc/itupulse/billing.env pm2 start /opt/itupulse-agent/src/agent.js --name itupulse-billing`.

3. **Best practice:** name each server clearly in the dashboard (e.g.
   `itucareer-orders-api`, `itucareer-billing-api`) so the source is obvious.

## F. Should the log path be set at install or from the dashboard?

- **At install / in `agent.env` (current, recommended).** Simple, explicit, no
  extra moving parts. Change = edit env + restart. This is what the installer now
  prompts for.
- **From the Angular dashboard (future option).** Possible, but it needs an agent
  control-channel: the dashboard would store the desired path and the agent would
  fetch it on each heartbeat and reconfigure. That's a real feature (server-side
  config + agent apply logic) — say the word and it can be added. For now the env
  file is the source of truth.

## G. Quick end-to-end verification
```
# on the server
journalctl -u itupulse-agent -f          # see metrics posting + (once log set) log batches
tail -f /opt/itupulse-agent/../logs ...  # or your app log to confirm it's writing

# in the dashboard
# - server flips online, CPU/RAM/disk (real GB)/network populate within ~5s
# - open Realtime Monitor: chip shows LIVE; once the app gets traffic the event
#   stream, RPS, and Traffic Over Time fill in
```
