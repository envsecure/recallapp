/**
 * Integration tests — real SQLite stores, fake models.
 *
 * Complements indexer.test.ts (which uses the in-memory fake stores). These
 * exercise the actual SQL: the FTS5 table, the vector BLOB round-trip, the
 * WHERE-clause time filter, and resumability against a real database rather
 * than a fake one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer } from '@/index/indexer';
import { openDb, migrate, type SqliteDb } from '@/db/sqlite';
import { SqliteVectorStore } from '@/db/vectorstore';
import { SqliteKeywordIndex } from '@/db/keyword';
import { NoiseFilter } from '@/index/filter';
import { scanFolder } from '@/index/scan';
import { decideVision } from '@/index/route';
import { clusterFrames } from '@/index/cluster';
import { sanitize } from '@/db/keyword';
import { FakeEmbedder, FakeTextExtractor } from '@test/fakes/fakes';

/** Mirrors MIN_BYTES in src/index/filter.ts — below this, the filter rejects. */
const MIN_FIXTURE_BYTES = 2048;

let dir: string;
let db: SqliteDb;
const NOW = new Date(2026, 8, 15, 10, 0, 0);

/**
 * Varied bytes: above the 2 KB noise floor, not solid-colour.
 *
 * Deliberately NOT Buffer.alloc(n, k) — that fills with a single constant byte,
 * which the solid-colour filter correctly rejects. Every non-noise fixture here
 * must contain real byte variation.
 */
function writeFixture(name: string, seed = 0): string {
  const path = join(dir, name);
  const buf = Buffer.alloc(6000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + seed * 17) % 251;
  writeFileSync(path, buf);
  utimesSync(path, NOW, NOW);
  return path;
}

/**
 * Byte-varied buffer of a given length.
 *
 * The first argument is the LENGTH. Passing a seed as the first argument
 * silently produced a 1-byte file, which the noise filter then correctly
 * rejected — a confusing failure that cost real debugging time.
 */
function varied(bytes: number, seed = 1): Buffer {
  if (bytes < MIN_FIXTURE_BYTES) {
    throw new RangeError(`varied(): need >= ${MIN_FIXTURE_BYTES} bytes, got ${bytes}`);
  }
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 37 + seed * 23) % 251;
  return buf;
}

/**
 * Model lifecycle belongs to the caller, not the Indexer (AGENT.md: no
 * module-level singletons, explicit load/unload). Every fake must be loaded
 * before use — the assertion inside the fake is what proves that contract.
 */
async function buildIndexer(): Promise<Indexer> {
  const embedder = new FakeEmbedder();
  const extractor = new FakeTextExtractor();
  await embedder.load();
  await extractor.load();
  return new Indexer({
    db,
    extractor,
    embedder,
    store: new SqliteVectorStore(db),
    keywordIndex: new SqliteKeywordIndex(db),
    filter: new NoiseFilter(),
    now: () => NOW,
  });
}

