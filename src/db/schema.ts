// Keep this in TS so production builds don't depend on copying .sql files into dist/.
// The equivalent SQL is also present in src/db/schema.sql for human readability.
export const SCHEMA_SQL = `
-- Users table tracks Telegram users and their subscription-derived access state.
CREATE TABLE IF NOT EXISTS users (
  telegram_user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  ghl_contact_id TEXT,
  cancel_reason TEXT,
  last_event_at INTEGER,
  last_resync_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Webhook events table provides idempotency + audit trail.
CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_type TEXT,
  received_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  telegram_user_id INTEGER,
  PRIMARY KEY (provider, idempotency_key)
);

-- Cache Telegram file_ids for audio items so we can send audio inline without hosting/streaming.
CREATE TABLE IF NOT EXISTS telegram_audio_cache (
  item_id TEXT PRIMARY KEY,
  telegram_file_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-time checkout tokens to map GHL webhooks back to Telegram users without exposing their id in URLs.
CREATE TABLE IF NOT EXISTS checkout_tokens (
  token TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT fk_checkout_tokens_user FOREIGN KEY (telegram_user_id) REFERENCES users (telegram_user_id) ON DELETE CASCADE
);
`;
