#!/usr/bin/env node
/**
 * Indexing CLI.
 *
 * On the dev box this runs against the FAKES, because no model can be
 * downloaded here (GOAL.md C2). That is not a workaround — it is how the
 * pipeline is exercised end to end without inference:
 *
 *   npm run index -- --folder test/fixtures/generated --fake
 *
 * The `--fake` flag is explicit and required, so nobody can mistake a fake-backed
 * run for a real one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '@/config';
import { openDb, migrate } from '@/db/sqlite';
import { SqliteKeywordIndex } from '@/db/keyword';
import { SqliteVectorStore } from '@/db/vectorstore';
import { NoiseFilter } from '@/index/filter';
import { FakeEmbedder, FakeTextExtractor, FakeVectorStore } from '@test/fakes/fakes';
import type { ChunkId, FileId } from '@/interfaces/capabilities';

interface Options {
  folder: string;
  reset: boolean;
  fake: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const flag = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    folder: flag('folder', '') ?? '',
    reset: argv.includes('--reset'),
    fake: argv.includes('--fake'),
    limit: Number(flag('limit', '0') ?? '0'),
  };
}

/**
 * Fixture-aware fake pipeline.
 *
 * Reads the manifest the fixture generator writes, so OCR "results" come from
 * the known topic text rather than from the filename. That makes the whole
 * index path — hash, filter, chunk, embed, store — exercisable on a box with no
 * models, with ground truth to assert against.
 */
function fakeTextFor(path: string, manifestDir: string): string {
  const manifestPath = join(manifestDir, 'manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      manifest: { file: string; text: string }[];
    };
    const name = path.split('/').pop() ?? '';
    return manifest.manifest.find((m) => m.file === name)?.text ?? '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.fake) {
    console.error(
      'This build has no runnable model adapters (GOAL.md C2 — the dev box cannot download weights).\n' +
        'Run with --fake to exercise the pipeline against deterministic fakes.',
    );
    process.exit(2);
  }
  if (!opts.folder) {
    console.error('usage: npm run index -- --folder <path> --fake [--reset] [--limit N]');
    process.exit(2);
  }

  const config = makeConfig();
  const db = openDb(config.paths.dbFile);
  migrate(db);

  if (opts.reset) {
    for (const t of ['vectors', 'fts', 'chunks', 'files']) db.exec(`DELETE FROM ${t}`);
    console.log('reset: cleared files, chunks, vectors, fts');
  }

  const store = new SqliteVectorStore(db);
  const keywordIndex = new SqliteKeywordIndex(db);
  const embedder = new FakeEmbedder();
  const extractor = new FakeTextExtractor();
  await embedder.load();
  await extractor.load();

  const { contentHash, perceptualHash, looksSolid } = await import('@/index/filter');
  const filter = new NoiseFilter();

  const manifestDir = opts.folder;
  const entries = readdirSync(opts.folder)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .slice(0, opts.limit > 0 ? opts.limit : undefined);

  const stats = { indexed: 0, skipped: 0, dropped: 0, failed: 0 };
  const started = Date.now();

  for (const name of entries) {
    const path = join(opts.folder, name);
    const hash = contentHash(path);
    const verdict = filter.check(path, hash, looksSolid(path));
    if (!verdict.keep) {
      stats.dropped += 1;
      continue;
    }

    const existing = db.prepare('SELECT status FROM files WHERE content_hash = ?').get(hash) as
      | { status: string }
      | undefined;
    if (existing?.status === 'done') {
      stats.skipped += 1;
      continue;
    }

    const mtimeMs = (await import('node:fs')).statSync(path).mtimeMs;
    const fileId = name as FileId;
    const text = fakeTextFor(path, manifestDir);
    extractor.lowConfidencePaths.has(path);

    try {
      const extracted = await extractor.extract(path);
      const body = text || extracted.text;

      db.prepare(
        `INSERT INTO files(id,path,mtime_ms,bytes,content_hash,phash,status,ocr_confidence,ocr_chars,needs_vision,indexed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, bytes=excluded.bytes,
           content_hash=excluded.content_hash, phash=excluded.phash, status=excluded.status,
           ocr_confidence=excluded.ocr_confidence, ocr_chars=excluded.ocr_chars,
           needs_vision=excluded.needs_vision, indexed_at=excluded.indexed_at`,
      ).run(
        fileId,
        path,
        Math.floor(mtimeMs),
        (await import('node:fs')).statSync(path).size,
        hash,
        perceptualHash(path),
        'done',
        extracted.confidence,
        body.length,
        body.length < 20 ? 1 : 0,
        Date.now(),
      );

      const cid = `${fileId}#0` as ChunkId;
      db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
      db.prepare('INSERT INTO chunks(id,file_id,source,text,tokens,ord) VALUES(?,?,?,?,?,?)').run(
        cid,
        fileId,
        'ocr',
        body,
        Math.ceil(body.length / 4),
        0,
      );

      const vec = await embedder.embed(body);
      await store.upsert([{ chunkId: cid, fileId, vector: vec }]);
      await keywordIndex.upsert(cid, body);
      keywordIndex.register(cid, fileId);

      stats.indexed += 1;
      process.stdout.write(`\rindexed ${stats.indexed}/${entries.length}`);
    } catch {
      stats.failed += 1;
    }
  }

  const elapsed = Date.now() - started;
  console.log(`\n\ndone in ${elapsed}ms`);
  console.log(`  indexed: ${stats.indexed}`);
  console.log(`  skipped (already done): ${stats.skipped}`);
  console.log(`  dropped (noise): ${stats.dropped}`);
  console.log(`  failed: ${stats.failed}`);
  console.log(`  vectors in store: ${await store.count()}`);
  console.log(`  db: ${config.paths.dbFile}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});