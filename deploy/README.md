# Deploying Dehla Pakad to the Hostinger VPS

This is the procedure for our own Ubuntu VPS: Nginx serves the React build and proxies `/api` to a single
Uvicorn process; Clerk handles sign-in; MongoDB Atlas holds the data; coturn relays voice. Nothing here
runs automatically. Deploy only after explicit approval and a successful local test run (see `AGENTS.md`).

Files in this folder:

| File | Goes to |
|---|---|
| `systemd/dehla-pakad.service` | `/etc/systemd/system/dehla-pakad.service` |
| `nginx/dehlapakad.tech.conf` | `/etc/nginx/sites-available/dehlapakad.tech` (+ symlink in `sites-enabled`) |
| `scripts/deploy.sh`, `rollback.sh`, `backup.sh` | run from `/opt/dehla-pakad/repo/deploy/scripts/` |
| `coturn/turnserver.conf.example` | `/etc/turnserver.conf` (fill in) |

## 0. Confirm before the first deploy

These are not known from the repository and must be checked on the server / dashboards:

- Ubuntu version (`lsb_release -a`), free disk and RAM, what else runs on the box (other sites, an older
  deployment of dehlapakad.tech, an existing Nginx config, anything on ports 80/443/3478/8000).
- DNS: `dehlapakad.tech` (and `www`) A/AAAA records point to the VPS.
- MongoDB Atlas: which cluster and tier, whether backups are enabled, the IP access list, and that the
  production database (`DB_NAME`) is separate from development/preview.
- Clerk: a **production** instance exists for `dehlapakad.tech` (see section 6).
- Where TURN will run (this VPS or another host) and its public IP.

## 1. One-time server setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx python3.12 python3.12-venv git curl ufw
# Node.js 22 LTS + Yarn 1 (the frontend uses yarn.lock)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs && sudo corepack enable && corepack prepare yarn@1.22.22 --activate
# MongoDB Database Tools (mongodump/mongorestore) for backups: install the Ubuntu package from mongodb.com

sudo adduser --system --group --home /opt/dehla-pakad dehla
sudo mkdir -p /opt/dehla-pakad/{releases,shared/backups} /var/www/certbot
sudo chown -R dehla:dehla /opt/dehla-pakad
sudo -u dehla git clone <github repo url> /opt/dehla-pakad/repo
```

Allow the `dehla` user to restart only this service and reload Nginx (`sudo visudo -f /etc/sudoers.d/dehla`):

```
dehla ALL=(root) NOPASSWD: /bin/systemctl restart dehla-pakad, /bin/systemctl reload nginx, /usr/sbin/nginx -t
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
sudo cp /opt/dehla-pakad/repo/deploy/systemd/dehla-pakad.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable dehla-pakad
```

Always exactly **one** worker: games, turn timers, matchmaking queues, voice rooms and rate limits live in
that process. Never add `--workers 2` or run two copies.

## 4. Nginx and SSL

```bash
sudo cp /opt/dehla-pakad/repo/deploy/nginx/dehlapakad.tech.conf /etc/nginx/sites-available/dehlapakad.tech
# First certificate: temporarily serve only the port-80 block, or use: sudo certbot --nginx -d dehlapakad.tech -d www.dehlapakad.tech
sudo ln -s /etc/nginx/sites-available/dehlapakad.tech /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```

The `/api/` location carries REST, the game/voice WebSocket (`/api/ws`, upgrade headers, 1-hour read
timeout) and the Clerk relay (`/api/__clerk`).

## 5. Firewall and MongoDB access

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full'
# only if coturn runs here:
sudo ufw allow 3478 && sudo ufw allow 5349/tcp && sudo ufw allow 49160:49200/udp
sudo ufw enable
```

Port 8000 stays closed (Uvicorn listens on 127.0.0.1 only). In Atlas, add the VPS public IP to the access
list and remove `0.0.0.0/0`. Use a database user limited to the production database.

## 6. Clerk production instance

In the Clerk dashboard, create/confirm the production instance for `dehlapakad.tech`:

- Domain `dehlapakad.tech`; **proxy URL `https://dehlapakad.tech/api/__clerk`** (the backend relays Clerk's
  Frontend API there automatically when it has `pk_live_` keys, so no extra DNS record is needed).
- Allowed origins / redirect URLs for `https://dehlapakad.tech`.
- Email + password sign-in as in development; email delivery settings verified.
- Copy the live keys into `backend.env` only. Live and preview keys use separate user records (`env`
  `live` vs `preview`), so production starts with no players from development.

## 7. Voice relay (TURN)

Voice works peer to peer with STUN, but players on mobile data or strict networks need a TURN relay.

```bash
sudo apt install -y coturn
sudo cp /opt/dehla-pakad/repo/deploy/coturn/turnserver.conf.example /etc/turnserver.conf   # then fill in
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo mkdir -p /var/log/turnserver && sudo chown turnserver /var/log/turnserver
sudo systemctl enable --now coturn
```

Put the same secret in `VOICE_TURN_SHARED_SECRET` and the URLs in `VOICE_TURN_URLS`
(see the end of the example file), then restart the backend.

## 8. Deploy

1. Locally: all tests pass, then tag the commit (`git tag v1.0.0`) and push the tag (with approval).
2. Check Admin > Overview: no matches in progress.
3. On the VPS: `sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0`
   (backs up the database, builds the release in its own folder, switches `current`, restarts, health
   checks, and switches back automatically if the backend does not come up).
4. Smoke test: open the site, sign in, confirm the green "Online" status (WebSocket), create a private
   room, add bots, finish a short bot match, check Admin > System health shows all indexes healthy, and
   `journalctl -u dehla-pakad -n 200` has no errors.

What a restart does to data (by design, safe to repeat): retired role names are rewritten, stake entries
held for games that never started are refunded, rooms stuck in "starting" return to the lobby, **public
lobbies are deleted** (their queue is in memory), active games resume from the database, and any medal or
coin settlement interrupted by a crash is completed exactly once.

## 9. Rollback

```bash
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh          # previous release
sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder>
```

Code-only: newer releases add fields, collections and indexes that older code ignores, so the database
normally stays as it is. Avoid rolling back during stake matches. Restore a database backup only for
confirmed corruption, and rehearse the restore on a separate database first.

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
