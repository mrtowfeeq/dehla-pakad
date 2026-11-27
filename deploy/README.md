# Deploying Dehla Pakad to the Hostinger VPS

This is the procedure for our own Ubuntu VPS: Nginx serves the React build and proxies `/api` to a single
Uvicorn process; Clerk handles sign-in; MongoDB Atlas holds the data; coturn relays voice. Nothing here
runs automatically. Deploy only after explicit approval and a successful local test run (see `AGENTS.md`).

**Do not assume the VPS is empty.** Every step below first checks what is already there and never
overwrites an existing file without keeping a copy. Stop and ask if a check finds something unexpected.

Files in this folder:

| File | Goes to |
|---|---|
| `systemd/dehla-pakad.service` | `/etc/systemd/system/dehla-pakad.service` |
| `nginx/dehlapakad.tech.http-only.conf` | `/etc/nginx/sites-available/dehlapakad.tech` — step 1, until the certificate exists |
| `nginx/dehlapakad.tech.conf` | `/etc/nginx/sites-available/dehlapakad.tech` — step 2, the real site |
| `scripts/deploy.sh`, `rollback.sh`, `backup.sh` | run from `/opt/dehla-pakad/repo/deploy/scripts/` |
| `coturn/turnserver.conf.example` | `/etc/turnserver.conf` (fill in) |

## 0. Confirm before the first deploy (read-only)

Run these and keep the output; none of them change anything:

```bash
lsb_release -a; nproc; free -h; df -h /              # OS, CPU, RAM (frontend build needs ~2 GB incl. swap), disk
ss -tlnp; ss -ulnp                                     # who listens on 22/80/443/3478/5349/8000
systemctl list-units --type=service --state=running   # nginx/apache/openlitespeed/docker/coturn/panels
ls -la /opt /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
grep -Rn "dehlapakad\|connection_upgrade" /etc/nginx 2>/dev/null
id dehla; ls -la /opt/dehla-pakad 2>/dev/null; systemctl status dehla-pakad 2>/dev/null | head -3
ls /etc/letsencrypt/live 2>/dev/null; ls -la /etc/turnserver.conf 2>/dev/null
node -v; npm -v; python3.12 --version; git --version; mongodump --version 2>/dev/null
sudo ufw status verbose; sudo grep -E "^\s*Port " /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null
```

Also confirm:

- Hostinger template / control panel (some own ports 80/443), Hostinger's panel firewall rules, the
  VPS public IPv4 (and IPv6, if any), and the SSH port.
- Whether an older deployment of dehlapakad.tech (or its data) exists, and what happens to it.
- DNS: `dehlapakad.tech` and `www` A (and AAAA only if IPv6 works) records point to the VPS.
- MongoDB Atlas: cluster and tier, backups enabled, the IP access list, and a production `DB_NAME` that
  is separate from development/preview (and whether it already holds data).
- Clerk: a **production** instance for `dehlapakad.tech` (section 6).
- Where TURN will run (this VPS or another host) and its public IP.

## 1. One-time server setup (only what is missing)

Install only packages that are not there yet. Do **not** run `apt upgrade -y` on a shared box: it can
restart other services. Upgrade in a planned maintenance window instead.

```bash
sudo apt update
sudo apt install -y nginx certbot python3.12 python3.12-venv git curl ufw   # apt skips installed ones
```

Node.js and Yarn: if `node -v` already shows 18, 20 or 22, keep it (other apps may depend on that
version) and only enable Yarn 1. Install Node only when it is missing:

```bash
command -v node || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs; }
sudo corepack enable && sudo -u dehla corepack prepare yarn@1.22.22 --activate   # after the user exists
```

MongoDB Database Tools (`mongodump`, `mongorestore`): install the Ubuntu package from mongodb.com.

The service user and folders (stops if they already exist instead of taking them over):

```bash
id dehla 2>/dev/null && echo "user dehla already exists: STOP and review" || \
  sudo adduser --system --group --home /opt/dehla-pakad --shell /bin/bash dehla
[ -e /opt/dehla-pakad/repo ] && echo "/opt/dehla-pakad/repo exists: STOP and review"
sudo install -d -o dehla -g dehla -m 755 /opt/dehla-pakad /opt/dehla-pakad/releases /opt/dehla-pakad/shared
sudo install -d -o dehla -g dehla -m 700 /opt/dehla-pakad/shared/backups
sudo install -d -m 755 /var/www/certbot
sudo -u dehla git clone <github repo url> /opt/dehla-pakad/repo      # private repo: use a read-only deploy key
```

Let the `dehla` user run only these root commands without a password (paths are the real ones on Ubuntu
24.04; `sudo -n -l /usr/bin/systemctl restart dehla-pakad` as `dehla` must succeed). Create it with
`sudo visudo -f /etc/sudoers.d/dehla`:

