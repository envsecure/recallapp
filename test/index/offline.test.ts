import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * C1: nothing leaves the machine.
 *
 * GOAL.md Definition of Done item 1 asks for an automated assertion that a full
 * index + search cycle makes zero outbound network calls. This is that
 * assertion.
 *
 * Approach: `vi.mock` replaces the network modules with stubs that record every
 * attempt and throw. Module-level `vi.mock` is hoisted, so the stubs are in
 * place before the modules under test are imported — patching ESM namespace
 * objects does not work, they are frozen.
 *
 * If any code path under test reaches for the network, the test fails with
 * C1 VIOLATION rather than quietly phoning home.
 */

const attempts: string[] = [];

function boom(label: string): never {
  attempts.push(label);
  throw new Error(`C1 VIOLATION: outbound ${label} attempted`);
}

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    default: actual,
    request: (...a: unknown[]) => boom('http.request'),
    get: (...a: unknown[]) => boom('http.get'),
  };
});

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return {
    ...actual,
    default: actual,
    request: (...a: unknown[]) => boom('https.request'),
    get: (...a: unknown[]) => boom('https.get'),
  };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    default: actual,
    connect: (...a: unknown[]) => boom('net.connect'),
    createConnection: (...a: unknown[]) => boom('net.createConnection'),
  };
});

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>();
  return { ...actual, default: actual, connect: (...a: unknown[]) => boom('tls.connect') };
});

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const sync: never = (() => boom('dns.*')) as never;
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises },
    lookup: sync,
    resolve: sync,
    resolve4: sync,
    resolve6: sync,
  };
});

// Imported after the mocks so they bind to the stubbed modules.
const { openDb, migrate } = await import('@/db/sqlite');
const { Indexer } = await import('@/index/indexer');
const { NoiseFilter } = await import('@/index/filter');
const { SqliteVectorStore } = await import('@/db/vectorstore');
const { SqliteKeywordIndex } = await import('@/db/keyword');
const { SearchService } = await import('@/search/service');
import type { ChunkId, FileId } from '@/interfaces/capabilities';
const { FakeEmbedder, FakeTextExtractor } = await import('@test/fakes/fakes');

describe('C1 — no outbound network during index + search', () => {
  beforeEach(() => {
    attempts.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the network stubs are actually installed (so the assertion below means something)', async () => {
    const net = await import('node:net');
    const http = await import('node:http');
    expect(() => net.connect(80, 'example.com')).toThrow(/C1 VIOLATION/);
    expect(() => http.request('http://example.com')).toThrow(/C1 VIOLATION/);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    attempts.length = 0;
  });

  it('a full index + search cycle makes no outbound calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-c1-'));
    try {
      const buf = Buffer.alloc(6000);
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) % 251;
      writeFileSync(join(dir, 'slide.png'), buf);
      utimesSync(join(dir, 'slide.png'), new Date(2026, 8, 15), new Date(2026, 8, 15));

      const NOW = new Date(2026, 8, 15, 10, 0, 0);
      const db = openDb(':memory:');
      migrate(db);

      const extractor = new FakeTextExtractor();
      const embedder = new FakeEmbedder();
      await extractor.load();
      await embedder.load();

      const store = new SqliteVectorStore(db);
      const keywordIndex = new SqliteKeywordIndex(db);

      const indexer = new Indexer({
        db, extractor, embedder, store, keywordIndex,
        filter: new NoiseFilter(), now: () => NOW,
      });
      const res = await indexer.indexFolder(dir);
      expect(res.processed).toBe(1);

      const rows = db
        .prepare(
          `SELECT c.id AS id, c.file_id AS file_id, c.text AS text, c.source AS source,
                  f.path AS path, f.mtime_ms AS mtime_ms
           FROM chunks c JOIN files f ON f.id = c.file_id`,
        )
        .all() as { id: string; file_id: string; text: string; source: 'ocr' | 'vision'; path: string; mtime_ms: number }[];

      const items = new Map(rows.map((r) => [
        r.id,
        {
          chunkId: r.id as ChunkId,
          fileId: r.file_id as FileId,
          text: r.text,
          source: r.source,
        },
      ]));
      const files = new Map(rows.map((r) => [r.file_id, { path: r.path, mtime: new Date(r.mtime_ms) }]));

      const search = new SearchService({ store, keywordIndex, embedder, items, files }, () => NOW);
      const out = await search.search({ q: 'paging' });
      expect(out.appliedRange.label.length).toBeGreaterThan(0);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(attempts).toEqual([]);
  });
});