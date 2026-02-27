type DbLike = {
  prepare: (sql: string) => any;
};

export function tryInsertWebhookEvent(params: {
  db: DbLike;
  provider: string;
  idempotencyKey: string;
  eventType: string | null;
  receivedAt: number;
  payloadHash: string;
  telegramUserId: number | null;
}): { inserted: boolean } {
  const { db, provider, idempotencyKey, eventType, receivedAt, payloadHash, telegramUserId } = params;

  try {
    db.prepare(
      "INSERT INTO webhook_events (provider, idempotency_key, event_type, received_at, payload_hash, telegram_user_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(provider, idempotencyKey, eventType, receivedAt, payloadHash, telegramUserId);
    return { inserted: true };
  } catch (err: any) {
    // Unique constraint hit -> duplicate delivery.
    if (typeof err?.message === "string" && err.message.includes("UNIQUE")) {
      return { inserted: false };
    }
    throw err;
  }
}

export function deleteWebhookEventsOlderThan(db: DbLike, cutoffMs: number): number {
  const result = db.prepare("DELETE FROM webhook_events WHERE received_at < ?").run(cutoffMs) as { changes?: number };
  return Number(result?.changes ?? 0);
}

export function countWebhookEventsOlderThan(db: DbLike, cutoffMs: number): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM webhook_events WHERE received_at < ?").get(cutoffMs) as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

