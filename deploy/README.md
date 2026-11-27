# Deploying Dehla Pakad to the Hostinger VPS

Nginx serves the React build and proxies `/api` to a single Uvicorn process; Clerk handles sign-in; MongoDB
Atlas holds the data; coturn relays voice. Nothing here runs automatically. Deploy only after explicit
approval and a successful local test run (see `AGENTS.md`).

**Do not assume the VPS is empty.** Every command below either only reads, or skips itself when the thing
it would create already exists, or keeps a copy before replacing a file. When a check prints `STOP`, stop
and review before continuing.

| File | Goes to |
|---|---|
| `systemd/dehla-pakad.service` | `/etc/systemd/system/dehla-pakad.service` |
| `nginx/dehlapakad.tech.http-only.conf` | `/etc/nginx/sites-available/dehlapakad.tech` — until the certificate exists |
| `nginx/dehlapakad.tech.conf` | `/etc/nginx/sites-available/dehlapakad.tech` — the real site |
| `coturn/turnserver.conf.example` | `/etc/turnserver.conf` (fill in) |
| `coturn/certbot-deploy-hook.sh` | `/etc/letsencrypt/renewal-hooks/deploy/coturn.sh` |
| `scripts/deploy.sh`, `rollback.sh`, `backup.sh`, `active_matches.py` | run from `/opt/dehla-pakad/repo/deploy/scripts/` |

See also `docs/admin-security-deployment.md` (database scoping, old global indexes, proxy trust).

## 0. Confirm before the first deploy (read-only)

```bash
lsb_release -a; nproc; free -h; df -h /              # Ubuntu 24.04? RAM (the frontend build needs ~2 GB incl. swap), disk
ss -tlnp; ss -ulnp                                     # who listens on 22/80/443/3478/5349/8000
systemctl list-units --type=service --state=running   # nginx/apache/openlitespeed/docker/coturn/panels
ls -la /opt /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
grep -Rn "dehlapakad\|connection_upgrade" /etc/nginx 2>/dev/null
id dehla; ls -la /opt/dehla-pakad 2>/dev/null; systemctl status dehla-pakad 2>/dev/null | head -3
ls /etc/letsencrypt/live 2>/dev/null; ls -la /etc/turnserver.conf 2>/dev/null
node -v; corepack --version; yarn -v; python3.12 --version; git --version; mongodump --version 2>/dev/null
sudo ufw status verbose; sudo grep -E "^\s*Port " /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null
```

Also confirm: the Hostinger template / control panel (some own ports 80/443) and Hostinger's panel firewall;
the VPS public IPv4 (and IPv6, if any) and the SSH port; whether an older deployment of dehlapakad.tech (or
its data) exists and what happens to it; DNS `dehlapakad.tech` and `www` A (AAAA only if IPv6 works)
records; MongoDB Atlas cluster, tier, backups, IP access list and a production `DB_NAME` separate from
development (and whether it already holds data — see the old-indexes note in
`docs/admin-security-deployment.md`); a Clerk **production** instance (section 7); where TURN runs.

## 1. Code on GitHub

The server deploys tags from GitHub, so the deployment files must be on the branch and tag it fetches.
Today they exist only on `feature/private-lobby-chat` (not on `main`). With approval: push the branch,
merge it into `main` (or deploy from the branch), then tag the tested commit, e.g. `v1.0.0`, and push
the tag.

## 2. One-time server setup (only what is missing)

Do **not** run `apt upgrade -y` on a shared box (it can restart other services); upgrade in a planned
maintenance window instead.

```bash
sudo apt update
sudo apt install -y nginx certbot python3.12 python3.12-venv git curl ufw   # apt skips installed ones
# MongoDB Database Tools (mongodump, mongorestore): install the Ubuntu package from mongodb.com
```

The service user and folders. Each line skips itself if the thing already exists, and prints STOP:

```bash
if id dehla >/dev/null 2>&1; then echo "STOP: user dehla already exists"; else
  sudo adduser --system --group --home /opt/dehla-pakad --shell /bin/bash dehla && sudo chmod 755 /opt/dehla-pakad; fi
# releases must be readable by Nginx (www-data serves the build); shared holds secrets and backups
for spec in "releases 755" "shared 750" "shared/backups 700"; do set -- $spec; d="/opt/dehla-pakad/$1"
  if [ -e "$d" ]; then echo "STOP: $d already exists"; else sudo install -d -o dehla -g dehla -m "$2" "$d"; fi
done
sudo test -d /var/www/certbot || sudo install -d -m 755 /var/www/certbot
if [ -e /opt/dehla-pakad/repo ]; then echo "STOP: /opt/dehla-pakad/repo already exists"; else
  sudo -u dehla git clone <github repo url> /opt/dehla-pakad/repo; fi     # private repo: a read-only deploy key
```

Node.js and Yarn 1. If `node -v` already shows 18, 20 or 22, keep it (other apps may depend on it):

```bash
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs; }
# Yarn 1 for the dehla user: corepack if this Node has it, otherwise a global yarn 1
if command -v corepack >/dev/null; then sudo corepack enable && sudo -u dehla corepack prepare yarn@1.22.22 --activate
else sudo npm install -g yarn@1.22.22; fi
sudo -u dehla yarn -v    # must print 1.22.x
```

Let `dehla` run exactly these root commands without a password (real Ubuntu 24.04 paths). Create with
`sudo visudo -f /etc/sudoers.d/dehla`:

```
dehla ALL=(root) NOPASSWD: /usr/bin/systemctl restart dehla-pakad, /usr/bin/systemctl stop dehla-pakad, /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t
```

Check: `sudo -u dehla sudo -n -l /usr/bin/systemctl restart dehla-pakad` prints the command.

## 3. Secrets (server only, never in git)

```bash
sudo test -e /opt/dehla-pakad/shared/backend.env && echo "STOP: backend.env already exists" || \
  sudo install -o dehla -g dehla -m 600 /dev/null /opt/dehla-pakad/shared/backend.env
sudo -u dehla nano /opt/dehla-pakad/shared/backend.env      # fill in from backend/.env.example
```

Keep every line plain `NAME=value` (systemd does not allow comments after a value).

| Variable | Production value |
|---|---|
| `MONGO_URL` | Atlas connection string for the production cluster |
| `DB_NAME` | the production database name (letters, digits, `_`, `-`; not the development one) |
| `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | **live** keys (`pk_live_…`, `sk_live_…`); live keys put the app in the `live` data scope |
| `ADMIN_EMAIL` | verified email(s) that become admin on first sign-in |
| `CORS_ORIGINS` | leave empty (site and API share one domain) or `https://dehlapakad.tech` |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/32` (Nginx connects over loopback) |
| `VOICE_TURN_URLS`, `VOICE_TURN_SHARED_SECRET` | from section 8 |
| `API_DOCS` | leave unset (API docs are off for live keys) |

Optional `/opt/dehla-pakad/shared/frontend.env` (same `install -m 600` way): only if the API is on a
different domain (`REACT_APP_BACKEND_URL=https://…`). Without it the site calls `/api` on its own domain.

## 4. Firewall (before the certificate, which needs port 80)

Look at what is allowed and what other services need **first**, and allow the real SSH port before
anything else (a wrong SSH rule locks you out). TURN ports are opened later, in section 8.

```bash
sudo ufw status verbose
SSH_PORT=22            # the port found in section 0
sudo ufw allow "$SSH_PORT/tcp"
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# keep any rules other services on this box need; then, only if ufw was inactive:
sudo ufw status | grep -q "Status: active" || { sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw enable; }
```

Open the same ports in Hostinger's panel firewall if it is used. Port 8000 stays closed (Uvicorn listens
on 127.0.0.1 only). In Atlas, add the VPS public IP to the access list and remove `0.0.0.0/0`; use a
database user limited to the production database.

## 5. Backend service

```bash
if [ -e /etc/systemd/system/dehla-pakad.service ]; then echo "STOP: a dehla-pakad.service already exists"; else
  sudo cp /opt/dehla-pakad/repo/deploy/systemd/dehla-pakad.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable dehla-pakad; fi
```

It starts with the first deploy. Always exactly **one** worker: games, turn timers, matchmaking queues,
voice rooms and rate limits live in that process; never add `--workers 2` or run two copies. Port 8000
must be free (deploy.sh refuses to continue if something else listens there).

