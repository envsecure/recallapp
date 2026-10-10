/**
 * FTS5 keyword index.
 *
 * Not the primary search path — keyword-only search is exactly what fails when
 * the user remembers "the slide about memory management" but the slide says
 * "paging and TLB". This exists to re-rank semantic hits, and to make exact
 * matches (a filename, an acronym) beat merely-fuzzy ones.
 */

import type { ChunkId, FileId, KeywordHit, KeywordIndex } from '@/interfaces/capabilities';
import type { SqliteDb } from '@/db/sqlite';

export class SqliteKeywordIndex implements KeywordIndex {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async upsert(id: ChunkId, text: string): Promise<void> {
    this.db.prepare("DELETE FROM fts WHERE chunk_id = ?").run(id);
    this.db
      .prepare('INSERT INTO fts(text, chunk_id, file_id) VALUES(?,?,?)')
      .run(text, id, '');
  }

  /**
   * `file_id` is denormalised into the FTS row for deletes; set it at upsert
   * time via `register` when the caller knows the owner.
   */
  register(id: ChunkId, fileId: FileId): void {
    this.db.prepare('UPDATE fts SET file_id = ? WHERE chunk_id = ?').run(fileId, id);
  }

  async search(query: string, limit: number): Promise<KeywordHit[]> {
    const cleaned = sanitize(query);
    if (!cleaned) return [];

    // bm25 is negative (lower is better); negate so bigger is better, which is
    // what fuseRank expects.
    const rows = this.db
      .prepare(
        `SELECT chunk_id, bm25(fts) AS score
         FROM fts WHERE fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(cleaned, limit) as unknown as { chunk_id: string; score: number }[];

    return rows.map((r) => ({ chunkId: r.chunk_id as ChunkId, score: -r.score }));
  }

  async deleteByFile(fileId: FileId): Promise<void> {
    this.db.prepare('DELETE FROM fts WHERE file_id = ?').run(fileId);
  }
}

/**
 * Strip anything FTS5 would read as query syntax.
 *
 * A user typing `cache-miss` or `"unterminated quote` would otherwise get an
 * FTS5 syntax error, which is a 500 for something the user did innocently.
 * Quoting each term also makes the match AND-ed by default, which is what
 * people expect from a search box.
 */
export function sanitize(query: string): string {
  const terms = query
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/[\s_-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}