import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeEmbedder,
  FakeKeywordIndex,
  FakeSummarizer,
  FakeTextExtractor,
  FakeThumbnailer,
  FakeVectorStore,
  FakeVisionDescriber,
  chunkId,
  fileId,
  FIXED_EPOCH,
  orthogonalVectors,
} from '@test/fakes/fakes';
import type { RetrievedItem } from '@/interfaces/capabilities';
import { AppError } from '@/errors';

const NOW = new Date(2026, 9, 15, 14, 0, 0);
const DAY = 86_400_000;

describe('fake lifecycle guarantees', () => {
  it('unload() before load() does not throw (C4 idempotence)', async () => {
    const f = new FakeTextExtractor();
    await expect(f.unload()).resolves.toBeUndefined();
    expect(f.isLoaded).toBe(false);
  });

  it('unload() twice is safe', async () => {
    const f = new FakeTextExtractor();
    await f.load();
    await f.unload();
    await expect(f.unload()).resolves.toBeUndefined();
    expect(f.isLoaded).toBe(false);
  });

  it('calling the operation before load() throws a typed error', async () => {
    const f = new FakeTextExtractor();
    await expect(f.extract('/x.png')).rejects.toBeInstanceOf(AppError);
  });

  it('can fail load() on purpose', async () => {
    const f = new FakeTextExtractor();
    f.shouldFailLoad = true;
    await expect(f.load()).rejects.toBeInstanceOf(AppError);
    expect(f.isLoaded).toBe(false);
  });
});

