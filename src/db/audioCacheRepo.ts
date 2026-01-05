type DbLike = {
  prepare: (sql: string) => any;
};

export function getTelegramAudioFileId(db: DbLike, itemId: string): string | null {
  const row = db
    .prepare("SELECT telegram_file_id FROM telegram_audio_cache WHERE item_id = ?")
    .get(itemId) as { telegram_file_id: string } | undefined;
  return row?.telegram_file_id ?? null;
}

export function upsertTelegramAudioFileId(db: DbLike, itemId: string, telegramFileId: string) {
  const now = Date.now();
  db.prepare(
    [
      "INSERT INTO telegram_audio_cache (item_id, telegram_file_id, updated_at)",
      "VALUES (?, ?, ?)",
      "ON CONFLICT(item_id) DO UPDATE SET telegram_file_id = excluded.telegram_file_id, updated_at = excluded.updated_at"
    ].join(" ")
  ).run(itemId, telegramFileId, now);
}

export function deleteTelegramAudioFileId(db: DbLike, itemId: string) {
  db.prepare("DELETE FROM telegram_audio_cache WHERE item_id = ?").run(itemId);
}

export function clearTelegramAudioFileIds(db: DbLike) {
  db.prepare("DELETE FROM telegram_audio_cache").run();
}
