/**
 * Real adapters — where model libraries plug in.
 *
 * These are genuinely runnable on a machine that has the weights present (see
 * `scripts/fetch-models.sh`). They were stubs that threw
 * `capability_unavailable` by design, because the build machine could not
 * download or run models (GOAL.md C2).
 *
 * Two properties hold on every machine:
 *
 * 1. **Nothing is fetched at import time or at module load.** Weights must
 *    already exist under `modelDir`, or `resolveModelPath` throws naming the
 *    exact expected path. A model library's default download-on-first-use is
 *    disabled explicitly (`allowRemoteModels = false`, `cacheMethod: 'none'`)
 *    because that default is the easiest way to break the offline guarantee.
 *
 * 2. **One model resident at a time** (GOAL.md C4). Every adapter takes a
 *    shared `ModelSlot`; loading one evicts the others.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder, ExtractedText, TextExtractor, VisionDescriber } from '@/interfaces/capabilities';
import { AppError } from '@/errors';

// ---------------------------------------------------------------- model slot

interface Loadable {
  readonly name: string;
  unload(): Promise<void>;
}

/**
 * Enforces C4: at most one resident model.
 *
 * A module-level singleton, which AGENT.md forbids for services. Safe here
 * because this is process-wide resource arbitration, not application state —
 * two independent slots would each believe they owned the RAM.
 */
class ModelSlot {
  private current: Loadable | null = null;

  async acquire(model: Loadable, load: () => Promise<void>): Promise<void> {
    if (this.current?.name === model.name) return;
    if (this.current) {
      const prev = this.current;
      this.current = null;
      await prev.unload();
    }
    await load();
    this.current = model;
  }

  /** Idempotent, and safe to call before anything was acquired. */
  async release(): Promise<void> {
    if (!this.current) return;
    const m = this.current;
    this.current = null;
    await m.unload();
  }

  get resident(): string | null {
    return this.current?.name ?? null;
  }
}

const SLOT = new ModelSlot();

/** Exposed so tests can assert C4 without loading a real model. */
export function residentModel(): string | null {
  return SLOT.resident;
}

// ------------------------------------------------------------ model location

/** Resolve a model directory, or throw with the exact path to create. */
export function resolveModelPath(modelDir: string, name: string): string {
  const dir = join(modelDir, name);
  if (!existsSync(dir)) {
    throw new AppError(
      'capability_unavailable',
      `model "${name}" not found at ${dir}.\n` +
        `Run:  ./scripts/fetch-models.sh${name === 'florence2-base-ft' ? ' --with-vision' : ''}`,
    );
  }
  return dir;
}

/** Which models are actually present, for diagnostics and the UI. */
export function availableModels(modelDir: string): string[] {
  if (!existsSync(modelDir)) return [];
  return readdirSync(modelDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// ---------------------------------------------------------------------- OCR

/**
 * OCR via tesseract.js.
 *
 * The language pack must already be downloaded — tesseract.js otherwise fetches
 * it lazily on first use, which is exactly what C1 forbids. `langPath` is
 * pinned to the local copy and caching is turned off so nothing is re-fetched.
 */
export class TesseractExtractor implements TextExtractor {
  readonly name = 'tesseract';
  private worker: unknown = null;
  private readonly modelDir: string;
  private readonly langs: string;

  constructor(modelDir: string, langs = 'eng') {
    this.modelDir = modelDir;
    this.langs = langs;
  }

  async load(): Promise<void> {
    const tessdataDir = resolveModelPath(this.modelDir, `tessdata-${this.langs}`);
    await SLOT.acquire(this, async () => {
      const { createWorker } = await import('tesseract.js');
      this.worker = await createWorker(this.langs, 1, {
        langPath: tessdataDir,
        cacheMethod: 'none',
        cachePath: tessdataDir,
      });
    });
  }

  async extract(imagePath: string): Promise<ExtractedText> {
    if (!this.worker) {
      throw new AppError('upstream_failure', 'tesseract: extract called before load()');
    }
    const w = this.worker as {
      recognize: (p: string) => Promise<{ data: { text?: string; confidence?: number } }>;
    };
    const { data } = await w.recognize(imagePath);
    return {
      text: (data.text ?? '').trim(),
      words: [],
      // tesseract reports 0-100; the interface is 0-1.
      confidence: (data.confidence ?? 0) / 100,
      imageSize: { width: 0, height: 0 },
    };
  }

  async unload(): Promise<void> {
    const w = this.worker as { terminate?: () => Promise<void> } | null;
    if (w?.terminate) await w.terminate();
    this.worker = null;
  }
}

// ------------------------------------------------------------------ Embedder

const BGE_DIM = 384;

/**
 * Embeddings via transformers.js, ONNX, CPU.
 *
 * Normalised on the way out so the store can use inner product directly.
 * `allowRemoteModels: false` + `allowLocalModels: true` is the important pair:
 * the first forbids fetching, the second permits reading what `fetch-models.sh`
 * already placed there.
 */
export class TransformersEmbedder implements Embedder {
  readonly name = 'bge-small-en-v1.5';
  readonly dimensions = BGE_DIM;
  private pipe: unknown = null;
  private readonly modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async load(): Promise<void> {
    const dir = resolveModelPath(this.modelDir, this.name);
    await SLOT.acquire(this, async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      this.pipe = await pipeline('feature-extraction', dir, {
        dtype: 'q8',
        device: 'cpu',
      });
    });
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) {
      throw new AppError('upstream_failure', 'embedder: embed called before load()');
    }
    const run = this.pipe as (
      t: string,
      o: unknown,
    ) => Promise<{ data: ArrayLike<number>; dims: number[] }>;
    const out = await run(text, { pooling: 'mean', normalize: true });
    const dim = Math.min(BGE_DIM, out.data.length);
    return Float32Array.from(out.data as ArrayLike<number>).slice(0, dim);
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }

  async unload(): Promise<void> {
    this.pipe = null;
  }
}

// -------------------------------------------------------------------- Vision

/**
 * Vision captioning via transformers.js (Florence-2-base-ft).
 *
 * The highest-risk component in the project (IMPLEMENTATION.md Appendix B): it
 * requires remote code execution and its ONNX export does not behave
 * identically on every platform. If it fails here, nothing else breaks — OCR
 * carries indexing and search, and vision only covers the low-confidence subset
 * (C6). Swapping in SmolVLM-256M or an Ollama-side model changes only this class.
 */
export class TransformersVision implements VisionDescriber {
  readonly name = 'florence2-base-ft';
  private pipe: unknown = null;
  private readonly modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async load(): Promise<void> {
    const dir = resolveModelPath(this.modelDir, this.name);
    await SLOT.acquire(this, async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      this.pipe = await pipeline('image-to-text', dir, {
        dtype: 'q8',
        device: 'cpu',
      });
    });
  }

  async describe(imagePath: string): Promise<string> {
    if (!this.pipe) {
      throw new AppError('upstream_failure', 'vision: describe called before load()');
    }
    const run = this.pipe as (p: string) => Promise<Array<{ generated_text?: string }>>;
    const out = await run(imagePath);
    const first = out[0];
    return (first?.generated_text ?? '').trim();
  }

  async unload(): Promise<void> {
    this.pipe = null;
  }
}