describe('FakeEmbedder', () => {
  let e: FakeEmbedder;
  beforeEach(async () => {
    e = new FakeEmbedder();
    await e.load();
  });

  it('returns a normalised vector', async () => {
    const v = await e.embed('paging and TLB');
    let sum = 0;
    for (const x of v) sum += x * x;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 5);
  });

  it('has length 64', async () => {
    expect((await e.embed('anything')).length).toBe(64);
  });

  it('is deterministic: same text, same vector', async () => {
    const a = await e.embed('cache miss');
    const b = await e.embed('cache miss');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('differs for different text', async () => {
    const a = await e.embed('cache miss');
    const b = await e.embed('branch prediction');
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same += 1;
    expect(same).toBeLessThan(a.length);
  });

  it('honours a forced vector', async () => {
    const [u, v] = orthogonalVectors(64);
    e.setVector('exact', u);
    expect(Array.from(await e.embed('exact'))).toEqual(Array.from(u));
    expect(Array.from(v).length).toBe(64);
  });

  it('embedBatch preserves per-item semantics', async () => {
    const batch = await e.embedBatch(['a', 'b']);
    expect(batch.length).toBe(2);
    expect(Array.from(batch[0]!)).toEqual(Array.from(await e.embed('a')));
  });
});

describe('FakeVectorStore — the time filter (P0/P2 core condition)', () => {
  let store: FakeVectorStore;
  let embedder: FakeEmbedder;

  beforeEach(async () => {
    store = new FakeVectorStore();
    embedder = new FakeEmbedder();
    await embedder.load();
  });

  /** Seed: one file inside the range, one far outside, both perfectly relevant. */
  async function seedInAndOut() {
    const [u, v] = orthogonalVectors(64);
    const inRange = fileId('in-range');
    const outOfRange = fileId('out-of-range');

    store.registerFile(inRange, new Date(2026, 8, 20), 'ocr'); // Sep 2026: in
    store.registerFile(outOfRange, new Date(2020, 0, 5), 'ocr'); // ancient: out

    await store.upsert([
      { chunkId: chunkId('c-in'), fileId: inRange, vector: u },
      { chunkId: chunkId('c-out'), fileId: outOfRange, vector: u }, // identical score
    ]);

    return { inRange, outOfRange, u, v };
  }

  it('excludes out-of-range entries from results', async () => {
    const { inRange } = await seedInAndOut();
    const hits = await store.query(new Float32Array(64).fill(0.01).map((_, i) => (i === 0 ? 1 : 0)), {
      range: { from: new Date(2026, 8, 1), to: new Date(2026, 9, 1), label: 'sep' },
      limit: 10,
    });
    expect(hits.map((h) => h.fileId)).toEqual([inRange]);
  });

  it('filters BEFORE limiting, so in-range items are not crowded out', async () => {
    // 5 out-of-range entries that all score higher than the 1 in-range entry.
    // A post-filter implementation would take the top 10, discard 5, and miss
    // the in-range item entirely if the limit had been smaller.
    const inRange = fileId('in-range');
    store.registerFile(inRange, new Date(2026, 8, 20));
    await store.upsert([{ chunkId: chunkId('c-in'), fileId: inRange, vector: new Float32Array(64).fill(-1) }]);

    for (let i = 0; i < 5; i++) {
      const f = fileId(`out-${i}`);
      store.registerFile(f, new Date(2019, 0, 1));
      await store.upsert([{ chunkId: chunkId(`c-out-${i}`), fileId: f, vector: new Float32Array(64).fill(1) }]);
    }

    const hits = await store.query(new Float32Array(64).fill(1), {
      range: { from: new Date(2026, 8, 1), to: new Date(2026, 9, 1), label: 'sep' },
      limit: 1, // deliberately smaller than the out-of-range set
    });

    expect(hits.length).toBe(1);
    expect(hits[0]!.fileId).toBe(inRange);
  });

  it('records the range it was given, so tests can assert what was applied', async () => {
    await seedInAndOut();
    const range = { from: new Date(2026, 8, 1), to: new Date(2026, 9, 1), label: 'sep' };
    await store.query(new Float32Array(64), { range, limit: 5 });
    expect(store.queries).toHaveLength(1);
    expect(store.queries[0]!.range).toBe(range);
  });

  it('applies source weights', async () => {
    const ocr = fileId('f-ocr');
    const vis = fileId('f-vis');
    store.registerFile(ocr, FIXED_EPOCH, 'ocr');
    store.registerFile(vis, FIXED_EPOCH, 'vision');
    const vec = new Float32Array(64);
    vec[0] = 1;
    await store.upsert([
      { chunkId: chunkId('c-ocr'), fileId: ocr, vector: vec },
      { chunkId: chunkId('c-vis'), fileId: vis, vector: vec },
    ]);
    const hits = await store.query(vec, {
      range: { from: new Date(0), to: new Date(NOW.getTime()), label: 'all' },
      limit: 10,
      sourceWeights: { vision: 2 },
    });
    expect(hits[0]!.fileId).toBe(vis);
  });

  it('deleteByFile removes only that file', async () => {
    const { inRange, outOfRange } = await seedInAndOut();
    expect(await store.count()).toBe(2);
    await store.deleteByFile(inRange);
    expect(await store.count()).toBe(1);
    const hits = await store.query(new Float32Array(64), {
      range: { from: new Date(0), to: new Date(NOW.getTime()), label: 'all' },
      limit: 10,
    });
    expect(hits.map((h) => h.fileId)).toEqual([outOfRange]);
  });
});

describe('FakeTextExtractor / FakeVisionDescriber', () => {
  it('returns low confidence for paths registered as low-confidence', async () => {
    const f = new FakeTextExtractor();
    await f.load();
    f.lowConfidencePaths.add('/x/diagram.png');
    const r = await f.extract('/x/diagram.png');
    expect(r.confidence).toBeLessThan(0.2);
    expect(r.text).toBe('');
  });

  it('counts calls so routing tests can assert vision was NOT called', async () => {
    const vis = new FakeVisionDescriber();
    await vis.load();
    expect(vis.describeCalls).toBe(0);
    await vis.describe('/x/a.png');
    expect(vis.describeCalls).toBe(1);
  });

  it('fails per-path to test resilience', async () => {
    const vis = new FakeVisionDescriber();
    await vis.load();
    vis.failPaths.add('/x/bad.png');
    await expect(vis.describe('/x/bad.png')).rejects.toBeInstanceOf(AppError);
    await expect(vis.describe('/x/ok.png')).resolves.toContain('whiteboard');
  });
});

describe('FakeSummarizer / FakeThumbnailer / FakeKeywordIndex', () => {
  it('summarizer fails on demand', async () => {
    const s = new FakeSummarizer();
    await s.load();
    s.shouldFail = true;
    await expect(s.summarize('q', [])).rejects.toBeInstanceOf(AppError);
  });

  it('thumbnailer skips regeneration for cached paths', async () => {
    const t = new FakeThumbnailer();
    const first = await t.create('/a.png', '/thumbs/a.webp');
    const second = await t.create('/a.png', '/thumbs/a.webp');
    expect(first.regenerated).toBe(true);
    expect(second.regenerated).toBe(false);
  });

  it('keyword index scores only matching docs', async () => {
    const k = new FakeKeywordIndex();
    const a = chunkId('a');
    const b = chunkId('b');
    await k.upsert(a, 'paging and tlb');
    await k.upsert(b, 'branch prediction');
    const hits = await k.search('tlb', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunkId).toBe(a);
  });

  it('keyword deleteByFile removes its chunks', async () => {
    const k = new FakeKeywordIndex();
    const f = fileId('f1');
    const c = chunkId('c1');
    await k.upsert(c, 'paging');
    k.register(c, f);
    await k.deleteByFile(f);
    expect(await k.search('paging', 10)).toHaveLength(0);
  });
});

describe('fixture-free determinism check', () => {
  it('two embedders with no shared state still agree', async () => {
    const a = new FakeEmbedder();
    const b = new FakeEmbedder();
    await a.load();
    await b.load();
    expect(Array.from(await a.embed('x'))).toEqual(Array.from(await b.embed('x')));
  });

  it('retrieved items type is constructible in tests', () => {
    const item: RetrievedItem = { chunkId: chunkId('c'), fileId: fileId('f'), text: 't', source: 'ocr' };
    expect(item.source).toBe('ocr');
    void NOW.getTime();
    void DAY;
  });
});