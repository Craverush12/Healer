# Telegram Subscription Bot (GHL + Stripe) — MVP

Single Node.js (TypeScript) process that:
- Runs a Telegram bot (Telegraf)
- Receives GoHighLevel webhooks (Express)
- Persists user access state in SQLite
- Delivers MP3 audio to subscribers only

## Quick start

### 1) Install

```bash
cd "C:\Users\Arjun\Desktop\telegram"
npm install
```

### 2) Configure

Copy `env.example` to `.env` and fill values:

```bash
copy env.example .env
```

Required keys:
- `BOT_TOKEN`
- `GHL_CHECKOUT_URL_TEMPLATE` (must include `{telegram_user_id}`)
- `MANAGE_SUBSCRIPTION_URL`
- `RETENTION_COUPON_CODE`
- Webhook auth: **either** `GHL_WEBHOOK_SECRET` **or** `WEBHOOK_TOKEN`

### 3) Add audio

- Put MP3s into `audio/files/`
- Update `audio/manifest.json` to reference each `filePath`

### 4) Run

```bash
npm run dev
```

Server:
- Health: `GET /healthz`
- Webhook: `POST /webhooks/ghl`

## Local end-to-end test (without GHL)

1) Start the bot (`npm run dev`)
2) Open Telegram and send `/start` to your bot
3) Simulate a subscription-created webhook (token mode)

Set `WEBHOOK_TOKEN=devtoken` in `.env`, then:

```bash
curl -X POST "http://localhost:3000/webhooks/ghl?token=devtoken" ^
  -H "Content-Type: application/json" ^
  -d "{\"webhookId\":\"evt_1\",\"type\":\"subscription.created\",\"timestamp\":1735511111000,\"telegram_user_id\":123456789,\"contactId\":\"contact_1\",\"status\":\"active\"}"
```

Replace `123456789` with your Telegram numeric user id.

## Audio in production (inline playback)

For production, prefer caching Telegram `file_id`s so audio plays inline without needing to stream from your server.

1) Add your Telegram numeric user id to `ADMIN_TELEGRAM_USER_IDS` in `.env` (comma-separated).
2) Start the bot and run:
   - `/admin_missing_file_ids` to see what needs ingesting
   - `/admin_ingest <itemId>` to upload one track and cache its `file_id`

The mapping is stored in SQLite (`telegram_audio_cache` table).

## Docs

- [docs/SETUP.md](docs/SETUP.md)
- [docs/GHL.md](docs/GHL.md)
- [docs/ADMIN.md](docs/ADMIN.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/HOSTING.md](docs/HOSTING.md)
- [docs/AWS_LIGHTSAIL_S3_DEPLOYMENT.md](docs/AWS_LIGHTSAIL_S3_DEPLOYMENT.md) — End-to-end plan for hosting on AWS Lightsail + S3

Archived/internal docs live in `docs/archive/`.

