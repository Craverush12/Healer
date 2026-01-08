# GoHighLevel (GHL) Configuration

This MVP uses GHL as the subscription source of truth (Stripe is behind GHL).

## 1) Create the custom field

Create a **contact custom field**:
- **Key/Name**: `telegram_user_id`
- **Type**: text or number

This is how webhooks map billing events back to the Telegram user.

## 2) Checkout link prefill

Your backend generates the checkout link by substituting `{telegram_user_id}` into:

- `GHL_CHECKOUT_URL_TEMPLATE`

Example template:

`https://YOUR_GHL_CHECKOUT?...&telegram_user_id={telegram_user_id}`

In GHL, configure checkout / form mapping so that `telegram_user_id` ends up on the Contact custom field.

## 3) Webhooks

Configure GHL to send the following events to:
- `POST https://YOUR_HOST/webhooks/ghl`

Events:
- `subscription.created`
- `subscription.updated`
- `subscription.cancelled`
- `payment.failed`

### Workflow notes (important)

- Do NOT add a “Create Contact” action in Subscription workflows. The trigger already has a contact context, so GHL will skip it.
- In the webhook action custom data, the keys must be exact:
  - `event_type`
  - `telegram_user_id`
  - `contact_id`
  If the key is truncated (e.g., `telegram_user_`), the backend will not link the user.

### Webhook authentication

Preferred:
- Configure webhook signing and set `GHL_WEBHOOK_SECRET`
- Backend verifies `x-wh-signature` as `HMAC_SHA256(secret, raw_body)` and accepts **either** lowercase hex or base64 encoding. If your tenant sends `x-wh-timestamp`, the backend enforces a ±5 minute tolerance.

Fallback (if your tenant does not provide signature headers):
- Set `WEBHOOK_TOKEN`
- Configure webhook URL as: `https://YOUR_HOST/webhooks/ghl?token=WEBHOOK_TOKEN`

## 4) Customer portal / manage subscription link

Set:
- `MANAGE_SUBSCRIPTION_URL`

Bot uses this link for:
- Updating payment method
- Applying retention coupon code
- Cancelling at period end

## 5) Retention coupon

Create a coupon in Stripe (via GHL) that:
- Applies to the **next invoice** only
- Has **no proration** and **no refunds**

Put the coupon code in:
- `RETENTION_COUPON_CODE`

## 6) Optional contact lookup fallback

If your webhook payload does not include `telegram_user_id` but does include `contactId`, the backend can attempt a read-only contact fetch.

To enable:
- `GHL_API_KEY` (read-only is sufficient)
- `GHL_API_BASE_URL` (default is `https://services.leadconnectorhq.com`)
- `GHL_LOCATION_ID` (optional; if omitted, the service attempts to detect it at startup via the `me/locations` endpoint)

If not set, the backend will store the event as “unlinked” and will not grant/revoke access.

## 7) Resync on /start (ephemeral disk recovery)

Render and other hosts can reset SQLite on redeploy. To avoid paid users being blocked, the bot can resync on `/start` (and `/resync`):
- It searches for the contact by `telegram_user_id` custom field.
- If found, it checks subscription status and updates local state.

To enable resync:
- Create a GHL Private Integration API key with at least `contacts.readonly`.
- Set:
  - `GHL_API_KEY`
  - `GHL_API_BASE_URL` (default)
  - `GHL_LOCATION_ID` (optional; required in some tenants)
  - `RESYNC_COOLDOWN_MINUTES` (default 10)

If your tenant requires a locationId and it is missing, resync is disabled and the bot falls back to webhooks only.

Note: LeadConnector API calls include `Version: 2021-07-28`. Subscription APIs can vary by tenant; if the endpoint differs, update `src/ghl/ghlClient.ts` accordingly.

## Manual test checklist

1) Pay -> webhook sets ACTIVE
   - Complete checkout, confirm `subscription.created` webhook updates state.
2) Redeploy -> /start resync keeps access
   - Redeploy (simulate DB reset), run `/start`, confirm access is still ACTIVE.
3) Cancellation path
   - Send a `subscription.updated` cancel_at_period_end webhook and confirm CANCEL_PENDING.
   - Send `subscription.cancelled` and confirm CANCELLED.