function n(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recall-int-'));
  db = openDb(':memory:');
  migrate(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

describe('indexer against real SQLite', () => {
  it('writes one chunk and one vector per file', async () => {
    writeFixture('a.png', 1);
    writeFixture('b.png', 2);
    const res = await (await buildIndexer()).indexFolder(dir);
    expect(res.errors.map((e) => e.error)).toEqual([]);
    expect(res.processed).toBe(2);

    expect(n('SELECT COUNT(*) AS n FROM files')).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM chunks')).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM vectors')).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM fts')).toBe(2);
  });

  it('is resumable across separate runs on one database', async () => {
    writeFixture('a.png', 1);
    writeFixture('b.png', 2);

    const first = await (await buildIndexer()).indexFolder(dir);
    expect(first.processed).toBe(2);

    const second = await (await buildIndexer()).indexFolder(dir);
    expect(second.processed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM files')).toBe(2);
  });

  it('replaces chunks instead of duplicating on re-index', async () => {
    const path = writeFixture('a.png');
    await (await buildIndexer()).indexFolder(dir);
    writeFileSync(path, varied(6000, 9));
    await (await buildIndexer()).indexFolder(dir);

    expect(n('SELECT COUNT(*) AS n FROM chunks')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM vectors')).toBe(1);
  });

  it('stores embeddings L2-normalised in the blob', async () => {
    writeFixture('a.png');
    await (await buildIndexer()).indexFolder(dir);

    const row = db.prepare('SELECT vec FROM vectors LIMIT 1').get() as { vec: Uint8Array };
    const bytes = row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength) as ArrayBuffer;
    const v = new Float32Array(bytes);
    let sum = 0;
    for (const x of v) sum += x * x;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 4);
  });

  it('a per-file failure does not abort the run', async () => {
    writeFixture('good1.png', 1);
    const bad = writeFixture('bad.png', 2);
    writeFixture('good2.png', 3);

    const extractor = new FakeTextExtractor();
    await extractor.load();
    const embedder = new FakeEmbedder();
    await embedder.load();

    const orig = extractor.extract.bind(extractor);
    extractor.extract = async (p: string) => {
      if (p === bad) throw new Error('synthetic');
      return orig(p);
    };

    const indexer = new Indexer({
      db,
      extractor,
      embedder,
      store: new SqliteVectorStore(db),
      keywordIndex: new SqliteKeywordIndex(db),
      filter: new NoiseFilter(),
      now: () => NOW,
    });

    const res = await indexer.indexFolder(dir);
    expect(res.failed).toBe(1);
    expect(res.processed).toBe(2);
    // The failed file keeps a row marked 'failed' so the next run retries it;
    // the two good ones are 'done'.
    expect(n("SELECT COUNT(*) AS n FROM files WHERE status='done'")).toBe(2);
    expect(n("SELECT COUNT(*) AS n FROM files WHERE status='failed'")).toBe(1);
  });

  it('handles an empty directory', async () => {
    const res = await (await buildIndexer()).indexFolder(dir);
    expect(res.scanned).toBe(0);
    expect(res.failed).toBe(0);
  });

  it('reports a missing folder as an error rather than throwing', async () => {
    const res = await (await buildIndexer()).indexFolder(join(dir, 'nope'));
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('reports progress for every file', async () => {
    for (let i = 0; i < 3; i++) writeFixture(`p${i}.png`, i + 1);
    const counts: number[] = [];
    await (await buildIndexer()).indexFolder(dir, (p) => counts.push(p.processed + p.skipped));
    expect(counts).toHaveLength(3);
    expect(counts[counts.length - 1]).toBe(3);
  });
});

describe('the time filter lives in the SQL (P2 core condition)', () => {
  it('range filtering happens in the store, not after ranking', async () => {
    writeFixture('a.png');
    await (await buildIndexer()).indexFolder(dir);

    const store = new SqliteVectorStore(db);
    const embedder = new FakeEmbedder();
    await embedder.load();
    const vec = await embedder.embed('Lecture slide a');

    const inRange = await store.query(vec, {
      range: { from: new Date(2026, 7, 1), to: new Date(2026, 9, 1), label: 'aug-sep' },
      limit: 10,
    });
    expect(inRange.length).toBe(1);

    const outRange = await store.query(vec, {
      range: { from: new Date(2020, 0, 1), to: new Date(2020, 1, 1), label: '2020' },
      limit: 10,
    });
    expect(outRange.length).toBe(0);
  });

  it('scanCount reports the narrowed candidate set', async () => {
    writeFixture('a.png');
    await (await buildIndexer()).indexFolder(dir);

    const store = new SqliteVectorStore(db);
    expect(store.scanCount({ from: new Date(0), to: new Date(2100, 0, 1), label: 'all' })).toBe(1);
    expect(store.scanCount({ from: new Date(2020, 0, 1), to: new Date(2020, 1, 1), label: '2020' })).toBe(0);
  });

  it('deleting a file removes its vectors', async () => {
    writeFixture('a.png');
    await (await buildIndexer()).indexFolder(dir);

    const row = db.prepare('SELECT id FROM files LIMIT 1').get() as { id: string };
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id); // cascades to chunks+vectors
    expect(n('SELECT COUNT(*) AS n FROM vectors')).toBe(0);
  });
});

describe('FTS5 keyword index', () => {
  it('finds indexed text', async () => {
    writeFixture('paging.png');
    await (await buildIndexer()).indexFolder(dir);

    const kw = new SqliteKeywordIndex(db);
    const hits = await kw.search('slide', 10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not throw on punctuation a user might type', async () => {
    const kw = new SqliteKeywordIndex(db);
    for (const q of ['cache-miss!', '"unterminated', 'a AND b', 'x OR (y)', '*.png', '']) {
      await expect(kw.search(q, 10)).resolves.toBeDefined();
    }
  });

  it('sanitize quotes terms and strips FTS syntax', () => {
    expect(sanitize('cache-miss')).toBe('"cache" "miss"');
    expect(sanitize('foo OR bar')).toBe('"foo" "OR" "bar"');
    expect(sanitize('!!!')).toBe('');
  });

  it('returns no keyword hits for a punctuation-only query', async () => {
    const kw = new SqliteKeywordIndex(db);
    expect(await kw.search('!!!', 10)).toEqual([]);
  });
});

describe('scanFolder', () => {
  it('skips dotfiles and node_modules', () => {
    writeFixture('keep.png');
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, '.hidden', 'secret.png'), varied(6000, 1));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.png'), varied(6000, 2));

    expect(scanFolder(dir).files.map((f) => f.path.split('/').pop())).toEqual(['keep.png']);
  });

  it('recurses into subdirectories', () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.png'), varied(6000, 3));
    expect(scanFolder(dir).files.length).toBe(1);
  });

  it('drops files below the size floor', () => {
    writeFileSync(join(dir, 'tiny.png'), Buffer.alloc(10));
    expect(scanFolder(dir).files.length).toBe(0);
  });

  it('drops a solid-colour image that is above the size floor', () => {
    // 6 KB of one repeated byte: passes the size gate, fails the solid gate.
    // Two separate defects, two separate fixtures.
    writeFileSync(join(dir, 'blank.png'), Buffer.alloc(6000, 42));
    expect(scanFolder(dir).files.length).toBe(0);
  });

  it('drops an exact duplicate within one pass', () => {
    const a = writeFixture('a.png');
    writeFileSync(join(dir, 'copy.png'), readFileSync(a));
    expect(scanFolder(dir).files.length).toBe(1);
  });

  it('is deterministic across runs', () => {
    writeFixture('a.png', 1);
    writeFixture('b.png', 2);
    writeFixture('c.png', 3);
    const first = scanFolder(dir).files.map((f) => f.path);
    const second = scanFolder(dir).files.map((f) => f.path);
    expect(first).toEqual(second);
  });
});

