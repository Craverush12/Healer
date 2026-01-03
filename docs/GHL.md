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

### Webhook authentication

Preferred:
- Configure webhook signing and set `GHL_WEBHOOK_SECRET`
- Backend verifies `x-wh-signature` as `HMAC_SHA256(secret, raw_body)` hex

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

If not set, the backend will store the event as “unlinked” and will not grant/revoke access.