## 6. Nginx and SSL (two steps)

Neither step touches other sites. After each `nginx -t`, also check its output for **warnings**: a
"conflicting server name" is only a warning, `nginx -t` still passes, and Nginx would silently use the
other site.

```bash
NGX=/etc/nginx/sites-available/dehlapakad.tech; NGE=/etc/nginx/sites-enabled/dehlapakad.tech
# keep copies of anything already there (including a plain file in sites-enabled)
for f in "$NGX" "$NGE"; do [ -e "$f" ] && sudo cp -a "$f" "/root/$(basename "$(dirname "$f")")-dehlapakad.tech.bak"; done

# Step 1: port 80 only (no certificate files referenced)
sudo cp /opt/dehla-pakad/repo/deploy/nginx/dehlapakad.tech.http-only.conf "$NGX"
sudo ln -sfn "$NGX" "$NGE"
sudo nginx -t 2>&1 | tee /tmp/nginx-t.txt; grep -qi "conflicting server name" /tmp/nginx-t.txt && echo "STOP: another site uses this name"
sudo nginx -t && sudo systemctl reload nginx

# Certificate by webroot (edits no Nginx file); Nginx reloads automatically on every renewal
sudo certbot certonly --webroot -w /var/www/certbot -d dehlapakad.tech -d www.dehlapakad.tech \
  --deploy-hook "systemctl reload nginx"

# Step 2: the real site
sudo cp /opt/dehla-pakad/repo/deploy/nginx/dehlapakad.tech.conf "$NGX"
sudo nginx -t 2>&1 | tee /tmp/nginx-t.txt; grep -qi "conflicting server name" /tmp/nginx-t.txt && echo "STOP: another site uses this name"
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Remove the `[::]` listen lines if the VPS has no IPv6. The site sends a report-only Content-Security-
Policy: after the first smoke test, open the browser console; when it shows no CSP reports (the inline
error-filter script in `index.html` will report until it is moved to a file), switch the header name to
`Content-Security-Policy`. `/api/` carries REST, the game/voice WebSocket (`/api/ws`, 1-hour read timeout)
and the Clerk relay (`/api/__clerk`). Text assets are gzip-compressed by this site's server block.

## 7. Clerk production instance

In the Clerk dashboard, create/confirm the production instance for `dehlapakad.tech`:

- Domain `dehlapakad.tech`; **proxy URL `https://dehlapakad.tech/api/__clerk`** (the backend relays Clerk's
  Frontend API there automatically when it has `pk_live_` keys, so no `clerk.` DNS record is needed). Add
  the email DNS records (SPF/DKIM) Clerk lists for sending mail from the domain.
- Allowed origins / redirect URLs for `https://dehlapakad.tech`.
- Email + password sign-in and verification as in development; email delivery verified.
- Copy the live keys into `backend.env` only. A production instance has its own users and the app keeps
  `live` data separate from `preview`, so production starts with no players from development.

## 8. Voice relay (TURN)

Install, then **stop it at once** so it never runs with the default configuration, and open its ports only
after it is configured:

```bash
[ -e /etc/turnserver.conf ] && sudo cp -a /etc/turnserver.conf /root/turnserver.conf.bak
sudo apt install -y coturn
sudo systemctl stop coturn; sudo systemctl disable coturn
sudo cp /opt/dehla-pakad/repo/deploy/coturn/turnserver.conf.example /etc/turnserver.conf
sudo nano /etc/turnserver.conf         # external-ip and static-auth-secret (comments only on their own lines)
sudo install -d -o turnserver -g turnserver /var/log/turnserver
sudo install -o root -g root -m 755 /opt/dehla-pakad/repo/deploy/coturn/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
sudo RENEWED_LINEAGE=/etc/letsencrypt/live/dehlapakad.tech /etc/letsencrypt/renewal-hooks/deploy/coturn.sh   # first copy of the certificate
sudo systemctl enable --now coturn && sudo systemctl status coturn --no-pager | head -5
sudo ufw allow 3478 && sudo ufw allow 5349/tcp && sudo ufw allow 49160:49200/udp
```

Put the same secret in `VOICE_TURN_SHARED_SECRET` and the URLs in `VOICE_TURN_URLS` (see the end of the
example file), then restart the backend (`sudo systemctl restart dehla-pakad`, outside match hours).
The hook acts only for this site's certificate and restarts coturn only when it is running.

