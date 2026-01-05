import crypto from "node:crypto";

type DbLike = {
  prepare: (sql: string) => any;
};

export type CheckoutTokenRecord = {
  token: string;
  telegram_user_id: number;
  expires_at: number;
  created_at: number;
};

function generateToken(): string {
  // Short, URL-safe token
  return crypto.randomBytes(16).toString("hex");
}

export function createCheckoutToken(db: DbLike, telegramUserId: number, ttlMs = 1000 * 60 * 60 * 48): string {
  const now = Date.now();
  const token = generateToken();
  const expiresAt = now + ttlMs;
  db.prepare(
    [
      "INSERT INTO checkout_tokens (token, telegram_user_id, expires_at, created_at)",
      "VALUES (?, ?, ?, ?)"
    ].join(" ")
  ).run(token, telegramUserId, expiresAt, now);
  return token;
}

export function consumeCheckoutToken(db: DbLike, token: string): number | null {
  const row = db
    .prepare("SELECT token, telegram_user_id, expires_at FROM checkout_tokens WHERE token = ?")
    .get(token) as CheckoutTokenRecord | undefined;
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at < now) {
    db.prepare("DELETE FROM checkout_tokens WHERE token = ?").run(token);
    return null;
  }

  // Single use: delete and return
  db.prepare("DELETE FROM checkout_tokens WHERE token = ?").run(token);
  return row.telegram_user_id;
}

export function deleteCheckoutTokensForUser(db: DbLike, telegramUserId: number) {
  db.prepare("DELETE FROM checkout_tokens WHERE telegram_user_id = ?").run(telegramUserId);
}

