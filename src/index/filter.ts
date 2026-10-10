/**
 * Noise filter — runs BEFORE any expensive work.
 *
 * A screenshot folder is maybe 40-60% junk: memes, WhatsApp forwards, error
 * dialogs, near-black video frames. Every one of those costs OCR time and then
 * embeds as a useless vector that can still surface in results.
 *
 * Cheap tests first, most-expensive last, and all of them are content-based —
 * never filename-based. A file called `Screenshot 2024-03-11.png` tells us
 * nothing about whether it is worth indexing.
 */

import { statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface Verdict {
  keep: boolean;
  reason: 'ok' | 'too_small' | 'solid' | 'duplicate';
  /** Present when reason is not 'ok' — the hash of the file we already have. */
  duplicateOf?: string;
}

export interface PassStats {
  scanned: number;
  kept: number;
  tooSmall: number;
  solid: number;
  duplicates: number;
}

/** Below this, a file cannot be a meaningful screenshot. */
export const MIN_BYTES = 2 * 1024;

export function isTooSmall(path: string): boolean {
  try {
    return statSync(path).size < MIN_BYTES;
  } catch {
    return true; // unreadable counts as noise; the file may be gone already
  }
}

/**
 * Cheap solid-colour detection from raw bytes.
 *
 * Not a real image decode — decoding 1000 PNGs just to discard them would cost
 * more than indexing them. Sampling raw bytes is enough to separate "all the
 * same byte" from "structured content", and it never holds much heap.
 */
export function looksSolid(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const size = Math.min(statSync(path).size, 4096);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);

    const seen = new Set<number>();
    // Skip the first 32 bytes: every PNG starts with the same signature, which
    // would make a real image look uniform.
    for (let i = 32; i < buf.length; i++) {
      seen.add(buf[i]!);
      if (seen.size > 32) return false; // enough variety, definitely not solid
    }
    return buf.length > 32 && seen.size <= 2;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Content hash. SHA-256 over the whole file — built in, no dependency, and
 * plenty fast at screenshot sizes. Truncated: this dedupes within one folder,
 * it is not a security boundary.
 */
export function contentHash(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex').slice(0, 32);
}

/**
 * Perceptual hash: 8x8 average hash over sampled bytes.
 *
 * Content hash catches byte-identical copies. Perceptual hash catches the
 * re-saved, re-compressed duplicates that are common when the same screenshot
 * ends up in three folders. Used for clustering in P3; exact-equal phash here
 * keeps P1's dedupe predictable.
 */
export function perceptualHash(path: string): string {
  try {
    const data = readFileSync(path);
    const step = Math.max(1, Math.floor(data.length / 64));
    const grid: number[] = [];
    for (let i = 0; i < data.length && grid.length < 64; i += step) grid.push(data[i]!);
    if (grid.length === 0) return '0'.repeat(16);

    const avg = grid.reduce((a, b) => a + b, 0) / grid.length;
    let bits = '';
    for (const v of grid) bits += v >= avg ? '1' : '0';
    return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
  } catch {
    return '0'.repeat(16);
  }
}

/** Hamming distance between two hex phashes. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * Stateful filter for one scan pass.
 *
 * Tracks hashes seen *this pass* so a second file identical to an earlier one is
 * dropped. Call `reset()` at the start of every scan, or a re-index will reject
 * its own previous output as duplicates.
 */
export class NoiseFilter {
  private readonly seen = new Map<string, string>();
  private readonly stats: PassStats = {
    scanned: 0,
    kept: 0,
    tooSmall: 0,
    solid: 0,
    duplicates: 0,
  };

  /** @param knownHashes hashes already in the database, so a re-index is not self-rejecting. */
  private readonly knownHashes: ReadonlySet<string>;

  constructor(knownHashes: ReadonlySet<string> = new Set()) {
    this.knownHashes = knownHashes;
  }

  check(path: string, hash: string, isSolid: boolean): Verdict {
    this.stats.scanned += 1;

    if (isTooSmall(path)) {
      this.stats.tooSmall += 1;
      return { keep: false, reason: 'too_small' };
    }
    if (isSolid) {
      this.stats.solid += 1;
      return { keep: false, reason: 'solid' };
    }
    // Already indexed, or duplicated earlier in this same pass.
    if (this.knownHashes.has(hash) || this.seen.has(hash)) {
      this.stats.duplicates += 1;
      return { keep: false, reason: 'duplicate', duplicateOf: this.seen.get(hash) ?? 'index' };
    }

    this.seen.set(hash, path);
    this.stats.kept += 1;
    return { keep: true, reason: 'ok' };
  }

  reset(): void {
    this.seen.clear();
    this.stats.scanned = 0;
    this.stats.kept = 0;
    this.stats.tooSmall = 0;
    this.stats.solid = 0;
    this.stats.duplicates = 0;
  }

  getStats(): PassStats {
    return { ...this.stats };
  }
}