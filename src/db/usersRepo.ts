export type UserState = "NOT_SUBSCRIBED" | "ACTIVE_SUBSCRIBER" | "CANCEL_PENDING" | "CANCELLED";

export type UserRow = {
  telegram_user_id: number;
  state: UserState;
  ghl_contact_id: string | null;
  cancel_reason: string | null;
  last_event_at: number | null;
  last_resync_at: number | null;
  created_at: number;
  updated_at: number;
};

type DbLike = {
  prepare: (sql: string) => any;
  transaction: <T>(fn: () => T) => () => T;
};

export function upsertUserIfMissing(db: DbLike, telegramUserId: number): UserRow {
  const now = Date.now();

  const txn = db.transaction(() => {
    const existing = db
      .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .get(telegramUserId) as UserRow | undefined;
    if (existing) return existing;

    db.prepare(
      "INSERT INTO users (telegram_user_id, state, ghl_contact_id, cancel_reason, last_event_at, last_resync_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)"
    ).run(telegramUserId, "NOT_SUBSCRIBED", now, now);

    return db.prepare("SELECT * FROM users WHERE telegram_user_id = ?").get(telegramUserId) as UserRow;
  });

  return txn();
}

export function getUser(db: DbLike, telegramUserId: number): UserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE telegram_user_id = ?").get(telegramUserId) as UserRow | undefined;
  return row ?? null;
}

export function setCancelReason(db: DbLike, telegramUserId: number, reason: string) {
  const now = Date.now();
  db.prepare("UPDATE users SET cancel_reason = ?, updated_at = ? WHERE telegram_user_id = ?").run(reason, now, telegramUserId);
}

export function setLastResyncAt(db: DbLike, telegramUserId: number, lastResyncAt: number) {
  const now = Date.now();
  db.prepare("UPDATE users SET last_resync_at = ?, updated_at = ? WHERE telegram_user_id = ?").run(
    lastResyncAt,
    now,
    telegramUserId
  );
}

export function setGhlContactId(db: DbLike, telegramUserId: number, ghlContactId: string) {
  const now = Date.now();
  db.prepare("UPDATE users SET ghl_contact_id = ?, updated_at = ? WHERE telegram_user_id = ?").run(
    ghlContactId,
    now,
    telegramUserId
  );
}

/**
 * Updates state if the event is not older than last_event_at (out-of-order suppression).
 * Returns true if state was updated.
 */
export function applyStateTransition(params: {
  db: DbLike;
  telegramUserId: number;
  nextState: UserState;
  eventAt: number | null;
  ghlContactId?: string | null;
}): boolean {
  const { db, telegramUserId, nextState, eventAt, ghlContactId } = params;
  const now = Date.now();

  const txn = db.transaction(() => {
    const existing = upsertUserIfMissing(db, telegramUserId);
    if (eventAt !== null && existing.last_event_at !== null && eventAt < existing.last_event_at) {
      return false;
    }

    const newLastEventAt = eventAt ?? existing.last_event_at;
    db.prepare(
      "UPDATE users SET state = ?, ghl_contact_id = COALESCE(?, ghl_contact_id), last_event_at = ?, updated_at = ? WHERE telegram_user_id = ?"
    ).run(nextState, ghlContactId ?? null, newLastEventAt, now, telegramUserId);
    return true;
  });

  return txn();
}

