/**
 * Deterministic fakes for every capability in `src/interfaces/capabilities.ts`.
 *
 * These are the backbone of P0 and the reason the rest of Recall is buildable
 * on a box that cannot run models (GOAL.md C2, C3).
 *
 * Two invariants, per AGENT.md:
 * - No `Math.random()`, no `Date.now()`. Seeded PRNG and FIXED_EPOCH only, so
 *   a failing test always fails the same way.
 * - Every fake can fail on purpose. Knobs like `shouldFailLoad` exist so error
 *   paths are reachable without monkey-patching the module under test.
 *
 * `src/` must never import this file.
 */

import type {
  ChunkId,
  Embedder,
  ExtractedText,
  FileId,
  KeywordHit,
  KeywordIndex,
  RetrievedItem,
  Summarizer,
  TextExtractor,
  ThumbnailResult,
  Thumbnailer,
  TimeRange,
  VectorHit,
  VectorStore,
  VisionDescriber,
} from '@/interfaces/capabilities';
import { AppError } from '@/errors';
import { dot, l2Normalise } from '@/search/vector';

// ---------------------------------------------------------------- primitives

/** Fixed clock for every fake. Never call Date.now() in a fake. */
export const FIXED_EPOCH = new Date(2026, 8, 15, 10, 0, 0);

export function fileId(s: string): FileId {
  return s as FileId;
}

export function chunkId(s: string): ChunkId {
  return s as ChunkId;
}

/** mulberry32 — small, deterministic, adequate for fixture variety. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A lifecycle base that makes load/unload safe in any order.
 *
 * `unload()` before `load()` must not throw (C4: unload is idempotent), and
 * `load()` twice must not double-count as two loads.
 */
export class FakeLifecycle {
  readonly name: string;
  isLoaded = false;
  loadCalls = 0;
  unloadCalls = 0;
  shouldFailLoad = false;
  shouldFailUnload = false;

  constructor(name: string) {
    this.name = name;
  }

  async load(): Promise<void> {
    this.loadCalls += 1;
    if (this.shouldFailLoad) {
      throw new AppError('upstream_failure', `${this.name}: load failed (forced)`);
    }
    this.isLoaded = true;
  }

  async unload(): Promise<void> {
    this.unloadCalls += 1;
    if (this.shouldFailUnload) {
      throw new AppError('upstream_failure', `${this.name}: unload failed (forced)`);
    }
    this.isLoaded = false;
  }

  protected assertLoaded(op: string): void {
    if (!this.isLoaded) {
      throw new AppError('upstream_failure', `${this.name}: ${op} called before load()`);
    }
  }
}

// ------------------------------------------------------------- TextExtractor

/**
 * Fake OCR. Returns text derived from the filename, which is enough for
 * fixtures: a file named `0000-paging-tlb.png` yields text mentioning paging.
 *
 * `lowConfidencePaths` forces the vision-fallback branch (C6) without needing a
 * real image the OCR engine would actually fail on.
 */
export class FakeTextExtractor extends FakeLifecycle implements TextExtractor {
  override readonly name = 'fake-ocr';
  extractCalls = 0;
  shouldFailExtract = false;
  /** Paths that return near-empty text with low confidence. */
  lowConfidencePaths = new Set<string>();

  constructor() {
    super('fake-ocr');
  }

  async extract(imagePath: string): Promise<ExtractedText> {
    this.extractCalls += 1;
    this.assertLoaded('extract');
    if (this.shouldFailExtract) {
      throw new AppError('upstream_failure', 'fake-ocr: extract failed (forced)');
    }

    const base = imagePath.split('/').pop() ?? imagePath;
    const stem = base.replace(/\.[^.]+$/, '');

    if (this.lowConfidencePaths.has(imagePath)) {
      return { text: '', words: [], confidence: 0.05, imageSize: { width: 32, height: 24 } };
    }

    return {
      text: `Lecture slide ${stem.replace(/^\d+-/, '').replace(/-/g, ' ')}`,
      words: [
        {
          text: stem,
          confidence: 0.92,
          bbox: { x0: 4, y0: 4, x1: 120, y1: 18 },
        },
      ],
      confidence: 0.9,
      imageSize: { width: 320, height: 240 },
    };
  }
}

// ----------------------------------------------------------- VisionDescriber

export class FakeVisionDescriber extends FakeLifecycle implements VisionDescriber {
  override readonly name = 'fake-vision';
  describeCalls = 0;
  shouldFailDescribe = false;
  /** Paths that make describe() throw, to test per-image resilience. */
  failPaths = new Set<string>();

