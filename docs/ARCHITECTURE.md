# Architecture Overview

## Services (single process)

One Node.js process runs:
- Telegraf Telegram bot
- Express HTTP server (health + webhooks)
- SQLite persistence

> Scaling note: This design assumes a single instance. If you need horizontal scale, move SQLite to a shared DB, swap the in-memory rate limiter for a shared store (e.g., Redis), and coordinate bot/webhook processing so idempotency and ordering guarantees hold across nodes.

## Source of truth

- **GoHighLevel (GHL)** is the billing source of truth.
- The bot uses **local DB state only** at runtime to decide access.
- DB state is updated only by authenticated webhooks.
- To recover after ephemeral disk resets (e.g., Render redeploy), the bot can resync from GHL on `/start` using the GHL API key.

## Persistence notes (Render)

- Render free tiers often provide ephemeral disks. If you want durable state, attach a persistent disk for SQLite or move to Postgres.
- Resync is a safety net, not a replacement for durable storage.

## State machine

States:
- `NOT_SUBSCRIBED`
- `ACTIVE_SUBSCRIBER`
- `CANCEL_PENDING`
- `CANCELLED`

Access:
- Allowed: `ACTIVE_SUBSCRIBER`, `CANCEL_PENDING`
- Blocked: `NOT_SUBSCRIBED`, `CANCELLED`

Transitions:

| Incoming webhook event | Condition | Next state | Notes |
|---|---|---|---|
| `subscription.created` | active | `ACTIVE_SUBSCRIBER` | grant |
| `subscription.updated` | cancelAtPeriodEnd=true | `CANCEL_PENDING` | retain |
| `subscription.updated` | active and cancelAtPeriodEnd=false | `ACTIVE_SUBSCRIBER` | uncancel/reactivate |
| `subscription.cancelled` (or ended) | ended=true | `CANCELLED` | revoke |
| `payment.failed` | n/a | no change | notify only |

## Webhook robustness rules

- Auth:
  - Preferred: HMAC signature header (`x-wh-signature`) over raw body
  - Fallback: `?token=...`
- Idempotency:
  - Primary: `webhookId`
  - Fallback: `sha256(raw_body)`
- Mapping:
  - Prefer `telegram_user_id` in webhook payload
  - Fallback: fetch contact by `contactId` (requires `GHL_API_KEY`)
  - If still missing: store as unlinked; **do not** grant/revoke access
- Ordering:
  - `last_event_at` suppresses out-of-order deliveries

## Sample webhook payloads (copy/paste)

Use these for local testing (token mode). Replace `telegram_user_id` with your real Telegram numeric user id.

### ACTIVE_SUBSCRIBER

```json
{
  "webhookId": "evt_1",
  "type": "subscription.created",
  "timestamp": 1735511111000,
  "telegram_user_id": 123456789,
  "contactId": "contact_1",
  "status": "active"
}
```

### CANCEL_PENDING

```json
{
  "webhookId": "evt_2",
  "type": "subscription.updated",
  "timestamp": 1735512222000,
  "telegram_user_id": 123456789,
  "cancelAtPeriodEnd": true,
  "status": "active"
}
```

### CANCELLED

```json
{
  "webhookId": "evt_3",
  "type": "subscription.cancelled",
  "timestamp": 1735513333000,
  "telegram_user_id": 123456789,
  "ended": true,
  "status": "canceled"
}
```

### PAYMENT_FAILED (no state change)

```json
{
  "webhookId": "evt_4",
  "type": "payment.failed",
  "timestamp": 1735514444000,
  "telegram_user_id": 123456789
}
```

