#!/usr/bin/env node
/**
 * Dev entry point — wires the real SQLite stores to the SearchService.
 *
 * Runs with fakes, because no model can be loaded on this box (GOAL.md C2).
 * The wiring is real: the same SearchService, SqliteVectorStore and
 * SqliteKeywordIndex the production path uses. Only the two model capabilities
 * (extractor, embedder) are fakes.
 */

import { openDb, migrate } from '@/db/sqlite';
import { SqliteVectorStore } from '@/db/vectorstore';
import { SqliteKeywordIndex } from '@/db/keyword';
import { makeConfig } from '@/config';
import { startServer } from '@/index/server';
import { SearchService } from '@/search/service';
import type { RetrievedItem } from '@/interfaces/capabilities';
import { FakeEmbedder } from '@test/fakes/fakes';

async function main(): Promise<void> {
  const config = makeConfig();
  const db = openDb(config.paths.dbFile);
  migrate(db);

  const embedder = new FakeEmbedder();
  await embedder.load();

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