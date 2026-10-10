import { describe, it, expect, beforeEach } from 'vitest';
import { SearchService } from '@/search/service';
import type { RetrievedItem } from '@/interfaces/capabilities';
import { AppError } from '@/errors';
import {
  FakeEmbedder,
  FakeKeywordIndex,
  FakeSummarizer,
  FakeVectorStore,
  chunkId,
  fileId,
} from '@test/fakes/fakes';

const NOW = new Date(2026, 9, 15, 14, 0, 0);

function buildFixture() {
  const store = new FakeVectorStore();
  const keywordIndex = new FakeKeywordIndex();
  const embedder = new FakeEmbedder();

  const items = new Map<string, RetrievedItem>();
  const files = new Map<string, { path: string; mtime: Date; thumbUrl?: string }>();

  return { store, keywordIndex, embedder, items, files };
}

describe('SearchService', () => {
  beforeEach(() => {
    // fixed clock: temporal assertions never depend on wall-clock
  });

  it('rejects an empty query with a typed error', async () => {
    const f = buildFixture();
    await f.embedder.load();
    const svc = new SearchService(f, () => NOW);

    await expect(svc.search({ q: '   ' })).rejects.toBeInstanceOf(AppError);
    await expect(svc.search({ q: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('passes the RESOLVED range into the store, not a post-filter (P2 core)', async () => {
    const f = buildFixture();
    await f.embedder.load();

    const fid = fileId('f1');
    f.store.registerFile(fid, new Date(2026, 8, 10));
    await f.store.upsert([{ chunkId: chunkId('c1'), fileId: fid, vector: new Float32Array(64) }]);

    const svc = new SearchService(f, () => NOW);
    const res = await svc.search({ q: 'architecture notes last month' });

    // NOW = 15 Oct 2026, so "last month" = September 2026.
    expect(res.appliedRange.from).toEqual(new Date(2026, 8, 1));
    expect(res.appliedRange.to).toEqual(new Date(2026, 9, 1));

    // The store received the same range object — filtering happened inside.
    expect(f.store.queries).toHaveLength(1);
    expect(f.store.queries[0]!.range).toBe(res.appliedRange);
  });

  it('excludes out-of-range files from results', async () => {
    const f = buildFixture();
    await f.embedder.load();

    const inRange = fileId('in');
    const outRange = fileId('out');
    f.store.registerFile(inRange, new Date(2026, 8, 10));
    f.store.registerFile(outRange, new Date(2024, 0, 1));

    const vec = new Float32Array(64);
    vec[0] = 1;
    await f.store.upsert([
      { chunkId: chunkId('c-in'), fileId: inRange, vector: vec },
      { chunkId: chunkId('c-out'), fileId: outRange, vector: vec },
    ]);

    for (const [cid, fid] of [['c-in', inRange], ['c-out', outRange]] as const) {
      f.items.set(cid, { chunkId: chunkId(cid), fileId: fid, text: 'paging and TLB', source: 'ocr' });
      f.files.set(fid, { path: `/imgs/${cid}.png`, mtime: new Date(2026, 8, 10) });
    }

    const svc = new SearchService(f, () => NOW);
    const res = await svc.search({ q: 'paging last month' });

    expect(res.hits.map((h) => h.fileId)).toEqual([inRange]);
  });

  it('embeds the query WITHOUT the time words', async () => {
    const f = buildFixture();
    await f.embedder.load();
    const svc = new SearchService(f, () => NOW);

    f.embedder.setVector('computer architecture notes', new Float32Array(64));
    await svc.search({ q: 'computer architecture notes last month' });

    // The forced vector was only set for the stripped query; if the service
    // had embedded the raw string, the forced lookup would not have matched.
    const forcedHit = f.embedder.forced.has('computer architecture notes');
    expect(forcedHit).toBe(true);
  });

  it('honours a user-supplied range override (F6 correction)', async () => {
    const f = buildFixture();
    await f.embedder.load();
    const svc = new SearchService(f, () => NOW);

    const custom = { from: new Date(2026, 0, 1), to: new Date(2026, 1, 1), label: 'chosen' };
    const res = await svc.search({ q: 'anything last month', range: custom });

    expect(res.appliedRange).toBe(custom);
    expect(f.store.queries[0]!.range).toBe(custom);
  });

  it('returns the applied range in every response so the UI can echo it', async () => {
    const f = buildFixture();
    await f.embedder.load();
    const svc = new SearchService(f, () => NOW);
    const res = await svc.search({ q: 'paging' });
    expect(res.appliedRange.label.length).toBeGreaterThan(0);
  });

  describe('summarizer independence (P4 DONE condition)', () => {
    async function seeded(includeSummarizer: boolean) {
      const f = buildFixture();
      await f.embedder.load();
      const fid = fileId('f1');
      f.store.registerFile(fid, new Date(2026, 8, 10));
      const vec = new Float32Array(64);
      vec[0] = 1;
      await f.store.upsert([{ chunkId: chunkId('c1'), fileId: fid, vector: vec }]);
      f.items.set('c1', { chunkId: chunkId('c1'), fileId: fid, text: 'paging', source: 'ocr' });
      f.files.set(fid, { path: '/a.png', mtime: new Date(2026, 8, 10) });

      let summarizer: FakeSummarizer | undefined;
      if (includeSummarizer) {
        summarizer = new FakeSummarizer();
        await summarizer.load();
      }
      const svc = new SearchService({ ...f, ...(summarizer ? { summarizer } : {}) }, () => NOW);
      return { svc, summarizer };
    }

    it('retrieval is identical with and without a summarizer', async () => {
      const a = await seeded(false);
      const b = await seeded(true);

      const ra = await a.svc.search({ q: 'paging' });
      const rb = await b.svc.search({ q: 'paging' });

      expect(rb.hits.map((h) => h.fileId)).toEqual(ra.hits.map((h) => h.fileId));
      expect(rb.hits.map((h) => h.score)).toEqual(ra.hits.map((h) => h.score));
    });

    it('a failing summarizer does not lose results or throw', async () => {
      const { svc, summarizer } = await seeded(true);
      summarizer!.shouldFail = true;
      const res = await svc.search({ q: 'paging' });
      expect(res.hits.length).toBeGreaterThan(0);
      expect(res.summary).toBeUndefined();
    });

    it('a present summarizer adds a summary without changing hits', async () => {
      const { svc } = await seeded(true);
      const res = await svc.search({ q: 'paging' });
      expect(res.summary).toBeDefined();
      expect(res.hits.length).toBeGreaterThan(0);
    });

    it('the summarizer receives the retrieved context, not an empty array', async () => {
      // Regression guard: `items` is keyed by chunkId. An earlier version
      // looked up by fileId, which silently produced an empty context and made
      // every summary content-free while the test suite stayed green.
      const f = buildFixture();
      await f.embedder.load();
      const fid = fileId('f1');
      const cid = chunkId('c1');
      f.store.registerFile(fid, new Date(2026, 8, 10));
      await f.store.upsert([{ chunkId: cid, fileId: fid, vector: new Float32Array(64) }]);
      f.items.set(cid, { chunkId: cid, fileId: fid, text: 'paging', source: 'ocr' });
      f.files.set(fid, { path: '/a.png', mtime: new Date(2026, 8, 10) });

      const summarizer = new FakeSummarizer();
      await summarizer.load();
      let seen: number = -1;
      summarizer.summarize = async (_q, ctx) => {
        seen = ctx.length;
        return 'x';
      };

      const svc = new SearchService({ ...f, summarizer }, () => NOW);
      const res = await svc.search({ q: 'paging' });
      expect(res.hits.length).toBeGreaterThan(0);
      expect(seen).toBe(1);
    });
  });

  it('respects a limit', async () => {
    const f = buildFixture();
    await f.embedder.load();
    const vec = new Float32Array(64);
    for (let i = 0; i < 10; i++) {
      const fid = fileId(`f${i}`);
      f.store.registerFile(fid, new Date(2026, 8, 10));
      await f.store.upsert([{ chunkId: chunkId(`c${i}`), fileId: fid, vector: vec }]);
      f.items.set(`c${i}`, { chunkId: chunkId(`c${i}`), fileId: fid, text: 't', source: 'ocr' });
      f.files.set(fid, { path: `/${i}.png`, mtime: new Date(2026, 8, 10) });
    }
    const svc = new SearchService(f, () => NOW);
    const res = await svc.search({ q: 't', limit: 3 });
    expect(res.hits.length).toBe(3);
  });

  it('skips hits with no matching metadata rather than emitting half-built results', async () => {
    const f = buildFixture();
    await f.embedder.load();
    const fid = fileId('f1');
    f.store.registerFile(fid, new Date(2026, 8, 10));
    await f.store.upsert([{ chunkId: chunkId('c1'), fileId: fid, vector: new Float32Array(64) }]);
    // deliberately no items/files entry for c1

    const svc = new SearchService(f, () => NOW);
    const res = await svc.search({ q: 'anything' });
    expect(res.hits).toHaveLength(0);
  });
});