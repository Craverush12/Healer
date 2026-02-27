# Server Setup Commands Reference

All commands run during the initial Healer bot deployment on the server (AlmaLinux 9 / EC2, user `ec2-user`). Run from your **local machine** in the project directory (`C:\Arjun\Healer`) unless noted.

---

## 1. Inspect server (before making changes)

| Command | Why |
|---------|-----|
| `ssh healer "cat /etc/os-release 2>/dev/null \|\| cat /etc/redhat-release 2>/dev/null; echo '---'; whoami; echo '---'; node -v 2>/dev/null \|\| echo 'Node not installed'; echo '---'; aws --version 2>/dev/null \|\| echo 'AWS CLI not installed'; echo '---'; ls -la /home/ec2-user/healer 2>/dev/null \|\| echo 'healer dir not found'"` | See OS, user, whether Node/AWS CLI/healer dir exist. |

---

## 2. Install Node.js 20 and AWS CLI

| Command | Why |
|---------|-----|
| `ssh healer "sudo dnf module enable nodejs:20 -y && sudo dnf install nodejs -y"` | Enable Node 20 module and install Node/npm so the bot can run and build. |
| `ssh healer "sudo dnf install awscli -y"` | Install AWS CLI so the S3 sync script can pull manifest and audio from S3. |

---

## 3. Create app directories

| Command | Why |
|---------|-----|
| `ssh healer "mkdir -p /home/ec2-user/healer/data /home/ec2-user/healer/audio/files && node -v && aws --version"` | Create `healer`, `data` (for SQLite), and `audio/files`; confirm Node and AWS CLI. |

---

## 4. Upload project to server

| Command | Why |
|---------|-----|
| `scp package.json package-lock.json tsconfig.json env.example healer:healer/` | Copy root config and example env to server (no secrets). |
| `scp -r src scripts healer:healer/` | Copy source and scripts (including sync script). |
| `scp -r audio healer:healer/` | Copy local `audio/` (manifest + files) so bot has content before S3. |

---

## 5. Verify upload and build

| Command | Why |
|---------|-----|
| `ssh healer "ls -la healer/ && ls healer/src/ \| head -5 && ls healer/scripts/"` | Confirm uploaded files and dirs. |
| `ssh healer "cd healer && npm ci && npm run build"` | Install deps and compile TypeScript so `dist/index.js` exists. |

---

## 6. Prepare runtime and sync script

| Command | Why |
|---------|-----|
| `ssh healer "cd healer && ls dist/ && chmod +x scripts/sync-audio-from-s3.sh && ls -la scripts/sync-audio-from-s3.sh"` | Confirm `dist/` and make S3 sync script executable. |
| `ssh healer "cat > healer/.env << 'ENVEOF'\nBOT_TOKEN=REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN\nPORT=3000\nDB_PATH=/home/ec2-user/healer/data/bot.sqlite\nENABLE_PAYMENTS=false\nENABLE_STARTUP_AUDIO_RECOVERY=false\nWEBHOOK_RAW_BODY_LIMIT_BYTES=262144\nRESYNC_COOLDOWN_MINUTES=10\nENVEOF\nchmod 600 healer/.env"` | Create server `.env` with placeholder token and lock permissions. |

---

## 7. Systemd service (main unit)

| Command | Why |
|---------|-----|
| `ssh healer "sudo tee /etc/systemd/system/healer-bot.service << 'SVCEOF'\n[Unit]\nDescription=Healer Telegram Bot\nAfter=network.target\n[Service]\nType=simple\nUser=ec2-user\nWorkingDirectory=/home/ec2-user/healer\nExecStartPre=/home/ec2-user/healer/scripts/sync-audio-from-s3.sh\nEnvironment=S3_AUDIO_BUCKET=healer-bot-audio-prod\nExecStart=/usr/bin/node dist/index.js\nRestart=always\nRestartSec=10\nEnvironment=NODE_ENV=production\nEnvironmentFile=/home/ec2-user/healer/.env\n[Install]\nWantedBy=multi-user.target\nSVCEOF"` | Create `healer-bot.service`: S3 sync before start, then `node dist/index.js`, use env file, restart on failure. |

---

## 8. Fix env so systemd can read it

| Command | Why |
|---------|-----|
| `ssh healer "cat healer/.env \| sudo tee /etc/healer-bot.env > /dev/null && sudo chmod 600 /etc/healer-bot.env && sudo chown root:root /etc/healer-bot.env"` | Copy `.env` to `/etc/healer-bot.env` so systemd (root) can read it. |
| `ssh healer "sudo sed -i 's|EnvironmentFile=/home/ec2-user/healer/.env|EnvironmentFile=/etc/healer-bot.env|' /etc/systemd/system/healer-bot.service"` | Point service at `/etc/healer-bot.env`. |

