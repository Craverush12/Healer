# dYs? Quick Start Guide

## Implementation Status: ƒo. READY FOR TESTING

Your Telegram bot is **fully implemented** and ready to test! All core features are working:
- ƒo. Bot commands and interactions
- ƒo. Audio library browsing
- ƒo. User management and state tracking
- ƒo. Payment system (behind feature flag)
- ƒo. Webhook handling

---

## ƒs­ 5-Minute Setup

### 1. Get Bot Token
- Open Telegram ƒ+' Search `@BotFather`
- Send `/newbot` ƒ+' Follow prompts
- **Copy the token** (looks like: `123456789:ABC...`)

### 2. Configure Environment
```bash
copy env.example .env
```

Edit `.env`:
```env
BOT_TOKEN=YOUR_TOKEN_HERE
ENABLE_PAYMENTS=false
WEBHOOK_TOKEN=test-token-123
```

### 3. Install & Build
```bash
npm install
npm run build
```

### 4. Run Bot
```bash
npm start
```

### 5. Test in Telegram
- Find your bot in Telegram
- Send `/start`
- Click "dY'3 Subscribe" ƒ+' Access granted immediately!
- Click "dYZ Browse Audio Library"

---

## dY"- Full Guide

See **[docs/HOSTING.md](docs/HOSTING.md)** for:
- Detailed step-by-step instructions
- How to expose bot to internet (ngrok/cloudflared)
- Testing without payments
- Enabling payments later
- Troubleshooting

---

## dYZ_ Key Features

### Testing Mode (Payments Disabled)
- `ENABLE_PAYMENTS=false` ƒ+' Subscribe button grants access immediately
- No payment URLs needed
- Perfect for testing all bot features

### Production Mode (Payments Enabled)
- `ENABLE_PAYMENTS=true` ƒ+' Full payment integration
- Requires GHL/Stripe configuration
- Webhook authentication required

---

## dY" Common Commands

```bash
npm run dev    # Development mode (auto-reload)
npm run build  # Compile TypeScript
npm start      # Run production build
```

---

## dY"? Next Steps

1. ƒo. Test locally (you're here!)
2. dY"­ Expose to internet (see HOSTING.md - Step 7)
3. dYZæ Add audio files to `audio/files/`
4. dY'3 Enable payments when ready

---

**Questions?** Check `docs/HOSTING.md` for detailed guidance!

