/**
 * Vision-fallback routing — decides whether an OCR extraction needs vision.
 *
 * Fast path is OCR (C6); vision captioning runs only on low-confidence or
 * sparse extractions.
 */

import type { ExtractedText } from '@/interfaces/capabilities';

/** Below this OCR confidence, route to vision. */
export const VISION_CONFIDENCE_THRESHOLD = 0.35;

/** Below this character count, route to vision. */
export const VISION_MIN_CHARS = 20;

export interface DecideVisionOptions {
  /** Override for {@link VISION_CONFIDENCE_THRESHOLD}. */
  confidenceThreshold?: number;
  /** Alias for `confidenceThreshold`. */
  threshold?: number;
  /** Override for {@link VISION_MIN_CHARS}. */
  minChars?: number;
  /** Alias for `minChars`. */
  minCharacters?: number;
}

function resolveThreshold(opts: DecideVisionOptions | undefined): number {
  if (opts?.confidenceThreshold !== undefined) return opts.confidenceThreshold;
  if (opts?.threshold !== undefined) return opts.threshold;
  return VISION_CONFIDENCE_THRESHOLD;
}

function resolveMinChars(opts: DecideVisionOptions | undefined): number {
  if (opts?.minChars !== undefined) return opts.minChars;
  if (opts?.minCharacters !== undefined) return opts.minCharacters;
  return VISION_MIN_CHARS;
}

/**
 * Returns true when the extraction needs vision captioning: OCR confidence is
 * below the threshold OR the extracted character count is below the minimum.
 *
 * A completely empty extraction always returns true.
 */
export function decideVision(
  extracted: ExtractedText,
  opts?: DecideVisionOptions,
): boolean {
  const textLength = extracted.text.trim().length;
  if (textLength === 0) return true;

  const threshold = resolveThreshold(opts);
  const minChars = resolveMinChars(opts);

  if (!Number.isFinite(extracted.confidence)) return true;
  if (extracted.confidence < threshold) return true;
  if (textLength < minChars) return true;
  return false;
}
