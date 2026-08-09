# VM Deployment Guide (Debian Linux)

Self-host the entire game — frontend, API, Socket.IO and MongoDB connection —
on your own Debian VM. No Render, no separate frontend hosting.

```
Internet
   │
   ▼
Nginx :80/:443 (HTTPS termination)   ← optional but recommended
   │  proxy_pass http://127.0.0.1:3001
   ▼
Node/Express :3001  (this project)
   │
   ├── serves dist/ (built Vite frontend)
   ├── /api/*  (login, register, me, emotes, leaderboard)
   ├── /socket.io/  (multiplayer)
   └── MongoDB (Atlas or local mongod)
```

Everything below assumes a fresh Debian VM with sudo access and Node.js >= 18
(Node 20 LTS or newer recommended).

---

## 1. Copy the project to the VM

Either clone the repo (recommended — gets you every tracked file and the
`package-lock.json`):

```bash
cd /opt
sudo apt update && sudo apt install -y git curl
sudo git clone <your-repo-url> fps-game
sudo chown -R $USER:$USER /opt/fps-game
```

…or upload the folder with scp/sftp from your machine. Copy the **whole project
folder** (all assets, `package-lock.json`, etc.) **except** `node_modules/`,
`.env` and `dist/` — those are generated on the VM.

## 2. Enter the project directory

```bash
cd /opt/fps-game
```

## 3. Install dependencies

```bash
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins (faster, deterministic).
If you prefer `npm install`, that works too.

> `bcrypt` ships prebuilt binaries for common Node versions. If your Node
> version is very new or old and the install tries to compile it, you may need
> `sudo apt install -y build-essential python3`.

## 4. Create `.env` from the template

```bash
cp .env.example .env
```

## 5. Put production secrets into `.env`

Edit `.env` with a real editor (e.g. `nano .env`) and set:

| Variable | Required | Value |
|---|---|---|
| `PORT` | no | leave `3001` (must match the Nginx config) |
| `HOST` | no | leave `0.0.0.0` |
| `NODE_ENV` | yes | set to `production` (blocks cross-origin traffic) |
| `MONGODB_URI` | yes | your existing MongoDB connection string (same database used by Render — accounts are preserved) |
| `JWT_SECRET` | yes | run `openssl rand -hex 32` and paste the output |
| `VITE_SERVER_URL` | — | **must be EMPTY or commented out in production** (the game then automatically talks to `window.location.origin`) |
| `CORS_ORIGIN` | no | leave commented out |
| `FIREBASE_*` | no | only if you later wire `server/firebase.js` into the server |

Check that `.env` is not tracked by git: `git status` must not list it
(it is in `.gitignore`).

> Your existing accounts, kills and leaderboard live in MongoDB. Pointing
> `MONGODB_URI` at the same database as before keeps everything. No migration
> needed.

## 6. Build the frontend

```bash
npm run build
```

This creates `./dist` (the production frontend). The server refuses to serve a
missing frontend with a clear warning, so don't skip this step.

## 7. Start the production server

```bash
npm run start
```

or equivalently `npm run start:prod` / `node server/index.js`. Only the
Node/Express/Socket.IO server starts — it serves the frontend AND the API AND
the multiplayer traffic on one port. The server binds `0.0.0.0:3001` and reads
everything from `.env`.

## 8. Test `/health`

From the VM itself:

```bash
curl http://127.0.0.1:3001/health
```

Expect:

```json
{"status":"ok","uptime":3.2,"mongo":"connected"}
```

If `mongo` says `disconnected`, fix `MONGODB_URI` and restart. If the port
cannot open, the server prints a FATAL error explaining why.

## 9. Test the game

```bash
curl http://127.0.0.1:3001/            # must return the game's index.html
curl http://127.0.0.1:3001/api/emotes  # must return the emote manifest JSON
```

Then open `http://<vm-ip>:3001` in a browser, log in and play. Open a second
browser window on another machine to confirm multiplayer works through the same
URL. The Socket.IO handshake can also be spot-checked with:

```bash
curl "http://127.0.0.1:3001/socket.io/?EIO=4&transport=polling"
```

## 10. Run it persistently with systemd

Create the service file (adjust `User` and the path):

```bash
sudo nano /etc/systemd/system/fps-game.service
```

Paste — **edit `User=` and both paths** to match your setup:

```ini
[Unit]
Description=FPS Multiplayer Game (Node/Express/Socket.IO)
After=network.target

[Service]
Type=simple
# EDIT ME: the Linux user that owns the project folder
User=fpsgame
# EDIT ME: full path to the project folder
WorkingDirectory=/opt/fps-game
# Optional: read variables from the project .env (keep .env next to the app)
EnvironmentFile=/opt/fps-game/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> `EnvironmentFile` loads `PORT`, `MONGODB_URI`, `JWT_SECRET`, etc. from your
> `.env`. `NODE_ENV=production` is set explicitly as a safety net.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable fps-game
sudo systemctl start fps-game
```

Useful commands:

```bash
sudo systemctl status fps-game   # status + recent log tail
sudo systemctl restart fps-game  # restart after config/code changes
sudo systemctl stop fps-game     # stop
sudo journalctl -u fps-game -f   # follow live logs
```

Deploying an update later: `git pull`, `npm ci`, `npm run build`,
`sudo systemctl restart fps-game`.

---

## Optional: Nginx reverse proxy + HTTPS

The Node app never binds port 80 — Nginx handles the internet-facing side.

Install:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/fps-game`:

```nginx
server {
    listen 80;
    server_name mygame.example.com;

    # WebSocket support (required for Socket.IO)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long-lived game connections must not be killed by the proxy timeout
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fps-game /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS (free certificate, also rewrites to https automatically):

```bash
sudo certbot --nginx -d mygame.example.com
```

After this, players visit **https://mygame.example.com** and get the frontend,
`/api/*` and Socket.IO — one URL, no ports in the browser.

## Remaining manual steps (outside the project)

1. **DNS**: point `mygame.example.com` at the VM's public IP.
2. **Firewall/router**: allow port 80/443 to the VM (and port 3001 ONLY if you
   want to skip Nginx / play over LAN without a domain).
3. **MongoDB**: make sure the VM can reach the database (Atlas IP allow-list the
   VM's public IP, or run `mongod` locally on the VM).
4. **Secrets**: generate and place real `MONGODB_URI` and `JWT_SECRET` in `.env`.
5. **Backups**: snapshot the VM / back up MongoDB regularly — all accounts and
   kills live in the database, not in the project.
6. **Remove stale test data (recommended)**: `server/accounts.json` contains a
   plaintext password and is NOT used by the production server — delete it:
   `rm server/accounts.json` and, if it is still tracked in git,
   `git rm --cached server/accounts.json`.
