import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { applyDbMigrations } from "./migrations";
import { logger } from "../logger";

export type SqliteDb = Database.Database;

export function openSqlite(dbPath: string): SqliteDb {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function applySchema(db: SqliteDb, schemaSql: string) {
  db.exec(schemaSql);

  try {
    const result = applyDbMigrations(db);
    if (result.applied.length > 0) {
      logger.info({ appliedMigrations: result.applied }, "Applied DB migrations");
    }
    logger.info({ totalMigrations: result.total, appliedCount: result.applied.length }, "DB migration check complete");
  } catch (err) {
    logger.error({ err }, "Failed to apply schema migrations");
    throw err;
  }
}

