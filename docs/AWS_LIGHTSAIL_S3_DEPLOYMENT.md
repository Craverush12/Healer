# Host Healer on AWS Lightsail + S3 — Simple End-to-End Plan

This guide is written for **first-time** AWS/Lightsail users. It uses one clear path: no optional branches in the main steps. You will use **FileZilla** to upload your project and get the bot **live** on the internet.

---

## Before You Start: Big Picture

**What we’re building:**

1. **S3 (storage)** — A private bucket holds your audio catalog (`manifest.json`) and MP3 files. The server will copy these to itself when it starts.
2. **Lightsail (server)** — One small Linux server runs your Node.js bot 24/7. It talks to Telegram and receives webhooks from GoHighLevel.
3. **Flow** — When the server boots, it: (1) downloads the latest manifest and audio from S3, (2) starts the bot. Users get the same experience as on your laptop, but the bot is always on.

**You’re live when:**

- From a browser or phone you can open `http://<your-server-ip>:3000/healthz` and see `{"ok":true}`.
- In Telegram, your bot replies to `/start` with the welcome message and menu.
- You can tap Subscribe and Browse and get access/audio (with payments off, Subscribe grants access immediately).

Everything below is to reach that point. HTTPS and a custom domain can be added later (see Phase 9).

---

## One Region for Everything

We use **one AWS region** so you don’t have to think about locations: **US East (N. Virginia)** — `us-east-1`.

- When you create the S3 bucket, choose **us-east-1**.
- When you create the Lightsail instance, choose **US East (Virginia)**.
- Same region = no extra data transfer cost and simpler setup.

---

## Prerequisites (Have These Ready)

