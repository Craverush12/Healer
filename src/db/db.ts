import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SqliteDb = Database.Database;

export function openSqlite(dbPath: string): SqliteDb {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function applySchema(db: SqliteDb, schemaSql: string) {
  db.exec(schemaSql);
}