  constructor() {
    super('fake-vision');
  }

  async describe(imagePath: string): Promise<string> {
    this.describeCalls += 1;
    this.assertLoaded('describe');
    if (this.shouldFailDescribe || this.failPaths.has(imagePath)) {
      throw new AppError('upstream_failure', `fake-vision: describe failed for ${imagePath}`);
    }
    const base = imagePath.split('/').pop() ?? imagePath;
    const stem = base.replace(/\.[^.]+$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
    return `A photograph of a whiteboard showing a diagram about ${stem}.`;
  }
}

// ------------------------------------------------------------------ Embedder

/**
 * Deterministic hash-based embedder.
 *
 * Produces a normalised vector from a 64-bit FNV hash of the text, so the same
 * string always yields the same vector and similar strings yield *some*
 * similarity. Real semantic quality is NOT modelled — see
 * IMPLEMENTATION.md Appendix C. For tests that need a specific similarity
 * relationship, use `FakeEmbedder.forced`.
 */
export class FakeEmbedder extends FakeLifecycle implements Embedder {
  override readonly name = 'fake-embedder';
  readonly dimensions = 64;
  embedCalls = 0;
  shouldFailEmbed = false;
  /** Explicit text -> vector overrides, for tests needing exact geometry. */
  forced = new Map<string, Float32Array>();

  constructor() {
    super('fake-embedder');
  }

  /** Override the vector returned for a specific string. */
  setVector(text: string, vector: Float32Array): void {
    this.forced.set(text, l2Normalise(vector));
  }

  async embed(text: string): Promise<Float32Array> {
    this.embedCalls += 1;
    this.assertLoaded('embed');
    if (this.shouldFailEmbed) {
      throw new AppError('upstream_failure', 'fake-embedder: embed failed (forced)');
    }
    const forced = this.forced.get(text);
    if (forced) return forced;
    return this.hashVector(text);
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }

  /**
   * Map text onto the unit sphere. Each word contributes to a stable bucket,
   * so texts sharing words land near each other — crude, but enough to make
   * "same topic beats different topic" assertions meaningful.
   */
  private hashVector(text: string): Float32Array {
    const rand = mulberry32(fnv1a(text.toLowerCase().trim()));
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) v[i] = rand() * 2 - 1;
    return l2Normalise(v);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Two orthonormal-ish unit vectors, for asserting ranking order. */
export function orthogonalVectors(dimensions = 64): [Float32Array, Float32Array] {
  const a = new Float32Array(dimensions);
  const b = new Float32Array(dimensions);
  a[0] = 1;
  b[1] = 1;
  return [l2Normalise(a), l2Normalise(b)];
}

// ---------------------------------------------------------------- VectorStore

interface StoreEntry {
  fileId: FileId;
  vector: Float32Array;
  mtime: Date;
  source: 'ocr' | 'vision';
}

/**
 * In-memory vector store.
 *
 * The range filter is applied INSIDE query(), to the candidate set before any
 * ranking or limit is taken (IMPLEMENTATION.md Appendix A). That ordering is
 * the whole point: filtering after ranking silently drops in-range items that
 * ranked below the cut.
 */
export class FakeVectorStore implements VectorStore {
  private readonly entries = new Map<ChunkId, StoreEntry>();
  /** Every query's options, so tests can assert what was actually applied. */
  readonly queries: { range: TimeRange; limit: number }[] = [];
  shouldFailUpsert = false;
  shouldFailQuery = false;

  async upsert(
    entries: readonly { chunkId: ChunkId; fileId: FileId; vector: Float32Array }[],
  ): Promise<void> {
    if (this.shouldFailUpsert) {
      throw new AppError('upstream_failure', 'fake-store: upsert failed (forced)');
    }
    // mtime/source are supplied via registerFile so the range filter can work.
    for (const e of entries) {
      const meta = this.meta.get(e.fileId);
      this.entries.set(e.chunkId, {
        fileId: e.fileId,
        vector: e.vector,
        mtime: meta?.mtime ?? FIXED_EPOCH,
        source: meta?.source ?? 'ocr',
      });
    }
  }

  /** File metadata the store needs for range filtering. */
  private readonly meta = new Map<FileId, { mtime: Date; source: 'ocr' | 'vision' }>();

  registerFile(id: FileId, mtime: Date, source: 'ocr' | 'vision' = 'ocr'): void {
    this.meta.set(id, { mtime, source });
    // Propagate to already-upserted chunks for this file.
    for (const [cid, entry] of this.entries) {
      if (entry.fileId === id) {
        entry.mtime = mtime;
        entry.source = source;
      }
    }
  }

