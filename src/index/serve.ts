#!/usr/bin/env node
/**
 * Production serve entry point — wires the real SQLite stores to the
 * SearchService and listens on loopback (GOAL.md C1).
 *
 * The query embedder is selected the same way as indexing
 * (`selectCapabilities`): real weights when they are on disk, deterministic
 * fakes otherwise, reported on every run. The query MUST be embedded with
 * the same model family as the index — a fake 64d query vector scored
 * against real 384d index vectors is meaningless, which is exactly what an
 * earlier dev-only entrypoint did.
 */

import { openDb, migrate } from '@/db/sqlite';
import { SqliteVectorStore } from '@/db/vectorstore';
import { SqliteKeywordIndex } from '@/db/keyword';
import { makeConfig } from '@/config';
import { startServer } from '@/index/server';
import { SearchService } from '@/search/service';
import type { RetrievedItem } from '@/interfaces/capabilities';
import { selectCapabilities } from '@/index/capabilities';

async function main(): Promise<void> {
  const config = makeConfig();
  const db = openDb(config.paths.dbFile);
  migrate(db);

  // Use the real embedder when its weights are on disk, fakes otherwise.
  // The query MUST be embedded with the same model family as the index:
  // dev.ts used to hardcode FakeEmbedder (64d hash) while the index held
  // real bge vectors (384d), which made every score meaningless.
  const caps = await selectCapabilities({ modelDir: config.paths.modelDir });
  console.log(`search embedder: ${caps.describe}`);
  const embedder = caps.embedder;

  const keywordIndex = new SqliteKeywordIndex(db);

  // Load chunk text from the DB so results carry real snippets.
  const rows = db
    .prepare('SELECT c.id AS id, c.file_id AS file_id, c.text AS text, c.source AS source, f.path AS path, f.mtime_ms AS mtime_ms FROM chunks c JOIN files f ON f.id = c.file_id')
    .all() as { id: string; file_id: string; text: string; source: 'ocr' | 'vision'; path: string; mtime_ms: number }[];

  const items = new Map<string, RetrievedItem>();
  const files = new Map<string, { path: string; mtime: Date; thumbUrl?: string }>();
  for (const r of rows) {
    items.set(r.id, { chunkId: r.id as RetrievedItem['chunkId'], fileId: r.file_id as RetrievedItem['fileId'], text: r.text, source: r.source });
    files.set(r.file_id, { path: r.path, mtime: new Date(r.mtime_ms), thumbUrl: `/thumb/${encodeURIComponent(r.path.split('/').pop() ?? '')}` });
  }

  const search = new SearchService(
    {
      store: new SqliteVectorStore(db),
      keywordIndex,
      embedder,
      items,
      files,
    },
    () => new Date(),
  );

  const server = startServer({ search, config });

  console.log(`indexed chunks: ${items.size}`);
  console.log(`db: ${config.paths.dbFile}`);
  void server;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});