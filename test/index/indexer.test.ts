/**
 * Indexer tests — fake-backed only (AGENT.md, GOAL.md C2).
 *
 * Every capability here is a deterministic fake from `@test/fakes/fakes`;
 * nothing touches a real model. Image fixtures are generated text files sized
 * to survive the NoiseFilter (>2KB, byte-varied so looksSolid is false).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '@/db/sqlite';
import { NoiseFilter, contentHash } from '@/index/filter';
import { Indexer } from '@/index/indexer';
import { AppError } from '@/errors';
import {
  FakeEmbedder,
  FakeKeywordIndex,
  FakeTextExtractor,
  FakeVectorStore,
} from '@test/fakes/fakes';

const NOW = new Date(2026, 8, 15, 10, 0, 0);

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'recall-index-'));
}

/** Varied, >2KB content so the NoiseFilter keeps it (not too_small, not solid). */
function variedContent(seed: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push(
      `Slide ${seed} line ${i}: paging TLB virtual memory diagram ${i * 7} abcdef ${seed} XYZ-${i} qwerty`,
    );
  }
  return lines.join('\n');
}

function writeFixture(dir: string, name: string, seed: string): string {
  const full = join(dir, name);
  writeFileSync(full, variedContent(seed), 'utf8');
  return full;
}

function countFiles(db: ReturnType<typeof openDb>, status?: string): number {
  const row =
    status === undefined
      ? (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number })
      : (db.prepare('SELECT COUNT(*) AS n FROM files WHERE status = ?').get(status) as {
          n: number;
        });
  return row.n;
}