## 9. Deploy

1. Locally: all tests pass; the tag is pushed (section 1).
2. On the VPS, put the checkout on the tag (so the scripts that run are that release's scripts), then deploy:

```bash
sudo -u dehla git -C /opt/dehla-pakad/repo fetch --tags origin
sudo -u dehla git -C /opt/dehla-pakad/repo checkout --detach v1.0.0
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0
```

`deploy.sh`: takes a lock (one deploy/rollback at a time); checks `backend.env`, that `current` is a
symlink, the tools, every sudo permission, that port 8000 is free or held by this service, and that the
checkout is clean and exactly at the tag; builds the release (marked `INCOMPLETE` until the build succeeds,
backend from `requirements-prod.txt`); **refuses to switch while matches or public lobbies are in progress**
(`active_matches.py`, read-only; override `ALLOW_ACTIVE=1`); takes a verified backup; asks for a final
confirmation; switches `current`; restarts; and health-checks that the service is active, **runs from the
new release folder** and answers on `/api/`. On failure it marks the release `FAILED` and switches back
(on the very first deploy it stops the service instead).

3. Smoke test: open the site, sign in, confirm the green "Online" status (WebSocket), create a private
   room, add bots, finish a short bot match, check Admin > System health shows all indexes healthy, and
   `journalctl -u dehla-pakad -n 200` has no errors.

What a restart does (by design, safe to repeat): every WebSocket reconnects after a few seconds (the
service closes them within 5 s on stop); retired role names are rewritten; stake entries held for games
that never started are refunded; rooms stuck in "starting" return to the lobby; **public lobbies are
deleted** (their queue is in memory); active games resume from the database, and a turn whose deadline
passed during the restart is auto-played — which is why deploys wait for an empty table.

## 10. Rollback

```bash
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh --list   # releases with ok / FAILED / INCOMPLETE
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder>
```

Prefer naming the folder; without one it picks the newest release that is not current and not marked
`FAILED`/`INCOMPLETE`, shows it and asks. Like a deploy it waits for an empty table (`ALLOW_ACTIVE=1` to
override). If the target does not come up healthy, it is marked `FAILED` and the release that was running
is restored. Code-only: newer releases add fields, collections and indexes that older code ignores.

Database recovery (only for confirmed corruption): stop the backend; take a fresh dump of the current state
(`backup.sh`); restore the chosen archive into a scratch database and check it; then restore into
production with `--drop`, limited to the affected collections with `--nsInclude "<db>.<collection>"`, in a
maintenance window; start the backend and check Admin > System health.

## 11. Backups and restore drill

- `deploy.sh` takes a verified `mongodump` before every switch. Schedule a daily one in the quietest hour
  (crontab of `dehla`):
  `30 4 * * * /opt/dehla-pakad/repo/deploy/scripts/backup.sh >> /opt/dehla-pakad/shared/backups/backup.log 2>&1`
- A dump of one database is **not** point-in-time: writes during the dump can leave collections slightly
  out of step. **Atlas cluster snapshots are the primary, consistent backup** — turn them on (availability
  depends on the tier). The VPS dumps are a secondary copy.
- Copy the VPS dumps off the server (e.g. `rclone copy /opt/dehla-pakad/shared/backups remote:dehla-backups`
  from a daily cron); the VPS keeps only the newest 14.
- Restore drill before inviting users: restore the newest archive into a scratch database
  (`mongorestore … --nsInclude "<db>.*" --nsFrom "<db>.*" --nsTo "<scratch>.*"`), check it opens, then
  drop the scratch database.

## 12. Logs and monitoring

- Backend: `journalctl -u dehla-pakad -f`. Uvicorn's access log always shows `127.0.0.1` (Nginx is the
  client); real client addresses are in the Nginx log and are what the app's rate limits use.
- Nginx: `/var/log/nginx/access.log`, `error.log` (rotated by logrotate).
- coturn: `/var/log/turnserver/turn.log`.
- An external uptime check on `https://dehlapakad.tech/api/` (returns `{"message":"Dehla Pakad API"}`).
- Admin > System health: index status, process uptime, connections.