```
dehla ALL=(root) NOPASSWD: /usr/bin/systemctl restart dehla-pakad, /usr/bin/systemctl stop dehla-pakad, /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t
```

## 2. Secrets (server only, never in git)

`/opt/dehla-pakad/shared/backend.env`, owned by `dehla`, `chmod 600`. Start from `backend/.env.example`:

| Variable | Production value |
|---|---|
| `MONGO_URL` | Atlas connection string for the production cluster |
| `DB_NAME` | the production database name (not the development one) |
| `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | **live** keys (`pk_live_…`, `sk_live_…`); live keys put the app in the `live` data scope |
| `ADMIN_EMAIL` | verified email(s) that become admin on first sign-in |
| `CORS_ORIGINS` | leave empty (site and API share one domain) or `https://dehlapakad.tech` |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/32` (Nginx connects over loopback) |
| `VOICE_TURN_URLS`, `VOICE_TURN_SHARED_SECRET` | from section 7 |
| `API_DOCS` | leave unset (API docs are off for live keys) |

Optional `/opt/dehla-pakad/shared/frontend.env`: only if the API is on a different domain
(`REACT_APP_BACKEND_URL=https://…`). Without it the site calls `/api` on its own domain.

## 3. Backend service

```bash
[ -e /etc/systemd/system/dehla-pakad.service ] && echo "a dehla-pakad.service already exists: STOP and review"
sudo cp --no-clobber /opt/dehla-pakad/repo/deploy/systemd/dehla-pakad.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable dehla-pakad     # starts with the first deploy
```

Always exactly **one** worker: games, turn timers, matchmaking queues, voice rooms and rate limits live in
that process. Never add `--workers 2` or run two copies. Port 8000 must be free (deploy.sh refuses to
continue if something else listens there).

## 4. Nginx and SSL (two steps)

The real site config needs the certificate, so the first certificate is issued with a port-80-only config.
Neither step touches other sites; `nginx -t` checks everything before any reload.

```bash
# Step 1: port 80 only (no certificate files referenced)
[ -e /etc/nginx/sites-available/dehlapakad.tech ] && sudo cp -a /etc/nginx/sites-available/dehlapakad.tech /root/dehlapakad.tech.nginx.bak
sudo cp /opt/dehla-pakad/repo/deploy/nginx/dehlapakad.tech.http-only.conf /etc/nginx/sites-available/dehlapakad.tech
sudo ln -sfn /etc/nginx/sites-available/dehlapakad.tech /etc/nginx/sites-enabled/dehlapakad.tech
sudo nginx -t && sudo systemctl reload nginx

# Certificate by webroot (does not edit any Nginx file); reload Nginx automatically on every renewal
sudo certbot certonly --webroot -w /var/www/certbot -d dehlapakad.tech -d www.dehlapakad.tech \
  --deploy-hook "systemctl reload nginx"

# Step 2: the real site
sudo cp /opt/dehla-pakad/repo/deploy/nginx/dehlapakad.tech.conf /etc/nginx/sites-available/dehlapakad.tech
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```

If `nginx -t` reports a conflicting `server_name` or a duplicate variable, another site is already
configured for this domain: stop and review, do not delete the other config. Remove the `[::]` listen
lines if the VPS has no IPv6.

The `/api/` location carries REST, the game/voice WebSocket (`/api/ws`, upgrade headers, 1-hour read
timeout) and the Clerk relay (`/api/__clerk`).

## 5. Firewall and MongoDB access

Check what is already allowed and which services other apps need **before** changing anything, and allow
the real SSH port first (a wrong SSH rule locks you out):

```bash
sudo ufw status verbose
SSH_PORT=22            # the port found in section 0
sudo ufw allow "$SSH_PORT/tcp"
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# only if coturn runs here:
sudo ufw allow 3478 && sudo ufw allow 5349/tcp && sudo ufw allow 49160:49200/udp
# keep any rules other services on this box need, then (only if ufw was inactive):
sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw enable
```

Open the same ports in Hostinger's panel firewall if it is used. Port 8000 stays closed (Uvicorn listens
on 127.0.0.1 only). In Atlas, add the VPS public IP to the access list and remove `0.0.0.0/0`. Use a
database user limited to the production database.

## 6. Clerk production instance

In the Clerk dashboard, create/confirm the production instance for `dehlapakad.tech`:

- Domain `dehlapakad.tech`; **proxy URL `https://dehlapakad.tech/api/__clerk`** (the backend relays Clerk's
  Frontend API there automatically when it has `pk_live_` keys, so no `clerk.` DNS record is needed).
  Add the email DNS records (SPF/DKIM) Clerk lists for sending mail from the domain.