describe('vision routing (C6)', () => {
  const dense = { text: 'x'.repeat(400), words: [], confidence: 0.92, imageSize: { width: 10, height: 10 } };

  it('does not route dense confident OCR to vision', () => {
    expect(decideVision(dense)).toBe(false);
  });

  it('routes an empty extraction to vision', () => {
    expect(decideVision({ text: '', words: [], confidence: 0, imageSize: { width: 1, height: 1 } })).toBe(true);
  });

  it('routes low-confidence extraction to vision', () => {
    expect(decideVision({ ...dense, confidence: 0.2 })).toBe(true);
  });

  it('routes short text to vision even when confident', () => {
    expect(decideVision({ ...dense, text: 'hi', confidence: 0.99 })).toBe(true);
  });
});

describe('slide clustering', () => {
  const PHASH_A = '0000000000000000';
  const PHASH_B = '0000000000000003'; // 2 bits from A

  it('clusters identical frames inside the time gap', () => {
    const res = clusterFrames([
      { path: 'a.png', mtimeMs: 1000, phash: PHASH_A },
      { path: 'b.png', mtimeMs: 2000, phash: PHASH_A },
    ]);
    expect(res.count).toBe(1);
    expect(res.clusters[0]?.frames.length).toBe(2);
  });

  it('does not cluster across a time gap', () => {
    const res = clusterFrames([
      { path: 'a.png', mtimeMs: 0, phash: PHASH_A },
      { path: 'b.png', mtimeMs: 200_000, phash: PHASH_A },
    ]);
    expect(res.count).toBe(2);
  });

  it('does not cluster visually different frames close in time', () => {
    const res = clusterFrames([
      { path: 'a.png', mtimeMs: 1000, phash: PHASH_A },
      { path: 'b.png', mtimeMs: 2000, phash: 'ffffffffffffffff' },
    ]);
    expect(res.count).toBe(2);
  });

  it('returns one cluster for a single frame', () => {
    expect(clusterFrames([{ path: 'a.png', mtimeMs: 0, phash: PHASH_A }]).count).toBe(1);
  });

  it('returns zero clusters for empty input', () => {
    expect(clusterFrames([]).count).toBe(0);
  });

  it('is order-independent: input order does not change the result', () => {
    const frames = [
      { path: 'b.png', mtimeMs: 2000, phash: PHASH_A },
      { path: 'a.png', mtimeMs: 1000, phash: PHASH_B },
    ];
    expect(clusterFrames(frames).count).toBe(clusterFrames([...frames].reverse()).count);
  });

  it('does not mutate its input', () => {
    const frames = [
      { path: 'b.png', mtimeMs: 2000, phash: PHASH_A },
      { path: 'a.png', mtimeMs: 1000, phash: PHASH_B },
    ];
    const before = [...frames];
    clusterFrames(frames);
    expect(frames).toEqual(before);
  });

  it('clusters near-identical phashes within the distance threshold', () => {
    expect(clusterFrames([
      { path: 'a.png', mtimeMs: 0, phash: PHASH_A },
      { path: 'b.png', mtimeMs: 1000, phash: PHASH_B },
    ]).count).toBe(1);
  });
});