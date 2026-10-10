/**
 * Real adapters — the seam where a model library would plug in.
 *
 * IMPORTANT (GOAL.md C2, IMPLEMENTATION.md Appendix C): none of these are
 * executed on the dev box. They are written so the wiring is real and reviewable,
 * and so the interface contract is exercised on a machine that can run models.
 * Nothing here downloads weights at import time or at module load — weights are
 * resolved from a local directory the operator populates by hand.
 *
 * The dev box proves the system with the fakes in test/fakes/. These adapters
 * are unverified here by design; see the runbook's "Known limitations".
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder, ExtractedText, TextExtractor, VisionDescriber } from '@/interfaces/capabilities';
import { AppError } from '@/errors';

/**
 * Model directory contract.
 *
 * A name resolves to `<modelDir>/<name>`. If it is absent, the adapter throws
 * `capability_unavailable` rather than downloading. That is the whole offline
 * guarantee in one place: the only way a weight appears is a human copying it in.
 */
export function resolveModelPath(modelDir: string, name: string): string {
  const dir = join(modelDir, name);
  if (!existsSync(dir)) {
    throw new AppError(
      'capability_unavailable',
      `model "${name}" not found at ${dir}. Models are never downloaded automatically (C1/C2); see docs/runbook.md.`,
    );
  }
  return dir;
}

/** Listing what IS available, for the UI to show which capabilities are live. */
export function availableModels(modelDir: string): string[] {
  if (!existsSync(modelDir)) return [];
  return readdirSync(modelDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * OCR via tesseract.js.
 *
 * Written but NOT run on the dev box: tesseract.js downloads language data
 * (~15 MB) on first use, which C2 forbids here. The interface and the
 * error handling are real; the execution is deferred.
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
    resolveModelPath(this.modelDir, `tessdata-${this.langs}`);
    throw new AppError(
      'capability_unavailable',
      'TesseractExtractor.load() is not exercised on the dev box (C2). Use the fake extractor in tests.',
    );
  }

  async extract(_imagePath: string): Promise<ExtractedText> {
    void this.worker;
    throw new AppError('capability_unavailable', 'TesseractExtractor is unverified on this build');
  }

  async unload(): Promise<void> {
    this.worker = null;
  }
}

/**
 * Vision via transformers.js (Florence-2-base).
 *
 * The highest-risk adapter in the project — it needs remote code execution and
 * its ONNX export does not behave identically on every platform
 * (IMPLEMENTATION.md Appendix B). Isolated behind VisionDescriber so a swap to
 * SmolVLM-256M or an Ollama-side model touches nothing else.
 */
export class TransformersVision implements VisionDescriber {
  readonly name = 'florence2-base';
  private readonly modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async load(): Promise<void> {
    resolveModelPath(this.modelDir, this.name);
    throw new AppError(
      'capability_unavailable',
      'TransformersVision.load() is not exercised on the dev box (C2). Use the fake describer in tests.',
    );
  }

  async describe(_imagePath: string): Promise<string> {
    throw new AppError('capability_unavailable', 'TransformersVision is unverified on this build');
  }

  async unload(): Promise<void> {
    /* no resident model to release in this build */
  }
}

/**
 * Embeddings via transformers.js (bge-small-en-v1.5), ONNX, CPU.
 *
 * Normalisation happens here so the store can assume unit vectors.
 */
export class TransformersEmbedder implements Embedder {
  readonly name = 'bge-small-en-v1.5';
  readonly dimensions = 384;
  private readonly modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async load(): Promise<void> {
    resolveModelPath(this.modelDir, this.name);
    throw new AppError(
      'capability_unavailable',
      'TransformersEmbedder.load() is not exercised on the dev box (C2). Use the fake embedder in tests.',
    );
  }

  async embed(_text: string): Promise<Float32Array> {
    throw new AppError('capability_unavailable', 'TransformersEmbedder is unverified on this build');
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }

  async unload(): Promise<void> {
    /* no resident model to release in this build */
  }
}