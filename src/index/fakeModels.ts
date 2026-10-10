/**
 * Deterministic stand-ins for the model capabilities, usable from BOTH src/ and
 * test/.
 *
 * Why these live here and not only in `test/fakes/`:
 *   - `src/index/cli.ts` and `src/index/dev.ts` are the manual run/serve entry
 *     points. They must run on this box, where no model can be loaded (C2), and
 *     AGENT.md forbids `src/` importing from `test/`.
 *   - The test suite's own fakes (`test/fakes/fakes.ts`) are richer: they carry
 *     failure knobs, call counters and the range-filtering behaviour tests
 *     assert on. This file is the minimal subset those entry points need.
 *
 * These are NOT production code paths. Real inference goes through the adapters
 * in `src/index/adapters.ts`, which throw `capability_unavailable` on this
 * machine by design. Anything using these must be explicit that it is running
 * against fakes — see the `--fake` flag in cli.ts, which is required for that
 * reason.
 *
 * Deterministic by construction: a seeded PRNG and a fixed clock, never
 * `Math.random()` or `Date.now()` (AGENT.md).
 */

import type { Embedder, ExtractedText, TextExtractor } from '@/interfaces/capabilities';
import { AppError } from '@/errors';
import { l2Normalise } from '@/search/vector';

/** Fixed clock for fake model output. Never call Date.now() here. */
export const FAKE_EPOCH = new Date(2026, 8, 15, 10, 0, 0);

/** mulberry32 — small, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fake OCR: derives text from the filename. Enough to make the pipeline
 * exercisable end to end without a real OCR engine.
 */
export class FakeTextExtractor implements TextExtractor {
  readonly name = 'fake-ocr';
  private loaded = false;

  async load(): Promise<void> {
    this.loaded = true;
  }

  async extract(imagePath: string): Promise<ExtractedText> {
    if (!this.loaded) throw new AppError('upstream_failure', 'fake-ocr: extract before load');
    const base = imagePath.split('/').pop() ?? imagePath;
    const stem = base.replace(/\.[^.]+$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
    return {
      text: `Lecture slide ${stem}`,
      words: [],
      confidence: 0.9,
      imageSize: { width: 320, height: 240 },
    };
  }

  async unload(): Promise<void> {
    this.loaded = false;
  }
}

/**
 * Fake embedder: a normalised vector derived from a hash of the text. Same text
 * always gives the same vector; similar text gives some similarity. Semantic
 * QUALITY is not modelled — see IMPLEMENTATION.md Appendix C.
 */
export class FakeEmbedder implements Embedder {
  readonly name = 'fake-embedder';
  readonly dimensions = 64;
  private loaded = false;

  async load(): Promise<void> {
    this.loaded = true;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.loaded) throw new AppError('upstream_failure', 'fake-embedder: embed before load');
    const rand = mulberry32(fnv1a(text.toLowerCase().trim()));
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) v[i] = rand() * 2 - 1;
    return l2Normalise(v);
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }

  async unload(): Promise<void> {
    this.loaded = false;
  }
}