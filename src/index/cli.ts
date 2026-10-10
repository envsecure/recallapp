#!/usr/bin/env node
/**
 * Indexing CLI.
 *
 * Uses real models when their weights are present on disk, deterministic fakes
 * otherwise. Which one was used is printed on every run — a silent fallback
 * would let you believe you tested retrieval quality when you tested nothing.
 *
 *   npm run index -- --folder ~/Pictures/Screenshots
 *   npm run index -- --folder ~/Pictures/Screenshots --fake          # force fakes
 *   npm run index -- --folder ~/Pictures/Screenshots --with-vision  # caption hard cases
 *
 * Weights come from scripts/fetch-models.sh. Nothing is ever downloaded here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '@/config';
import { openDb, migrate } from '@/db/sqlite';
import { SqliteKeywordIndex } from '@/db/keyword';
import { SqliteVectorStore } from '@/db/vectorstore';
import { NoiseFilter } from '@/index/filter';
import { Indexer } from '@/index/indexer';
import { selectCapabilities } from '@/index/capabilities';
import { availableModels } from '@/index/adapters';
import { l2Normalise } from '@/search/vector';
import type { ChunkId, FileId } from '@/interfaces/capabilities';

interface Options {
  folder: string;
  reset: boolean;
  fake: boolean;
  limit: number;
  withVision: boolean;
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
    withVision: argv.includes('--with-vision'),
  };
}

/**
 * Ground-truth text for bundled fixtures, read from the manifest the fixture
 * generator writes. A real screenshot folder has no manifest, so this returns
 * '' and the OCR result is used instead.
 */
function fixtureTextFor(path: string, manifestDir: string): string {
  if (!manifestDir.endsWith('generated')) return '';
  try {
    const manifest = JSON.parse(readFileSync(join(manifestDir, 'manifest.json'), 'utf8')) as {
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

  if (!opts.folder) {
    console.error('usage: npm run index -- --folder <path> [--fake] [--with-vision] [--reset] [--limit N]');
    process.exit(2);
  }

  const config = makeConfig();
  const installed = availableModels(config.paths.modelDir);
  if (!opts.fake && installed.length === 0) {
    console.error(
      `No models found in ${config.paths.modelDir}.\n` +
        'Run ./scripts/fetch-models.sh first, or pass --fake to index against deterministic fakes.',
    );
    process.exit(2);
  }

  const caps = await selectCapabilities({
    modelDir: config.paths.modelDir,
    fake: opts.fake,
    withVision: opts.withVision,
  });

  console.log(`capabilities: ${caps.describe}`);
  if (!caps.real && !opts.fake) {
    console.log('WARNING: some models are missing — falling back to fakes for those. Not a real index.');
  }

  const db = openDb(config.paths.dbFile);
  migrate(db);
  if (opts.reset) {
    for (const t of ['vectors', 'fts', 'chunks', 'files']) db.exec(`DELETE FROM ${t}`);
    console.log('reset: cleared files, chunks, vectors, fts');
  }

  const store = new SqliteVectorStore(db);
  const keywordIndex = new SqliteKeywordIndex(db);
  const indexer = new Indexer({
    db,
    extractor: caps.extractor,
    embedder: caps.embedder,
    store,
    keywordIndex,
    filter: new NoiseFilter(),
    now: () => new Date(),
  });

  const started = Date.now();
  let lastLog = 0;
  const result = await indexer.indexFolder(opts.folder, (p) => {
    // Rate-limit: on a real folder, printing every image would cost more than
    // the work it reports.
    const now = Date.now();
    if (now - lastLog > 1000 || p.processed + p.skipped + p.failed >= p.total) {
      lastLog = now;
      const done = p.processed + p.skipped + p.failed;
      process.stdout.write(`\r  ${done}/${p.total}  (${p.failed} failed)   `);
    }
  });
  process.stdout.write('\n');

  // Vision pass over the low-OCR subset only (C6). Roughly 15% of a real
  // screenshot folder, which is what makes this affordable at all.
  let visionCount = 0;
  if (opts.withVision && caps.vision) {
    const cap = opts.limit > 0 ? opts.limit : 500;
    const pending = db
      .prepare("SELECT path FROM files WHERE needs_vision = 1 AND status = 'done' ORDER BY ocr_chars ASC LIMIT ?")
      .all(cap) as { path: string }[];

    if (pending.length > 0) {
      console.log(`\nvision pass: ${pending.length} low-OCR image(s) — this is the slow part`);
      await caps.vision.load();
      for (const row of pending) {
        try {
          const caption = await caps.vision.describe(row.path);
          if (!caption) continue;

          const vec = l2Normalise(await caps.embedder.embed(caption));
          const cid = `vision:${row.path}` as ChunkId;
          const fid = row.path as FileId;
          db.prepare(
            'INSERT OR REPLACE INTO chunks(id,file_id,source,text,tokens,ord) VALUES(?,?,?,?,?,?)',
          ).run(cid, fid, 'vision', caption, Math.ceil(caption.length / 4), 0);
          await store.upsert([{ chunkId: cid, fileId: fid, vector: vec }]);
          await keywordIndex.upsert(cid, caption);
          visionCount += 1;
          process.stdout.write(`\r  captioned ${visionCount}/${pending.length}   `);
        } catch (e) {
          // One bad image must not abort the pass; OCR already contributed text.
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`\n  vision failed for ${row.path}: ${msg}`);
        }
      }
      process.stdout.write('\n');
    }
    await caps.vision.unload();
  } else if (opts.withVision) {
    console.log('\nvision pass skipped: no vision model installed (./scripts/fetch-models.sh --with-vision)');
  }

  const elapsed = Date.now() - started;
  console.log(`\ndone in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  scanned:  ${result.scanned}`);
  console.log(`  indexed:  ${result.processed}`);
  console.log(`  skipped:  ${result.skipped} (already done)`);
  console.log(`  failed:   ${result.failed}`);
  if (result.failed > 0 && result.errors.length > 0) {
    // The per-file errors are the actual diagnosis — without them a run that
    // says "5 failed" gives you nothing to fix. Print the first few.
    console.log('  errors:');
    for (const e of result.errors.slice(0, 5)) {
      console.log(`    - ${e.path}: ${e.error}`);
    }
    if (result.errors.length > 5) console.log(`    ... and ${result.errors.length - 5} more`);
  }
  if (visionCount > 0) console.log(`  captioned: ${visionCount}`);
  console.log(`  vectors:  ${await store.count()}`);
  console.log(`  db:       ${config.paths.dbFile}`);

  if (!caps.real && !opts.fake) {
    console.log('\nThis index was built with fake models. Run ./scripts/fetch-models.sh, then');
    console.log('re-index with --reset to get real OCR and embeddings.');
  }
  db.close();
  // Release native resources so the process exits. The tesseract worker keeps
  // the event loop alive otherwise, and the run appears to hang after "done".
  try {
    await caps.extractor.unload();
  } catch {
    // Unload is best-effort; indexing already succeeded or failed by now.
  }
  try {
    await caps.embedder.unload();
  } catch {
    // Same as above.
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});