  async query(vector: Float32Array, options: { range: TimeRange; limit: number; sourceWeights?: Readonly<Partial<Record<'ocr' | 'vision', number>>> }): Promise<VectorHit[]> {
    if (this.shouldFailQuery) {
      throw new AppError('upstream_failure', 'fake-store: query failed (forced)');
    }
    this.queries.push({ range: options.range, limit: options.limit });

    // Filter FIRST, then score, then limit.
    const inRange = [...this.entries.entries()].filter(([, e]) => {
      const t = e.mtime.getTime();
      return t >= options.range.from.getTime() && t < options.range.to.getTime();
    });

    const scored = inRange
      .map(([cid, e]) => {
        const weight = options.sourceWeights?.[e.source] ?? 1;
        return { chunkId: cid, fileId: e.fileId, score: dot(vector, e.vector) * weight };
      })
      .sort((x, y) => y.score - x.score);

    return scored.slice(0, options.limit).map((s) => ({
      chunkId: s.chunkId,
      fileId: s.fileId,
      score: s.score,
    }));
  }

  async deleteByFile(id: FileId): Promise<void> {
    for (const [cid, e] of [...this.entries]) {
      if (e.fileId === id) this.entries.delete(cid);
    }
  }

  async count(): Promise<number> {
    return this.entries.size;
  }

  /** Total entries before range filtering — for asserting the filter did work. */
  get totalEntries(): number {
    return this.entries.size;
  }
}

// --------------------------------------------------------------- KeywordIndex

export class FakeKeywordIndex implements KeywordIndex {
  private readonly docs = new Map<ChunkId, string>();
  /** fileId -> chunk ids, so deleteByFile can find them. */
  private readonly byFile = new Map<FileId, ChunkId[]>();
  shouldFailSearch = false;

  async upsert(id: ChunkId, text: string): Promise<void> {
    this.docs.set(id, text.toLowerCase());
  }

  /** Record which file a chunk belongs to, enabling deleteByFile. */
  register(id: ChunkId, owner: FileId): void {
    const list = this.byFile.get(owner) ?? [];
    list.push(id);
    this.byFile.set(owner, list);
  }

  async search(query: string, limit: number): Promise<KeywordHit[]> {
    if (this.shouldFailSearch) {
      throw new AppError('upstream_failure', 'fake-keyword: search failed (forced)');
    }
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    const hits: KeywordHit[] = [];
    for (const [cid, text] of this.docs) {
      let score = 0;
      for (const t of terms) if (text.includes(t)) score += 1;
      if (score > 0) hits.push({ chunkId: cid, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map((h) => ({ chunkId: h.chunkId, score: h.score }));
  }

  async deleteByFile(id: FileId): Promise<void> {
    for (const cid of this.byFile.get(id) ?? []) this.docs.delete(cid);
    this.byFile.delete(id);
  }
}

// --------------------------------------------------------------- Summarizer

export class FakeSummarizer extends FakeLifecycle implements Summarizer {
  override readonly name = 'fake-summarizer';
  summarizeCalls = 0;
  shouldFail = false;
  /** Citation ids to emit regardless of input, to test dropping bad cites. */
  forcedCitations: string[] | null = null;

  constructor() {
    super('fake-summarizer');
  }

  async summarize(question: string, context: readonly RetrievedItem[]): Promise<string> {
    this.summarizeCalls += 1;
    this.assertLoaded('summarize');
    if (this.shouldFail) {
      throw new AppError('upstream_failure', 'fake-summarizer: failed (forced)');
    }
    const cites = this.forcedCitations ?? context.slice(0, 2).map((c) => c.chunkId);
    return `About "${question}": ${context.length} relevant item(s). [${cites.join('] [')}]`;
  }
}

// -------------------------------------------------------------- Thumbnailer

export class FakeThumbnailer implements Thumbnailer {
  readonly calls: { imagePath: string; destPath: string }[] = [];
  /** Files already in the thumb cache, so regeneration can be skipped. */
  readonly cache = new Set<string>();
  shouldFail = false;

  async create(imagePath: string, destPath: string): Promise<ThumbnailResult> {
    this.calls.push({ imagePath, destPath });
    if (this.shouldFail) {
      throw new AppError('upstream_failure', 'fake-thumbnail: create failed (forced)');
    }
    if (this.cache.has(destPath)) {
      return { destPath, width: 320, height: 240, regenerated: false };
    }
    this.cache.add(destPath);
    return { destPath, width: 320, height: 240, regenerated: true };
  }
}