/**
 * Capability interfaces.
 *
 * Every external dependency of Recall sits behind one of these. Nothing in
 * `src/` imports a model library, a database driver, or a network client
 * directly — it takes one of these instead.
 *
 * Why: the dev box (2.7 GB RAM, 3.3 GB free disk, no GPU) cannot run models
 * (GOAL.md C2). Every capability therefore needs a deterministic fake so the
 * rest of the system can be built and tested without them (C3, C9).
 */

/** A word plus where it sat in the source image. */
export interface ExtractedWord {
  text: string;
  /** Confidence 0..1, as reported by the extractor. */
  confidence: number;
  /** Bounding box in pixels of the original image. */
  bbox: BoundingBox;
}

export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExtractedText {
  /**
   * Text in reading order. Extractors are responsible for reconstructing
   * reading order from whatever primitives they expose — a flat list of words
   * in arbitrary order produces poor embeddings downstream.
   */
  text: string;
  /** Words with positions, for layout-aware downstream use. */
  words: ExtractedWord[];
  /** Aggregate confidence 0..1. Drives the vision-fallback decision (C6). */
  confidence: number;
  /** Image width/height in pixels, so boxes can be made relative. */
  imageSize: { width: number; height: number };
}

/**
 * OCR. Runs on every image — it is the fast path (C6).
 *
 * `load`/`unload` are required because native OCR engines hold memory the
 * dev box cannot spare (C4). `unload` must be idempotent.
 */
export interface TextExtractor {
  readonly name: string;
  load(): Promise<void>;
  extract(imagePath: string): Promise<ExtractedText>;
  /** Must be idempotent and safe to call before `load`. */
  unload(): Promise<void>;
}

/**
 * Vision captioning. Runs only on low-OCR-confidence images (C6).
 *
 * Optional at runtime: search must work with no vision adapter present at all.
 */
export interface VisionDescriber {
  readonly name: string;
  load(): Promise<void>;
  describe(imagePath: string): Promise<string>;
  unload(): Promise<void>;
}

/**
 * Text embedding. Output is float32 and MUST be L2-normalised, so the store
 * can use inner product instead of cosine (see db/vectors).
 */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  load(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  /** Convenience for batch callers; must not change per-item semantics. */
  embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
  unload(): Promise<void>;
}

/**
 * Optional answer synthesis over already-retrieved results. v1 runs without it.
 *
 * Contract: this must never influence *which* items are retrieved. Retrieval
 * happens before the summariser is called, and retrieval must be byte-identical
 * whether or not a summariser exists (see GOAL.md, and P4 in IMPLEMENTATION.md).
 */
export interface Summarizer {
  readonly name: string;
  load(): Promise<void>;
  /**
   * @param question user's query
   * @param context retrieved items, each with an id usable as a citation
   */
  summarize(question: string, context: readonly RetrievedItem[]): Promise<string>;
  unload(): Promise<void>;
}

/** One retrievable unit of evidence: a chunk of text from one image. */
export interface RetrievedItem {
  chunkId: ChunkId;
  fileId: FileId;
  text: string;
  /** Which pipeline produced this text — OCR or vision. Ranked differently. */
  source: 'ocr' | 'vision';
}

export type FileId = string & { readonly __brand: 'FileId' };
export type ChunkId = string & { readonly __brand: 'ChunkId' };

/** Date range resolved from a query's time expression. */
export interface TimeRange {
  from: Date;
  to: Date;
  /** Human-readable, e.g. "1 Sep – 30 Sep". Shown in the UI so it can be corrected. */
  label: string;
}

/** A search hit as returned to the UI. */
export interface SearchHit {
  fileId: FileId;
  path: string;
  /** Fused score. Higher is better; scale is not meaningful across queries. */
  score: number;
  /** Short excerpt of matching text for display. */
  snippet: string;
  /** Which text source contributed most to this hit. */
  source: 'ocr' | 'vision';
  mtime: Date;
  thumbUrl?: string;
}

/**
 * Vector store. The time range is a required parameter, not an optional filter:
 * it must be applied *inside* the query, before ranking (IMPLEMENTATION.md
 * Appendix A). Post-filtering returns a truncated result set and loses
 * in-range items that ranked below the cut.
 */
export interface VectorStore {
  upsert(entries: readonly UpsertEntry[]): Promise<void>;
  /**
   * @param vector L2-normalised query vector
   * @param options.range required; applied in the store's own WHERE clause
   */
  query(vector: Float32Array, options: QueryOptions): Promise<VectorHit[]>;
  deleteByFile(fileId: FileId): Promise<void>;
  count(): Promise<number>;
}

export interface UpsertEntry {
  chunkId: ChunkId;
  fileId: FileId;
  /** Normalised float32 vector. Stored as BLOB, not JSON. */
  vector: Float32Array;
}

export interface QueryOptions {
  range: TimeRange;
  limit: number;
  /** Optional per-source weighting, so vision captions can outrank OCR text. */
  sourceWeights?: Readonly<Partial<Record<'ocr' | 'vision', number>>>;
}

export interface VectorHit {
  chunkId: ChunkId;
  fileId: FileId;
  score: number;
}

/** Keyword search over extracted text, used to re-rank semantic hits (F8). */
export interface KeywordIndex {
  upsert(chunkId: ChunkId, text: string): Promise<void>;
  search(query: string, limit: number): Promise<KeywordHit[]>;
  deleteByFile(fileId: FileId): Promise<void>;
}

export interface KeywordHit {
  chunkId: ChunkId;
  score: number;
}

/** Thumbnail generation. Cached by content hash. */
export interface Thumbnailer {
  create(imagePath: string, destPath: string): Promise<ThumbnailResult>;
}

export interface ThumbnailResult {
  destPath: string;
  width: number;
  height: number;
  /** False if an existing cached file was reused. */
  regenerated: boolean;
}