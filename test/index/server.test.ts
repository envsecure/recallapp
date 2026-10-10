import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '@/index/server';
import { SearchService } from '@/search/service';
import { makeConfig } from '@/config';
import type { RetrievedItem } from '@/interfaces/capabilities';
import {
  FakeEmbedder,
  FakeKeywordIndex,
  FakeVectorStore,
  chunkId,
  fileId,
} from '@test/fakes/fakes';

const NOW = new Date(2026, 9, 15, 14, 0, 0);

/** res.json() is unknown under strict mode; narrow it once here. */
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

let server: Server;
let base: string;
let store: FakeVectorStore;

beforeAll(async () => {
  const embedder = new FakeEmbedder();
  await embedder.load();

  const keywordIndex = new FakeKeywordIndex();
  store = new FakeVectorStore();

  const fid = fileId('f1');
  store.registerFile(fid, new Date(2026, 8, 12));
  const vec = new Float32Array(64);
  vec[0] = 1;
  await store.upsert([{ chunkId: chunkId('c1'), fileId: fid, vector: vec }]);

  const items = new Map<string, RetrievedItem>([
    ['c1', { chunkId: chunkId('c1'), fileId: fid, text: 'Paging and TLB', source: 'ocr' }],
  ]);
  const files = new Map([[fid, { path: '/imgs/slide.png', mtime: new Date(2026, 8, 12) }]]);

  const config = makeConfig({ port: 0, dataDir: '/tmp/recall-test' });
  const search = new SearchService({ store, keywordIndex, embedder, items, files }, () => NOW);

  const app = createApp({ search, config });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe('server', () => {
  it('binds loopback only (C1)', () => {
    const addr = server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('health endpoint responds', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });
  });

  it('search returns hits and the applied range (F6)', async () => {
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent('paging last month')}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    const hits = body['hits'] as unknown[];
    const range = body['appliedRange'] as { from: string; to: string; label: string };

    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    // Compare as instants, not ISO strings: `new Date(y, m, 1)` is local
    // midnight, which serialises to a different UTC string in every timezone.
    expect(new Date(range.from).getTime()).toBe(new Date(2026, 8, 1).getTime());
    expect(new Date(range.to).getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(range.label.length).toBeGreaterThan(0);
  });

  it('the range the API reports is the range the store received', async () => {
    await fetch(`${base}/api/search?q=${encodeURIComponent('anything last month')}`);
    const last = store.queries[store.queries.length - 1]!;
    expect(last.range.from.getTime()).toBe(new Date(2026, 8, 1).getTime());
    expect(last.range.to.getTime()).toBe(new Date(2026, 9, 1).getTime());
  });

  it('returns 400 for an empty query, not a 500', async () => {
    const res = await fetch(`${base}/api/search?q=`);
    expect(res.status).toBe(400);
    expect((await json(res))['code']).toBe('invalid_input');
  });

  it('unknown api routes return JSON 404, not HTML', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('honours a limit parameter', async () => {
    const res = await fetch(`${base}/api/search?q=paging&limit=1`);
    expect(((await json(res))['hits'] as unknown[]).length).toBeLessThanOrEqual(1);
  });
});