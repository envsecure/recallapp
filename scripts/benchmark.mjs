#!/usr/bin/env node
/**
 * Benchmark against generated fixtures.
 *
 * Reports index time, search latency percentiles, and peak RSS — the numbers
 * IMPLEMENTATION.md P5 asks for. Runs entirely on fakes, so it measures the
 * pipeline's own cost, NOT inference cost (Appendix C: inference timing is
 * unverifiable on this box and is not reported here).
 *
 * Usage:
 *   node scripts/benchmark.mjs
 *   node scripts/benchmark.mjs --count 1000
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const COUNT = Number(flag('count', '1000'));

const ROOT = new URL('..', import.meta.url).pathname;

function peakRssMb() {
  try {
    const status = readFileSyncSafe('/proc/self/status');
    const m = status.match(/VmHWM:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : -1;
  } catch {
    return -1;
  }
}

function readFileSyncSafe(p) {
  // require() is unavailable in ESM; readFileSync is already imported at top.
  return readFileSync(p, 'utf8');
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

console.log(`Recall benchmark — ${COUNT} fixtures, fakes only (no inference)`);
console.log(`Node ${process.version}\n`);

// 1. Generate fixtures
console.log('generating fixtures...');
const t0 = Date.now();
execFileSync('node', [join(ROOT, 'test/fixtures/generate.mjs'), '--count', String(COUNT)], {
  stdio: 'inherit',
});
const genMs = Date.now() - t0;
const fixtureDir = join(ROOT, 'test/fixtures/generated');
const bytes = statSync(fixtureDir).isDirectory()
  ? execFileSync('du', ['-sb', fixtureDir]).toString().split(/\s+/)[0]
  : 0;
console.log(`  generated in ${genMs}ms (${(Number(bytes) / 1048576).toFixed(1)} MiB)\n`);

// 2. Index
console.log('indexing...');
const dataDir = mkdtempSync(join(tmpdir(), 'recall-bench-'));
const tIndex = Date.now();
execFileSync('npx', ['tsx', join(ROOT, 'src/index/cli.ts'), '--folder', fixtureDir, '--fake', '--reset'], {
  stdio: 'inherit',
  env: { ...process.env, RECALL_DATA_DIR: dataDir },
});
const indexMs = Date.now() - tIndex;
console.log(`\n  index wall time: ${indexMs}ms for ${COUNT} files`);
console.log(`  per file: ${(indexMs / COUNT).toFixed(2)}ms`);
console.log(`  peak RSS: ${peakRssMb()} MiB\n`);

// 3. Search latency
console.log('measuring search latency...');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'index.db'));
const vecCount = db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n;
const fileCount = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
db.close();

// Measure the REAL query path: load vectors from the DB, then time SqliteVectorStore
// with and without a time filter. Timing an empty loop would report nothing useful.
// Imported under tsx: node's type-stripping handles the syntax, but the `@/`
// path alias needs a resolver, which only tsx/vitest provide.
const { SqliteVectorStore } = await import(pathToFileURL(join(ROOT, 'src/db/vectorstore.ts')).href);
const { openDb } = await import(pathToFileURL(join(ROOT, 'src/db/sqlite.ts')).href);

const benchDb = openDb(join(dataDir, 'index.db'));
const store = new SqliteVectorStore(benchDb);

function randomVec(dim) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  let s = 0; for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < dim; i++) v[i] /= s;
  return v;
}

const dimRow = benchDb.prepare('SELECT dim FROM vectors LIMIT 1').get();
const DIM = dimRow?.dim ?? 64;

const allTime = { from: new Date(0), to: new Date(Date.now() + 864e5), label: 'all' };
// A window covering roughly one month — the real-world 'last month' shape.
const oneMonth = { from: new Date(Date.now() - 31 * 864e5), to: new Date(Date.now()), label: '30d' };

const samplesAll = [];
const samplesMonth = [];
for (let i = 0; i < 60; i++) {
  const v = randomVec(DIM);
  let s = process.hrtime.bigint();
  await store.query(v, { range: allTime, limit: 50 });
  samplesAll.push(Number(process.hrtime.bigint() - s) / 1e6);
  s = process.hrtime.bigint();
  await store.query(v, { range: oneMonth, limit: 50 });
  samplesMonth.push(Number(process.hrtime.bigint() - s) / 1e6);
}
benchDb.close();
samplesAll.sort((a, b) => a - b);
samplesMonth.sort((a, b) => a - b);


console.log(`\n  files: ${fileCount}, vectors: ${vecCount}, dim: ${DIM}`);
console.log(`\n  search, all-time range (scans every vector):`);
console.log(`    p50: ${pct(samplesAll, 50).toFixed(2)}ms   p95: ${pct(samplesAll, 95).toFixed(2)}ms   max: ${pct(samplesAll, 100).toFixed(2)}ms`);
console.log(`  search, 30-day range (time filter narrows the scan):`);
console.log(`    p50: ${pct(samplesMonth, 50).toFixed(2)}ms   p95: ${pct(samplesMonth, 95).toFixed(2)}ms   max: ${pct(samplesMonth, 100).toFixed(2)}ms`);
console.log(`\n  peak RSS overall: ${peakRssMb()} MiB`);

console.log(`\nNOTE: these numbers exclude model inference entirely (Appendix C).`);
console.log(`Real per-image cost is dominated by OCR/VLM inference, which cannot be`);
console.log(`measured on this box. Treat index time as pipeline overhead only.`);

rmSync(dataDir, { recursive: true, force: true });
void existsSync;