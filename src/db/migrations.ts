import type { SqliteDb } from "./db";

type Migration = {
  id: string;
  run: (db: SqliteDb) => void;
};

type MigrationRow = { id: string };

function ensureMigrationsTable(db: SqliteDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return cols.some((col) => col.name === columnName);
}

const MIGRATIONS: Migration[] = [
  {
    id: "20260225_001_users_last_resync_at",
    run: (db) => {
      if (!hasColumn(db, "users", "last_resync_at")) {
        db.prepare("ALTER TABLE users ADD COLUMN last_resync_at INTEGER").run();
      }
    }
  },
  {
    id: "20260225_002_indexes",
    run: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_events_telegram_user_received_at
          ON webhook_events (telegram_user_id, received_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type_received_at
          ON webhook_events (event_type, received_at);
        CREATE INDEX IF NOT EXISTS idx_checkout_tokens_expires_at ON checkout_tokens (expires_at);
        CREATE INDEX IF NOT EXISTS idx_users_ghl_contact_id ON users (ghl_contact_id);
        CREATE INDEX IF NOT EXISTS idx_users_state ON users (state);
        CREATE INDEX IF NOT EXISTS idx_telegram_audio_cache_updated_at ON telegram_audio_cache (updated_at);
      `);
    }
  }
];

function assertUniqueMigrationIds(migrations: Migration[]) {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate migration id: ${migration.id}`);
    }
    seen.add(migration.id);
  }
}

export function applyDbMigrations(db: SqliteDb): { applied: string[]; total: number } {
  assertUniqueMigrationIds(MIGRATIONS);
  ensureMigrationsTable(db);

  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as MigrationRow[];
  const appliedIds = new Set(appliedRows.map((row) => row.id));
  const insertApplied = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");

  const newlyApplied: string[] = [];
  const txn = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (appliedIds.has(migration.id)) continue;
      migration.run(db);
      insertApplied.run(migration.id, Date.now());
      newlyApplied.push(migration.id);
      appliedIds.add(migration.id);
    }
  });

  txn();
  return { applied: newlyApplied, total: MIGRATIONS.length };
}

