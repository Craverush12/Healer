# Setup Guide

## 1) Create the Telegram bot

1. In Telegram, open `@BotFather`
2. Create a bot via `/newbot`
3. Copy the bot token into `.env` as `BOT_TOKEN`

## 2) Configure the backend

1. Copy `env.example` → `.env`
2. Set:
   - `BOT_TOKEN`
   - `PORT` (default `3000`)
   - `DB_PATH` (default `./data/bot.sqlite`)
   - `GHL_CHECKOUT_URL_TEMPLATE` (must include `{telegram_user_id}`)
   - `MANAGE_SUBSCRIPTION_URL`
   - `RETENTION_COUPON_CODE`
3. Webhook auth:
   - Preferred: set `GHL_WEBHOOK_SECRET` and use signature verification
   - Fallback: set `WEBHOOK_TOKEN` and configure your webhook URL to include `?token=...`

Run:

```bash
npm run dev
```

## 3) Expose a public webhook URL

GHL must call your backend over HTTPS. For local testing you can use a tunnel (e.g. ngrok).

Your webhook URL will be:
- `POST https://YOUR_HOST/webhooks/ghl`

If you are using token mode:
- `POST https://YOUR_HOST/webhooks/ghl?token=YOUR_TOKEN`