| Item | Where to get it |
|------|------------------|
| AWS account | [aws.amazon.com](https://aws.amazon.com) — sign up if needed |
| Telegram bot token | Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` → copy token |
| FileZilla | Already installed (you said you have it) |
| Your Healer project | The folder with `package.json`, `src/`, `audio/`, `scripts/` |

You do **not** need a domain or HTTPS to get live. You’ll use the server’s public IP and port 3000.

---

## Phase 1: Create the Lightsail Server (Do This First)

We create the server first so we know the **region** and **IP** we’ll use everywhere else.

### Step 1.1 — Create the instance

1. Go to [AWS Lightsail](https://lightsail.aws.amazon.com/).
2. Click **Create instance**.
3. **Instance location:** **US East (Virginia)**.
4. **Platform:** Linux/Unix.
5. **Blueprint:** **OS only** → **Ubuntu 22.04 LTS**.
6. **Instance plan:** e.g. **$5 USD** (512 MB RAM). Enough for this bot.
7. **Name:** `healer-bot`.
8. Click **Create instance**.

Wait until the instance state is **Running**.

### Step 1.2 — Attach a static IP (so the IP never changes)

1. In the left menu click **Networking**.
2. **Create static IP**.
3. **Select instance:** choose `healer-bot`.
4. **Name:** `healer-bot-ip`.
5. **Create**.

Write down the **static IP** shown (e.g. `3.xxx.xxx.xxx`). You’ll use it for SSH, FileZilla, and the webhook URL.

### Step 1.3 — Open the app port so the internet can reach your bot

1. Go back to **Instances** → click **healer-bot**.
2. Open the **Networking** tab.
3. Under **IPv4 Firewall**, click **+ Add rule**.
4. **Application:** Custom.
5. **Protocol:** TCP.
6. **Port:** `3000`.
7. Save.

SSH (port 22) is usually already allowed. If not, add a rule for TCP port 22.

### Step 1.4 — Download the SSH key (for SSH and FileZilla)

1. In Lightsail, click your **user/account name** (top right) → **Account**.
2. Open the **SSH keys** tab.
3. Under **Default keys**, find **US East (Virginia)** (or the region you used).
4. Click the **Download** icon. You get a `.pem` file (e.g. `LightsailDefaultKey-us-east-1.pem`).
5. Save it somewhere safe (e.g. `C:\Users\<you>\.ssh\LightsailDefaultKey-us-east-1.pem`).

You need this file to connect via SSH and FileZilla. **Don’t share it or commit it to git.**

---

## Phase 2: Create the S3 Bucket and Upload Audio

S3 will be the single place that holds your manifest and audio files. The server will copy from here on every start.

### Step 2.1 — Create the bucket

1. In AWS, open **S3** (search “S3” in the top search bar).
2. **Create bucket**.
3. **Bucket name:** e.g. `healer-bot-audio-prod` (must be unique across all AWS; change if taken).
4. **Region:** **US East (N. Virginia) / us-east-1**.
5. **Block Public Access:** leave **all four** checkboxes **on** (no public access).
6. **Create bucket**.

### Step 2.2 — Upload manifest and audio files

1. Click your new bucket name.
2. **Upload**.
3. **Manifest:** Drag and drop your local **`audio/manifest.json`** file. It must end up at the **root** of the bucket (key = `manifest.json`). So: upload the file, and in the “Destination” or key field it should be `manifest.json`, not inside a folder.
4. **Audio folder:** In the bucket, click **Create folder**, name it `files`. Open the `files` folder, then **Upload** and add **all your MP3 files** from your local `audio/files/` folder. The keys should look like `files/track1.mp3`, `files/track2.mp3`, etc.

Your bucket should look like:

- `manifest.json` (at root)
- `files/track1.mp3`, `files/track2.mp3`, …

The paths in `manifest.json` should use **only the filename** (e.g. `"filePath": "track1.mp3"`). The app expects paths relative to `audio/files/`.

---

## Phase 3: Create an IAM User So the Server Can Read S3

The server needs permission to read from your bucket. We create a user that can only list and read that bucket.

### Step 3.1 — Create the policy (permission set)

1. In AWS, open **IAM** (search “IAM”).
2. **Policies** → **Create policy**.
3. Open the **JSON** tab. Delete the default text and paste this (replace `healer-bot-audio-prod` with your bucket name if different):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::healer-bot-audio-prod"
    },
    {
      "Sid": "GetObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::healer-bot-audio-prod/*"
    }
  ]
}
```

4. **Next** → **Policy name:** `HealerBotS3ReadOnly` → **Create policy**.

### Step 3.2 — Create the user and attach the policy

1. **IAM** → **Users** → **Create user**.
2. **User name:** `healer-bot-s3-reader`.
3. **Provide user access to the AWS Console:** **No** (we only need programmatic access).
4. **Next**.
5. **Attach policies directly** → search for `HealerBotS3ReadOnly` → check it → **Next** → **Create user**.

### Step 3.3 — Create access keys (save these for Phase 5)

1. Click the user **healer-bot-s3-reader**.
2. **Security credentials** tab → **Access keys** → **Create access key**.
3. Use case: **Application running outside AWS** (or “Other”) → **Next** → **Create access key**.
4. **Copy** the **Access key ID** and **Secret access key** and store them somewhere safe (you’ll paste them on the server in Phase 5). You can’t see the secret again after leaving this page.

---

## Phase 4: Install Software on the Server (SSH)

You’ll run commands on the server using SSH. You can use the **browser-based SSH** in Lightsail (instance → **Connect** → “Connect using SSH”) or your own terminal with the `.pem` key.

**Using your own terminal (with the downloaded .pem):**

```bash
ssh -i "C:\path\to\LightsailDefaultKey-us-east-1.pem" ubuntu@<your-static-ip>
```

Replace the path and `<your-static-ip>` with your values. If you get a permission error, ensure only you can read the key (e.g. `chmod 400 file.pem` on Mac/Linux).

Run these commands **one block at a time** on the server.

### Step 4.1 — Update system and install Node.js 20

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

You should see something like `v20.x.x`.

### Step 4.2 — Install AWS CLI (used by the sync script)

```bash
sudo apt install -y awscli
aws --version
```

### Step 4.3 — Create app directory

```bash
mkdir -p /home/ubuntu/healer
mkdir -p /home/ubuntu/healer/data
mkdir -p /home/ubuntu/healer/audio
mkdir -p /home/ubuntu/healer/audio/files
```

---

## Phase 5: Upload Your Project with FileZilla

You’ll upload the Healer project to `/home/ubuntu/healer` so the server can run it.

### Step 5.1 — Set up the connection in FileZilla

1. Open **FileZilla**.
2. **File** → **Site Manager** (or Ctrl+S).
3. **New site** → name it e.g. `Healer Lightsail`.
4. Set:
   - **Protocol:** **SFTP - SSH File Transfer Protocol**.
   - **Host:** your **static IP** (e.g. `3.xxx.xxx.xxx`).
   - **Logon Type:** **Key file**.
   - **User:** `ubuntu`.
   - **Key file:** Browse to your **.pem** file (e.g. `LightsailDefaultKey-us-east-1.pem`).
5. **Connect**.

If it asks about an unknown host key, accept. You should see the remote side (right) showing `/home/ubuntu`.

### Step 5.2 — What to upload

- **Upload:** Everything in your Healer project **except**:
  - `node_modules` (do **not** upload — we’ll run `npm ci` on the server).
  - `.env` (do **not** upload — we’ll create it on the server so secrets stay off your PC).
- So: upload `package.json`, `package-lock.json`, `src/`, `scripts/`, `audio/` (optional; it will be replaced by S3 sync), `tsconfig.json`, and any other files at the root. You can exclude `.git` if you want.

### Step 5.3 — Where to upload

1. On the **remote** (right) side, go to `/home/ubuntu/healer`. If the folder doesn’t exist, create it (right‑click → Create directory).
2. On the **local** (left) side, go to your Healer project folder.
3. Select all the files and folders to upload (no `node_modules`, no `.env`).
4. Drag them into the remote `healer` folder (or upload). All project files should sit **inside** `/home/ubuntu/healer` (e.g. `/home/ubuntu/healer/package.json`, `/home/ubuntu/healer/src/...`, `/home/ubuntu/healer/scripts/...`).

### Step 5.4 — Install dependencies and build on the server

Back in SSH:

```bash
cd /home/ubuntu/healer
npm ci --omit=dev
npm run build
```

No errors means the app is built and `dist/index.js` exists.

---

## Phase 6: Configure AWS Credentials and S3 Sync on the Server

The server needs the IAM keys so the sync script can read from S3.

### Step 6.1 — Put AWS credentials on the server

On the server (SSH):

```bash
mkdir -p /home/ubuntu/.aws
nano /home/ubuntu/.aws/credentials
```

Paste this (use your real Access key ID and Secret access key from Phase 3):

```ini
[default]
aws_access_key_id = AKIAxxxxxxxxxxxxxxxx
aws_secret_access_key = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Save (Ctrl+O, Enter, Ctrl+X). Then:

```bash
nano /home/ubuntu/.aws/config
```

Paste:

```ini
[default]
region = us-east-1
```

Save and exit. Then lock down the credentials file:

```bash
chmod 600 /home/ubuntu/.aws/credentials
```

### Step 6.2 — Make the sync script executable and test it

The project already includes `scripts/sync-audio-from-s3.sh`. On the server:

```bash
chmod +x /home/ubuntu/healer/scripts/sync-audio-from-s3.sh
```

If your bucket name is **not** `healer-bot-audio-prod`, set it when testing:

```bash
cd /home/ubuntu/healer
export S3_AUDIO_BUCKET=healer-bot-audio-prod
./scripts/sync-audio-from-s3.sh
```

Check that files arrived:

```bash
ls -la audio/
ls -la audio/files/
head -30 audio/manifest.json
```

If you see your manifest and MP3s, S3 sync is working. If you get “access denied” or “no such key”, check the bucket name and IAM policy (Phase 3).

---

## Phase 7: Create .env and Start the Bot

The app reads settings from a `.env` file. Create it **on the server** (don’t upload your local one) so secrets stay on the server.

### Step 7.1 — Create .env on the server

```bash
nano /home/ubuntu/healer/.env
```

Paste and **edit** the values (at least BOT_TOKEN and DB_PATH):

```env
BOT_TOKEN=123456789:ABCdefGHI-paste-your-real-token-here
PORT=3000
DB_PATH=/home/ubuntu/healer/data/bot.sqlite

ENABLE_PAYMENTS=false
ENABLE_STARTUP_AUDIO_RECOVERY=false

WEBHOOK_RAW_BODY_LIMIT_BYTES=262144
RESYNC_COOLDOWN_MINUTES=10
```

Save and exit. Then:

```bash
chmod 600 /home/ubuntu/healer/.env
```

If you use payments later, add the GHL variables as in `env.example`.

### Step 7.2 — Create the systemd service (sync on start, then run bot)

```bash
sudo nano /etc/systemd/system/healer-bot.service
```

Paste (bucket name must match yours; change `healer-bot-audio-prod` if needed):

```ini
[Unit]
Description=Healer Telegram Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/healer

ExecStartPre=/home/ubuntu/healer/scripts/sync-audio-from-s3.sh
Environment=S3_AUDIO_BUCKET=healer-bot-audio-prod

ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/home/ubuntu/healer/.env

[Install]
WantedBy=multi-user.target
```

Save and exit. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable healer-bot
sudo systemctl start healer-bot
sudo systemctl status healer-bot
```

You should see **active (running)**. To follow logs:

```bash
sudo journalctl -u healer-bot -f
```

You should see lines like: SQLite ready, Audio library loaded, HTTP server listening, Telegram bot launched. Press Ctrl+C to stop following logs.

### Step 7.3 — Verify you’re live

1. **Health check:** In your browser or on your phone, open:
   - `http://<your-static-ip>:3000/healthz`  
   You should see: `{"ok":true}`.

2. **Telegram:** Open Telegram, find your bot, send `/start`. You should get the welcome message and the menu (Subscribe, Browse, etc.).

3. **Subscribe + Browse:** With `ENABLE_PAYMENTS=false`, tap Subscribe (you get access immediately), then Browse and play an audio file.

If all three work, **your bot is live.**

---

## Phase 8: Connect GoHighLevel (Only If You Use Payments)

Do this only when you turn on payments (`ENABLE_PAYMENTS=true`).

1. In GoHighLevel, open the place where you configure **webhooks** (e.g. Integrations or Automation).
2. **Webhook URL:**  
   - For now (no HTTPS): `http://<your-static-ip>:3000/webhooks/ghl`  
   - If you add HTTPS later: `https://bot.yourdomain.com/webhooks/ghl`
3. **Authentication:** Prefer **signature (HMAC)** and set the same secret in `.env` as `GHL_WEBHOOK_SECRET`. Or use **token**: add `?token=YOUR_SECRET_TOKEN` to the URL and set `WEBHOOK_TOKEN` in `.env`.
4. **Events:** Enable at least: subscription created/updated/cancelled, payment failed (names may vary in your GHL).
5. Save. After a test subscription, check server logs: `sudo journalctl -u healer-bot -n 50`.

---

## Phase 9: (Optional) Add HTTPS and a Domain

Until now the webhook URL is `http://<ip>:3000/webhooks/ghl`. Some setups require HTTPS. You can add it later:

- **Option A — Lightsail Load Balancer:** Create a load balancer, attach your instance, create a certificate for a domain (e.g. `bot.yourdomain.com`), point DNS to the LB. Set the webhook URL to `https://bot.yourdomain.com/webhooks/ghl`.
- **Option B — Caddy on the server:** Install Caddy on the instance, proxy port 80/443 to `localhost:3000`, use Caddy’s automatic HTTPS with a domain. Point DNS A record to your static IP.

Details are in many Lightsail/Caddy tutorials; the app itself doesn’t change — it still listens on port 3000.

---

## Quick Reference

### “Am I live?”

- Health: `http://<static-ip>:3000/healthz` → `{"ok":true}`
- Telegram: bot replies to `/start`
- Subscribe + Browse work (with payments off, Subscribe grants access)

### Useful server commands

```bash
# Logs
sudo journalctl -u healer-bot -f

# Restart bot (e.g. after editing .env)
sudo systemctl restart healer-bot

# Manual S3 sync (e.g. after updating files in S3)
cd /home/ubuntu/healer && ./scripts/sync-audio-from-s3.sh && sudo systemctl restart healer-bot

# Status
sudo systemctl status healer-bot
```

### What lives where

| Where | What |
|-------|------|
| **S3** | `manifest.json`, `files/*.mp3` (source of truth for audio) |
| **Server** `/home/ubuntu/healer` | App code, `dist/`, `data/bot.sqlite`, `audio/` (filled by sync) |
| **Server** `/home/ubuntu/.aws` | AWS credentials (for S3 sync only) |

### Webhook URL (no HTTPS)

`http://<your-static-ip>:3000/webhooks/ghl`  
With token: `http://<your-static-ip>:3000/webhooks/ghl?token=YOUR_TOKEN`

---

## Audit Notes (Why This Plan Is Shaped This Way)

- **Lightsail before S3 in the doc:** We create the instance first so we know the region and static IP. Then we create S3 in the same region and use that IP for SSH, FileZilla, and the webhook URL.
- **One region (us-east-1):** Simplifies cost and “where is my resource?” for first-timers.
- **Static IP before any app setup:** So the webhook URL and SSH/FileZilla host never change.
- **FileZilla as the main deploy method:** You asked for it; the guide gives exact steps (SFTP, key file, ubuntu, what to upload, where).
- **No “app user” in the main path:** Running as `ubuntu` is fine for a first deploy; a separate app user can be added later for hardening.
- **Sync script tested manually before systemd:** So we don’t start the service and then discover S3 permissions or bucket name are wrong.
- **.env created on the server:** Keeps secrets off your laptop and out of uploads.
- **HTTP first, HTTPS optional:** Gets you to “live” quickly; HTTPS is Phase 9 so it doesn’t block first-time success.
- **Sync runs on every start (ExecStartPre):** So after you update files in S3, a restart is enough to get new audio without re-uploading the whole app.

---

## Internal Review vs This Project

Checked against the Healer codebase:

- **Startup:** `index.ts` loads `loadEnv(process.env)` (from `.env` via dotenv), then `openSqlite(env.DB_PATH)`, then `loadAudioLibrary()`. The library reads `audio/manifest.json` from the current working directory. So the process must run with `WorkingDirectory=/home/ubuntu/healer` and the sync must have run so that `audio/manifest.json` and `audio/files/` exist. The plan does both.
- **DB path:** `DB_PATH` is used as a file path; absolute path `/home/ubuntu/healer/data/bot.sqlite` is correct and the `data/` directory is created in Phase 4.
- **Port:** App uses `env.PORT` (default 3000). Plan uses PORT=3000 and opens 3000 in Lightsail firewall. Health check path is `/healthz`; the app exposes it. All consistent.
- **Sync script:** Repo script `scripts/sync-audio-from-s3.sh` writes to `./audio/manifest.json` and `./audio/files/`. When run with `WorkingDirectory=/home/ubuntu/healer`, that matches what `loadAudioLibrary()` and the rest of the app expect. Verified.
- **No S3 SDK in the app:** The app does not talk to S3; it only reads from the local filesystem after sync. So IAM and S3 are only for the sync script (AWS CLI). Plan matches.

Conclusion: The plan matches how the Healer bot works (env, DB, audio paths, port, health check). No code changes are required for this deployment.

---

## End-to-End Understanding (Narrative)

1. **You create a server** (Lightsail) and give it a fixed IP so the world can reach it.
2. **You put your audio in S3** so it’s stored safely and can be updated without re-deploying the app.
3. **You give the server permission** (IAM user + keys) to read that S3 bucket.
4. **You install Node and the AWS CLI** on the server and upload your Healer code (FileZilla). You build the app there so `dist/index.js` exists.
5. **You configure the server** with AWS credentials and a sync script. On every start, the server pulls the latest manifest and audio from S3 into `audio/` so the app sees up-to-date content.
6. **You add a .env file** on the server (bot token, DB path, port, etc.) and run the app as a system service so it restarts on failure and after reboots.
7. **You open port 3000** so the health check and webhook URL work. You verify with the browser and Telegram.
8. **If you use payments,** you point GoHighLevel’s webhook at `http://<ip>:3000/webhooks/ghl` (or the HTTPS URL after you add a domain).

End-to-end: **S3 holds the content → server syncs it and runs the bot → Telegram and GHL talk to the server on the static IP.** That’s the full path from “nothing” to “bot is live.”

---

## Deployment Checklist (Tick as You Go)

Use this to avoid skipping a step.

- [ ] **Phase 1:** Lightsail instance created (Virginia), static IP attached, port 3000 open, SSH key downloaded
- [ ] **Phase 2:** S3 bucket created (Virginia), `manifest.json` at root, `files/*.mp3` uploaded
- [ ] **Phase 3:** IAM policy `HealerBotS3ReadOnly` created, user `healer-bot-s3-reader` created, access key saved
- [ ] **Phase 4:** SSH works; Node 20 and AWS CLI installed; `/home/ubuntu/healer` and `data/`, `audio/files/` exist
- [ ] **Phase 5:** FileZilla connected (SFTP, key file, ubuntu); project uploaded (no node_modules, no .env); `npm ci` and `npm run build` run on server
- [ ] **Phase 6:** `.aws/credentials` and `.aws/config` on server; sync script run by hand and `audio/` has manifest + files
- [ ] **Phase 7:** `.env` created on server (BOT_TOKEN, DB_PATH, PORT); systemd service created, enabled, started; `status` shows active
- [ ] **Live:** `http://<ip>:3000/healthz` returns `{"ok":true}`, bot replies to `/start`, Subscribe + Browse work
- [ ] **Phase 8 (if payments):** GHL webhook URL set, auth (secret or token) set, events enabled

---

## Troubleshooting (First-Time Friendly)

| Problem | What to check |
|--------|----------------|
| **FileZilla won’t connect** | Host = static IP (not instance name). User = `ubuntu`. Key file = your `.pem`. Protocol = SFTP. |
| **Sync script fails (access denied / NoSuchKey)** | Bucket name in script or `S3_AUDIO_BUCKET` matches S3. IAM policy has correct bucket name in `Resource`. Credentials in `~/.aws/credentials` are for the S3-reader user. Region in `~/.aws/config` is `us-east-1`. |
| **Sync script fails (command not found: aws)** | Run `sudo apt install -y awscli` and try again. |
| **Bot doesn’t start (systemd failed)** | Run `sudo journalctl -u healer-bot -n 100`. If “Invalid environment variables”, fix `.env` (BOT_TOKEN required). If “Audio file not found”, run sync by hand and check `audio/manifest.json` and `audio/files/`. |
| **healthz not loading in browser** | Confirm port 3000 is open in Lightsail (instance → Networking). Use `http://` not `https://`. URL is `http://<static-ip>:3000/healthz`. |
| **Bot doesn’t reply in Telegram** | Check BOT_TOKEN in `.env` (no spaces, full token). Restart: `sudo systemctl restart healer-bot`. Check logs for “Telegram bot launched” and any errors. |
| **Webhook not received (GHL)** | Webhook URL must be reachable from the internet (use static IP, port 3000). If GHL requires HTTPS, complete Phase 9 first. Check server logs when you trigger a test event. |