---

## 9. Fix ExecStartPre (S3 sync) and allow start without S3

| Command | Why |
|---------|-----|
| `ssh healer "sudo sed -i 's|ExecStartPre=/home/ec2-user/healer/scripts/sync-audio-from-s3.sh|ExecStartPre=/bin/bash /home/ec2-user/healer/scripts/sync-audio-from-s3.sh|' /etc/systemd/system/healer-bot.service"` | Run sync script via `/bin/bash` so SELinux allows it. |
| `ssh healer "sudo mkdir -p /etc/systemd/system/healer-bot.service.d && echo '[Service]\n# Skip S3 sync until AWS credentials and bucket are configured\nExecStartPre=\n' \| sudo tee /etc/systemd/system/healer-bot.service.d/no-s3.conf"` | Drop-in to skip S3 sync until AWS credentials exist so bot can start with local audio. |

---

## 10. Enable and start (then stop until real token is set)

| Command | Why |
|---------|-----|
| `ssh healer "sudo systemctl daemon-reload && sudo systemctl enable healer-bot"` | Load unit and enable on boot. |
| `ssh healer "sudo systemctl start healer-bot"` | Start the bot (will fail/restart until real BOT_TOKEN is in `/etc/healer-bot.env`). |
| `ssh healer "sudo systemctl stop healer-bot"` | Stop so it doesn’t restart loop with placeholder token. |

---

## One-place copy-paste (minimal setup)

Run from project root. After running, set real `BOT_TOKEN` in `/etc/healer-bot.env` on the server and start the service.

```bash
# Inspect
ssh healer "cat /etc/os-release; whoami; node -v; aws --version; ls /home/ec2-user/healer"

# Install Node 20 + AWS CLI (AlmaLinux 9)
ssh healer "sudo dnf module enable nodejs:20 -y && sudo dnf install nodejs -y"
ssh healer "sudo dnf install awscli -y"

# Create dirs
ssh healer "mkdir -p /home/ec2-user/healer/data /home/ec2-user/healer/audio/files"

# Upload app
scp package.json package-lock.json tsconfig.json env.example healer:healer/
scp -r src scripts healer:healer/
scp -r audio healer:healer/

# Build on server
ssh healer "cd healer && npm ci && npm run build"
ssh healer "chmod +x healer/scripts/sync-audio-from-s3.sh"

# Create .env on server (then copy to /etc for systemd)
ssh healer "cat > healer/.env << 'ENVEOF'
BOT_TOKEN=REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN
PORT=3000
DB_PATH=/home/ec2-user/healer/data/bot.sqlite
ENABLE_PAYMENTS=false
ENVEOF
chmod 600 healer/.env"
ssh healer "cat healer/.env | sudo tee /etc/healer-bot.env && sudo chmod 600 /etc/healer-bot.env && sudo chown root:root /etc/healer-bot.env"

# Install systemd unit (with bash for ExecStartPre and /etc env file)
ssh healer "sudo tee /etc/systemd/system/healer-bot.service << 'SVCEOF'
[Unit]
Description=Healer Telegram Bot
After=network.target
[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/healer
ExecStartPre=/bin/bash /home/ec2-user/healer/scripts/sync-audio-from-s3.sh
Environment=S3_AUDIO_BUCKET=healer-bot-audio-prod
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/etc/healer-bot.env
[Install]
WantedBy=multi-user.target
SVCEOF"

# Skip S3 until credentials exist
ssh healer "sudo mkdir -p /etc/systemd/system/healer-bot.service.d && echo '[Service]
ExecStartPre=
' | sudo tee /etc/systemd/system/healer-bot.service.d/no-s3.conf"

# Enable (start after setting real BOT_TOKEN in /etc/healer-bot.env)
ssh healer "sudo systemctl daemon-reload && sudo systemctl enable healer-bot"
```

---

## Re-enable S3 sync later

When you have AWS credentials and an S3 bucket:

1. On server: create `~/.aws/credentials` and `~/.aws/config` for `ec2-user` (see `docs/AWS_LIGHTSAIL_S3_DEPLOYMENT.md`).
2. Remove the drop-in and restart:
   ```bash
   ssh healer "sudo rm /etc/systemd/system/healer-bot.service.d/no-s3.conf && sudo systemctl daemon-reload && sudo systemctl restart healer-bot"
   ```

---

See also: `docs/SERVER_VERIFICATION.md` (how to check the bot is working), `docs/AWS_LIGHTSAIL_S3_DEPLOYMENT.md` (full deployment guide).