describe('Indexer', () => {
  it('indexing N fixture files yields N files rows', async () => {
    const dir = makeTempDir();
    try {
      const db = openDb(':memory:');
      try {
        migrate(db);
        const extractor = new FakeTextExtractor();
        const embedder = new FakeEmbedder();
        await extractor.load();
        await embedder.load();
        const store = new FakeVectorStore();
        const keywordIndex = new FakeKeywordIndex();
        const indexer = new Indexer({
          db,
          extractor,
          embedder,
          store,
          keywordIndex,
          filter: new NoiseFilter(),
          now: () => NOW,
        });

        writeFixture(dir, 'a-paging.png', 'paging-alpha');
        writeFixture(dir, 'b-tlb.png', 'tlb-beta');
        writeFixture(dir, 'c-cache.png', 'cache-gamma');

        const seen: number[] = [];
        const result = await indexer.indexFolder(dir, () => {
          seen.push(1);
        });

        expect(result.failed).toBe(0);
        expect(result.processed).toBe(3);
        expect(countFiles(db, 'done')).toBe(3);
        expect(await store.count()).toBeGreaterThan(0);
        expect(seen.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-running is a no-op (0 re-processed)', async () => {
    const dir = makeTempDir();
    try {
      const db = openDb(':memory:');
      try {
        migrate(db);
        const extractor = new FakeTextExtractor();
        const embedder = new FakeEmbedder();
        await extractor.load();
        await embedder.load();
        const store = new FakeVectorStore();
        const keywordIndex = new FakeKeywordIndex();
        const indexer = new Indexer({
          db,
          extractor,
          embedder,
          store,
          keywordIndex,
          filter: new NoiseFilter(),
          now: () => NOW,
        });

        writeFixture(dir, 'a-paging.png', 'paging-alpha');
        writeFixture(dir, 'b-tlb.png', 'tlb-beta');

        const first = await indexer.indexFolder(dir);
        expect(first.processed).toBe(2);
        const callsAfterFirst = extractor.extractCalls;

        const second = await indexer.indexFolder(dir);
        expect(second.processed).toBe(0);
        expect(second.failed).toBe(0);
        expect(second.skipped).toBe(2);
        expect(extractor.extractCalls).toBe(callsAfterFirst);
        expect(countFiles(db, 'done')).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file whose hash is already done is skipped', async () => {
    const dir = makeTempDir();
    try {
      const db = openDb(':memory:');
      try {
        migrate(db);
        const extractor = new FakeTextExtractor();
        const embedder = new FakeEmbedder();
        await extractor.load();
        await embedder.load();
        const store = new FakeVectorStore();
        const keywordIndex = new FakeKeywordIndex();
        const indexer = new Indexer({
          db,
          extractor,
          embedder,
          store,
          keywordIndex,
          filter: new NoiseFilter(),
          now: () => NOW,
        });

        const pathA = writeFixture(dir, 'a-paging.png', 'paging-alpha');
        writeFixture(dir, 'b-tlb.png', 'tlb-beta');

        const hashA = contentHash(pathA);
        const st = statSync(pathA);
        db.prepare(
          `INSERT INTO files(id,path,mtime_ms,bytes,content_hash,status,indexed_at)
           VALUES(?,?,?,?,?,'done',?)`,
        ).run(hashA, pathA, Math.floor(st.mtimeMs), st.size, hashA, NOW.getTime());

        const callsBefore = extractor.extractCalls;
        const result = await indexer.indexFolder(dir);

        expect(result.skipped).toBe(1);
        expect(result.processed).toBe(1);
        expect(result.failed).toBe(0);
        // Only the non-skipped file was extracted.
        expect(extractor.extractCalls - callsBefore).toBe(1);
        expect(countFiles(db, 'done')).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('per-file failure does not abort the run', async () => {
    const dir = makeTempDir();
    try {
      const db = openDb(':memory:');
      try {
        migrate(db);
        const extractor = new FakeTextExtractor();
        const embedder = new FakeEmbedder();
        await extractor.load();
        await embedder.load();
        const store = new FakeVectorStore();
        const keywordIndex = new FakeKeywordIndex();
        const indexer = new Indexer({
          db,
          extractor,
          embedder,
          store,
          keywordIndex,
          filter: new NoiseFilter(),
          now: () => NOW,
        });

        writeFixture(dir, 'a-good.png', 'good-alpha');
        const badPath = writeFixture(dir, 'b-bad.png', 'bad-beta');
        writeFixture(dir, 'c-good.png', 'good-gamma');

        const origExtract = extractor.extract.bind(extractor);
        extractor.extract = async (imagePath: string) => {
          if (imagePath === badPath) {
            throw new AppError('upstream_failure', 'forced failure for one file');
          }
          return origExtract(imagePath);
        };

        const result = await indexer.indexFolder(dir);

        expect(result.processed).toBe(2);
        expect(result.failed).toBe(1);
        expect(countFiles(db, 'done')).toBe(2);
        // Good files still produced vectors despite the sibling failure.
        expect(await store.count()).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('needs_vision is set for low-confidence paths', async () => {
    const dir = makeTempDir();
    try {
      const db = openDb(':memory:');
      try {
        migrate(db);
        const extractor = new FakeTextExtractor();
        const embedder = new FakeEmbedder();
        await extractor.load();
        await embedder.load();
        const store = new FakeVectorStore();
        const keywordIndex = new FakeKeywordIndex();
        const indexer = new Indexer({
          db,
          extractor,
          embedder,
          store,
          keywordIndex,
          filter: new NoiseFilter(),
          now: () => NOW,
        });

        const goodPath = writeFixture(dir, 'good.png', 'good-alpha');
        const lowPath = writeFixture(dir, 'low.png', 'low-beta');
        extractor.lowConfidencePaths.add(lowPath);

        const result = await indexer.indexFolder(dir);
        expect(result.failed).toBe(0);
        expect(result.processed).toBe(2);

        const lowRow = db.prepare('SELECT needs_vision FROM files WHERE path = ?').get(lowPath) as
          | { needs_vision: number }
          | undefined;
        const goodRow = db
          .prepare('SELECT needs_vision FROM files WHERE path = ?')
          .get(goodPath) as { needs_vision: number } | undefined;

        expect(lowRow?.needs_vision).toBe(1);
        expect(goodRow?.needs_vision).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
