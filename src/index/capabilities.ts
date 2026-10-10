/**
 * Capability selection.
 *
 * Picks the real adapter when its weights are on disk, and the deterministic
 * fake otherwise. The choice is explicit and reported, never silent — a run
 * that quietly fell back to fakes is how you end up believing you tested
 * retrieval quality when you tested nothing of the kind.
 */

import type { Embedder, TextExtractor, VisionDescriber } from '@/interfaces/capabilities';
import { TesseractExtractor, TransformersEmbedder, TransformersVision, availableModels } from '@/index/adapters';
import { FakeEmbedder, FakeTextExtractor } from '@/index/fakeModels';

export interface CapabilityChoice {
  extractor: TextExtractor;
  embedder: Embedder;
  vision?: VisionDescriber;
  /** True when every model is real; false means at least one is a fake. */
  real: boolean;
  /** Human-readable summary, logged by the CLI. */
  describe: string;
}

export interface SelectOptions {
  modelDir: string;
  /** Force fakes regardless of what is installed (used by tests and the dev box). */
  fake?: boolean;
  /** Load the vision model if present. Expensive, so opt-in. */
  withVision?: boolean;
}

/**
 * Build the capability set for an indexing or search run.
 *
 * Fakes are not load-blocking: the fakes have no meaningful load cost, and a
 * real OCR worker that fails to start should not prevent search from working
 * with whatever text is already indexed.
 */
export async function selectCapabilities(opts: SelectOptions): Promise<CapabilityChoice> {
  if (opts.fake) {
    const extractor = new FakeTextExtractor();
    const embedder = new FakeEmbedder();
    await extractor.load();
    await embedder.load();
    return {
      extractor,
      embedder,
      real: false,
      describe: 'FAKE extractor + FAKE embedder (no models loaded)',
    };
  }

  const installed = availableModels(opts.modelDir);
  const hasOcr = installed.includes('tessdata-eng');
  const hasEmbed = installed.includes('bge-small-en-v1.5');
  const hasVision = installed.includes('florence2-base-ft');

  const parts: string[] = [];

  let extractor: TextExtractor;
  if (hasOcr) {
    const real = new TesseractExtractor(opts.modelDir);
    await real.load();
    extractor = real;
    parts.push('tesseract OCR');
  } else {
    const fake = new FakeTextExtractor();
    await fake.load();
    extractor = fake;
    parts.push('FAKE extractor');
  }

  let embedder: Embedder;
  if (hasEmbed) {
    const real = new TransformersEmbedder(opts.modelDir);
    await real.load();
    embedder = real;
    parts.push('bge-small embeddings (384d)');
  } else {
    const fake = new FakeEmbedder();
    await fake.load();
    embedder = fake;
    parts.push('FAKE embedder (64d)');
  }

  let vision: VisionDescriber | undefined;
  if (opts.withVision && hasVision) {
    vision = new TransformersVision(opts.modelDir);
    parts.push('Florence-2 vision');
  } else if (opts.withVision) {
    parts.push('no vision model installed');
  }

  const real = hasOcr && hasEmbed;
  return {
    extractor,
    embedder,
    ...(vision ? { vision } : {}),
    real,
    describe: parts.join(' + '),
  };
}