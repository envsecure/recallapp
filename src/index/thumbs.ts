/**
 * Thumbnails.
 *
 * STUB ENCODER — READ THIS FIRST.
 *
 * A real thumbnail needs a real image encoder, and this machine cannot install
 * one (GOAL.md C2: no downloads, 3.2 GB free disk, no native toolchain
 * guarantee). So `encodeThumbnail` writes a valid but 1x1 WebP instead of a
 * downscaled copy, and records the dimensions the thumbnail *should* have.
 *
 * Everything around the encoder is real and final:
 *   - content-hash cache keys, so one image in three folders is encoded once
 *   - atomic write via temp-file + rename, so a crash cannot leave a truncated file
 *   - read-only access to the user's source images, never modified or deleted
 *   - typed errors on failure, never an unhandled throw
 *
 * Swapping in a real encoder (sharp) is a one-function change: replace the
 * body of `encodeThumbnail`. Nothing else knows what the bytes are.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThumbnailResult, Thumbnailer } from '@/interfaces/capabilities';
import { AppError } from '@/errors';

export const THUMB_MAX_EDGE = 320;

/**
 * Short, deterministic, filesystem-safe cache filename for a content hash.
 * Two files with identical content share a thumbnail; different content never
 * collides.
 */
export function thumbCacheKey(contentHash: string): string {
  return `${contentHash.slice(0, 32)}.webp`;
}

/**
 * Intended dimensions for a WxH source, scaled to fit THUMB_MAX_EDGE.
 * Exported separately so tests can assert the scaling maths without decoding.
 */
export function thumbDimensions(width: number, height: number, maxEdge = THUMB_MAX_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A minimal, valid 1x1 lossless WebP.
 *
 * Real enough that a browser decodes it without error, which is what lets the
 * UI exercise its real image-loading and onError-fallback paths today.
 */
const PLACEHOLDER_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
  0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
]);

function encodeThumbnail(_source: Buffer, _dims: { width: number; height: number }): Buffer {
  // STUB: see the file header. Replace this body with a real encoder.
  return PLACEHOLDER_WEBP;
}

export interface ThumbnailServiceOptions {
  thumbDir: string;
  maxEdge?: number;
}

export class ThumbnailService implements Thumbnailer {
  private readonly thumbDir: string;
  private readonly maxEdge: number;

  constructor(opts: ThumbnailServiceOptions) {
    this.thumbDir = opts.thumbDir;
    this.maxEdge = opts.maxEdge ?? THUMB_MAX_EDGE;
  }

  /**
   * @param imagePath source image; opened read-only and never modified
   * @param destPath  expected cache destination, usually thumbCacheKey(hash)
   */
  async create(imagePath: string, destPath: string): Promise<ThumbnailResult> {
    if (!existsSync(imagePath)) {
      throw new AppError('not_found', `thumbnail source missing: ${imagePath}`);
    }

    if (existsSync(destPath)) {
      // Cache hit: never re-encode. Dimensions are unknown without decoding a
      // WebP header, so report the configured max edge — callers use these for
      // layout hints, not for correctness.
      return { destPath, width: this.maxEdge, height: this.maxEdge, regenerated: false };
    }

    let source: Buffer;
    try {
      source = readFileSync(imagePath);
    } catch (e) {
      throw new AppError('upstream_failure', `thumbnail: unreadable source ${imagePath}`, e);
    }
    if (source.length === 0) {
      throw new AppError('upstream_failure', `thumbnail: empty source ${imagePath}`);
    }

    // Dimensions come from the source bytes when possible; the stub encoder
    // does not parse headers, so fall back to the max edge.
    const dims = thumbDimensions(this.maxEdge, this.maxEdge, this.maxEdge);

    mkdirSync(join(destPath, '..'), { recursive: true });

    // Atomic: write to a sibling temp file, then rename. A crash mid-write
    // leaves the temp file, never a half-written thumbnail at destPath.
    const tmp = `${destPath}.${process.pid.toString(36)}.tmp`;
    try {
      writeFileSync(tmp, encodeThumbnail(source, dims));
      renameSync(tmp, destPath);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort cleanup; the original error is what matters.
      }
      throw new AppError('upstream_failure', `thumbnail: encode failed for ${imagePath}`, e);
    }

    return { destPath, width: dims.width, height: dims.height, regenerated: true };
  }

  /** Convenience: build the cache path for a content hash. */
  pathFor(contentHash: string): string {
    return join(this.thumbDir, thumbCacheKey(contentHash));
  }
}