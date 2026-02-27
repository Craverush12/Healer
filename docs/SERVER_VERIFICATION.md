# How to Check If the Healer Bot Is Working on the Server

## Prerequisites (do this first)

1. **Set your real Telegram bot token on the server**
   ```bash
   ssh healer
   sudo nano /etc/healer-bot.env
   ```
   Replace `REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN` with your actual token from [@BotFather](https://t.me/BotFather). Save and exit (Ctrl+O, Enter, Ctrl+X).

2. **Start the bot**
   ```bash
   sudo systemctl start healer-bot
   ```

---

## 1. Check the service is running

**On the server (or via SSH):**
```bash
ssh healer "sudo systemctl status healer-bot"
```

**What to look for:** `Active: active (running)` in green.  
If you see `inactive (dead)` or `failed`, the service isn’t running — see [Troubleshooting](#troubleshooting) below.

---

## 2. Check the health endpoint

The bot exposes an HTTP health check. If the service is running:

**From your Windows machine (replace `<SERVER_IP>` with your server’s public IP):**
```powershell
curl http://<SERVER_IP>:3000/healthz
```

**From the server itself:**
```bash
ssh healer "curl -s http://localhost:3000/healthz"
```

**Expected response:** `{"ok":true}`  
If you get “connection refused” or no response, the app isn’t listening — check [Troubleshooting](#troubleshooting).

---

## 3. Check that port 3000 is open (from outside)

**From your Windows machine:**
```powershell
curl http://<SERVER_IP>:3000/healthz
```

If this fails but step 2 works from the server, **port 3000 is not open** in your cloud firewall (AWS Security Group). Add an inbound rule: **TCP port 3000**, source `0.0.0.0/0` (or your IP) so Telegram and webhooks can reach the bot.

---

## 4. Test in Telegram

1. Open Telegram and find your bot (by the username you created with BotFather).
2. Send: `/start`
3. You should get the welcome message and menu (Subscribe, Browse, Help).

If the bot doesn’t reply:
- Confirm `BOT_TOKEN` in `/etc/healer-bot.env` is correct (no spaces, full token).
- Check logs: `ssh healer "sudo journalctl -u healer-bot -n 50 --no-pager"`.

---

## Quick verification checklist

| Check | Command | Expected |
|-------|---------|----------|
| Service running | `ssh healer "sudo systemctl status healer-bot"` | `Active: active (running)` |
| Health (on server) | `ssh healer "curl -s http://localhost:3000/healthz"` | `{"ok":true}` |
| Health (from internet) | `curl http://<SERVER_IP>:3000/healthz` | `{"ok":true}` |
| Telegram | Send `/start` to your bot | Welcome message + menu |

---

## Useful commands

```bash
# Follow logs in real time
ssh healer "sudo journalctl -u healer-bot -f"

# Last 50 log lines
ssh healer "sudo journalctl -u healer-bot -n 50 --no-pager"

# Restart after changing .env
ssh healer "sudo systemctl restart healer-bot"

# Stop the bot
ssh healer "sudo systemctl stop healer-bot"
```

---

## Troubleshooting

| Problem | What to do |
|--------|------------|
| **Service won’t start / keeps restarting** | Check logs: `sudo journalctl -u healer-bot -n 50`. If you see “404 Not Found” or “Invalid BOT_TOKEN”, fix the token in `/etc/healer-bot.env` and run `sudo systemctl restart healer-bot`. |
| **Health works on server but not from browser/curl from your PC** | Open TCP port 3000 in the instance’s **Security Group** (inbound rule). |
| **Bot doesn’t reply in Telegram** | Verify `BOT_TOKEN` in `/etc/healer-bot.env`, restart with `sudo systemctl restart healer-bot`, and check logs for Telegram errors. |
| **“Permission denied” loading env** | Env is read from `/etc/healer-bot.env`; ensure it exists and is root-owned: `sudo chown root:root /etc/healer-bot.env && sudo chmod 600 /etc/healer-bot.env`. |
