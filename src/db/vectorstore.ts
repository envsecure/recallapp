/**
 * Concrete SQLite-backed VectorStore.
 *
 * The time range is applied inside the SQL WHERE clause, never after ranking
 * (IMPLEMENTATION.md Appendix A). Post-filtering would take the top N globally,
 * discard out-of-range hits, and lose in-range items that ranked below the cut.
 *
 * Vectors are brute-force scanned in JS. With normalised vectors that is a dot
 * product per row — memory-bandwidth bound, and fast enough at the target
 * scale. A native vector index becomes worthwhile in the 10^6+ chunk range;
 * see the note in `db/sqlite.ts`.
 */

import type {
  ChunkId,
  FileId,
  QueryOptions,
  TimeRange,
  UpsertEntry,
  VectorHit,
  VectorStore,
} from '@/interfaces/capabilities';
import { dot, fromBlob, toBlob } from '@/search/vector';
import type { SqliteDb } from '@/db/sqlite';

interface ScanRow {
  chunk_id: string;
  file_id: string;
  vec: Uint8Array;
  source: 'ocr' | 'vision';
}

export class SqliteVectorStore implements VectorStore {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async upsert(entries: readonly UpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT INTO vectors(chunk_id, dim, vec) VALUES(?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec',
    );
    for (const e of entries) {
      stmt.run(e.chunkId, e.vector.length, toBlob(e.vector));
    }
  }

  async query(vector: Float32Array, options: QueryOptions): Promise<VectorHit[]> {
    const { range, limit } = options;
    const weights = options.sourceWeights ?? {};

    // Range AND source live in the WHERE clause. This is the line the whole
    // temporal design turns on.
    const sql = `
      SELECT v.chunk_id AS chunk_id,
             c.file_id  AS file_id,
             v.vec      AS vec,
             c.source   AS source
      FROM vectors v
      JOIN chunks c ON c.id = v.chunk_id
      JOIN files  f ON f.id = c.file_id
      WHERE f.mtime_ms >= ? AND f.mtime_ms < ?
    `;

    const rows = this.db.prepare(sql).all(range.from.getTime(), range.to.getTime()) as unknown as ScanRow[];

    const scored: VectorHit[] = rows.map((r) => ({
      chunkId: r.chunk_id as ChunkId,
      fileId: r.file_id as FileId,
      score: dot(vector, fromBlob(r.vec)) * (weights[r.source] ?? 1),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async deleteByFile(fileId: FileId): Promise<void> {
    this.db.prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number };
    return row.n;
  }

  /**
   * Candidate rows scanned for a range. The benchmark reports this: it is the
   * real cost driver of a brute-force scan, and it shows the time filter
   * actually narrowing the candidate set.
   */
  scanCount(range: TimeRange): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM vectors v
         JOIN chunks c ON c.id = v.chunk_id
         JOIN files  f ON f.id = c.file_id
         WHERE f.mtime_ms >= ? AND f.mtime_ms < ?`,
      )
      .get(range.from.getTime(), range.to.getTime()) as { n: number };
    return row.n;
  }
}