- Allowed origins / redirect URLs for `https://dehlapakad.tech`.
- Email + password sign-in and verification as in development; email delivery verified.
- Copy the live keys into `backend.env` only. A production instance has its own users and the app keeps
  `live` data separate from `preview`, so production starts with no players from development.

## 7. Voice relay (TURN)

Voice works peer to peer with STUN, but players on mobile data or strict networks need a TURN relay.

```bash
[ -e /etc/turnserver.conf ] && sudo cp -a /etc/turnserver.conf /root/turnserver.conf.bak   # keep any existing config
sudo apt install -y coturn
sudo cp /opt/dehla-pakad/repo/deploy/coturn/turnserver.conf.example /etc/turnserver.conf   # then fill in
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo install -d -o turnserver -g turnserver /var/log/turnserver /etc/turnserver/certs
```

coturn runs as `turnserver`, which cannot read Let's Encrypt keys. Give it its own copy on every renewal
with a certbot deploy hook, `/etc/letsencrypt/renewal-hooks/deploy/coturn.sh` (chmod 755):

```bash
#!/bin/sh
install -o turnserver -g turnserver -m 640 /etc/letsencrypt/live/dehlapakad.tech/fullchain.pem /etc/turnserver/certs/fullchain.pem
install -o turnserver -g turnserver -m 600 /etc/letsencrypt/live/dehlapakad.tech/privkey.pem  /etc/turnserver/certs/privkey.pem
systemctl restart coturn
```

Run it once by hand, point `cert=`/`pkey=` in `/etc/turnserver.conf` at `/etc/turnserver/certs/…`, then
`sudo systemctl enable --now coturn`. Put the same secret in `VOICE_TURN_SHARED_SECRET` and the URLs in
`VOICE_TURN_URLS` (see the end of the example file), then restart the backend.

## 8. Deploy

1. Locally: all tests pass, then tag the commit (`git tag v1.0.0`) and push the tag (with approval).
2. Check Admin > Overview: no matches in progress.
3. On the VPS: `sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0`

`deploy.sh` first checks, without changing anything: `backend.env` exists, `current` is a symlink (not an
older deployment's folder), the tools are installed, the sudoers rule works, and port 8000 is free or held
by this service. Then it backs up the database, builds the release in its own folder (marked
`INCOMPLETE` until the build succeeds), switches `current`, restarts, and health-checks that the service
is active, **runs from the new release folder** and answers on `/api/`. If anything fails it marks the
release `FAILED` and switches back (on the very first deploy, it stops the service instead).

4. Smoke test: open the site, sign in, confirm the green "Online" status (WebSocket), create a private
   room, add bots, finish a short bot match, check Admin > System health shows all indexes healthy, and
   `journalctl -u dehla-pakad -n 200` has no errors.

What a restart does to data (by design, safe to repeat): retired role names are rewritten, stake entries
held for games that never started are refunded, rooms stuck in "starting" return to the lobby, **public
lobbies are deleted** (their queue is in memory), active games resume from the database, and any medal or
coin settlement interrupted by a crash is completed exactly once.

## 9. Rollback

```bash
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh --list   # releases with ok / FAILED / INCOMPLETE
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder>
```

Prefer naming the folder. Without one, it picks the newest release that is not current and not marked
`FAILED`/`INCOMPLETE`, shows it and asks first. Code-only: newer releases add fields, collections and
indexes that older code ignores, so the database normally stays as it is. Avoid rolling back during stake
matches.

Database recovery (only for confirmed corruption): stop the backend; take a fresh dump of the current
state; restore the chosen archive into a scratch database and check it; then restore into production
with `--drop`, only for the affected collections, in a maintenance window; start the backend and check
Admin > System health.

## 10. Backups and restore drill

- `deploy.sh` takes a `mongodump` before every deploy; also schedule a daily one:
  `0 3 * * * /opt/dehla-pakad/repo/deploy/scripts/backup.sh >> /opt/dehla-pakad/shared/backups/backup.log 2>&1`
  (crontab of `dehla`). Keeps the last 14 archives on the VPS; copy them off the server too.
- Turn on Atlas backups for the cluster (availability depends on the tier).
- Restore drill before inviting users: restore the latest archive into a scratch database
  (`mongorestore --nsFrom "<db>.*" --nsTo "<scratch>.*"`), check it opens, then drop the scratch database.

## 11. Logs and monitoring

- Backend: `journalctl -u dehla-pakad -f` (Uvicorn access + app logs; no tokens or secrets are logged).
- Nginx: `/var/log/nginx/access.log`, `error.log` (rotated by logrotate).
- coturn: `/var/log/turnserver/turn.log`.
- An external uptime check on `https://dehlapakad.tech/api/` (returns `{"message":"Dehla Pakad API"}`).
- Admin > System health: index status, process uptime, connections.
