/**
 * SQLite access. One file, no server, no daemon (GOAL.md C5).
 *
 * Uses node:sqlite (built in since Node 22.5). This was chosen over
 * better-sqlite3 specifically because it has no native build step — the dev
 * box has no toolchain guarantee and 3.3 GB of free disk, and a native module
 * that fails to compile would take the whole project with it.
 *
 * The trade-off: no sqlite-vec extension, so vector search is a brute-force
 * scan in JS. At the target scale (thousands of chunks) that is well under a
 * millisecond and needs no native dependency. If Recall ever needs 10^6+
 * chunks, this is the module to change.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '@/errors';

export type SqliteDb = DatabaseSync;

export function openDb(path: string): SqliteDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL keeps readers from blocking the writer; foreign keys are off by
  // default in SQLite and must be enabled per connection.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Schema.
 *
 * Migrations are additive and idempotent — `CREATE TABLE IF NOT EXISTS` rather
 * than a versioned migration table, because there is exactly one schema author
 * and a version table would only add a way for the two to disagree.
 */
export function migrate(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      path        TEXT NOT NULL UNIQUE,
      mtime_ms    INTEGER NOT NULL,
      bytes       INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      phash       TEXT,
      kind        TEXT NOT NULL DEFAULT 'image',
      thumb_path  TEXT,
      ocr_confidence REAL,
      ocr_chars    INTEGER,
      needs_vision INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',
      indexed_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime_ms);
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT PRIMARY KEY,
      file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source     TEXT NOT NULL,
      text       TEXT NOT NULL,
      tokens     INTEGER NOT NULL DEFAULT 0,
      ord        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

    -- Vectors stored as raw float32 BLOBs, L2-normalised on write, so ranking
    -- is a plain dot product with no per-query normalisation pass.
    CREATE TABLE IF NOT EXISTS vectors (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      dim      INTEGER NOT NULL,
      vec      BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text,
      chunk_id UNINDEXED,
      file_id  UNINDEXED,
      tokenize = 'porter unicode61'
    );

    -- Resumability (IMPLEMENTATION.md P1): a file is only marked done once all
    -- its rows are committed, so a crash mid-file re-does that file and nothing
    -- else.
    CREATE TABLE IF NOT EXISTS index_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getState(db: SqliteDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM index_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(db: SqliteDb, key: string, value: string): void {
  db.prepare('INSERT INTO index_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    value,
  );
}

/** Wrap a statement so a constraint violation becomes a typed AppError. */
export function runSafe(db: SqliteDb, sql: string, ...params: unknown[]): void {
  try {
    db.prepare(sql).run(...(params as never[]));
  } catch (e) {
    throw new AppError('upstream_failure', `db: ${e instanceof Error ? e.message : String(e)}`, e);
  }
}