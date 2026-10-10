import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThumbnailService, thumbCacheKey, thumbDimensions, THUMB_MAX_EDGE } from '@/index/thumbs';
import { contentHash } from '@/index/filter';
import { AppError } from '@/errors';

let dir: string;
let thumbDir: string;
let srcDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recall-thumb-'));
  thumbDir = join(dir, 'thumbs');
  srcDir = join(dir, 'src');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Varied bytes so it looks like a real image file. */
function writeSource(name: string, fill = 1): string {
  const path = join(srcDir, name);
  mkdirSync(srcDir, { recursive: true });
  const buf = Buffer.alloc(4000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + fill * 7) % 251;
  writeFileSync(path, buf);
  return path;
}

describe('thumbCacheKey', () => {
  it('is deterministic for the same hash', () => {
    expect(thumbCacheKey('abc123')).toBe(thumbCacheKey('abc123'));
  });

  it('differs for different content', () => {
    expect(thumbCacheKey('abc123')).not.toBe(thumbCacheKey('def456'));
  });

  it('is filesystem safe and webp-suffixed', () => {
    const key = thumbCacheKey('a'.repeat(64));
    expect(key).toMatch(/^[a-f0-9]+\.webp$/);
    expect(key).not.toContain('/');
  });

  it('two copies of the same image share one key', () => {
    const a = writeSource('copy1.png', 1);
    const b = writeSource('copy2.png', 1);
    expect(contentHash(a)).toBe(contentHash(b));
    expect(thumbCacheKey(contentHash(a))).toBe(thumbCacheKey(contentHash(b)));
  });
});

describe('thumbDimensions', () => {
  it('scales the long edge down to the max', () => {
    expect(thumbDimensions(1920, 1080)).toEqual({ width: 320, height: 180 });
  });

  it('preserves portrait aspect', () => {
    expect(thumbDimensions(1080, 1920)).toEqual({ width: 180, height: 320 });
  });

  it('does not upscale a small image', () => {
    expect(thumbDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it('never returns zero', () => {
    expect(thumbDimensions(0, 0)).toEqual({ width: 1, height: 1 });
    expect(thumbDimensions(10000, 1).height).toBeGreaterThanOrEqual(1);
  });

  it('honours a custom max edge', () => {
    expect(thumbDimensions(1000, 1000, 100)).toEqual({ width: 100, height: 100 });
    expect(THUMB_MAX_EDGE).toBe(320);
  });
});

describe('ThumbnailService', () => {
  it('creates a thumbnail on first call', async () => {
    const svc = new ThumbnailService({ thumbDir });
    const src = writeSource('a.png');
    const dest = svc.pathFor(contentHash(src));

    const res = await svc.create(src, dest);
    expect(res.regenerated).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  it('does not re-encode an existing thumbnail', async () => {
    const svc = new ThumbnailService({ thumbDir });
    const src = writeSource('a.png');
    const dest = svc.pathFor(contentHash(src));

    await svc.create(src, dest);
    const first = readFileSync(dest);
    const res = await svc.create(src, dest);

    expect(res.regenerated).toBe(false);
    // Byte-identical: the cached file was not touched.
    expect(readFileSync(dest).equals(first)).toBe(true);
  });

  it('NEVER modifies the source image', async () => {
    const svc = new ThumbnailService({ thumbDir });
    const src = writeSource('a.png');
    const before = readFileSync(src);

    await svc.create(src, svc.pathFor(contentHash(src)));

    expect(readFileSync(src).equals(before)).toBe(true);
  });

  it('returns a typed error for a missing source, not a throw', async () => {
    const svc = new ThumbnailService({ thumbDir });
    await expect(svc.create(join(srcDir, 'nope.png'), join(thumbDir, 'x.webp'))).rejects.toBeInstanceOf(AppError);
  });

  it('returns a typed error for an empty source', async () => {
    const svc = new ThumbnailService({ thumbDir });
    const empty = join(srcDir, 'empty.png');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(empty, Buffer.alloc(0));
    await expect(svc.create(empty, join(thumbDir, 'y.webp'))).rejects.toBeInstanceOf(AppError);
  });

  it('creates the thumb directory if missing', async () => {
    const svc = new ThumbnailService({ thumbDir: join(dir, 'deep', 'nested', 'thumbs') });
    const src = writeSource('a.png');
    const dest = svc.pathFor(contentHash(src));
    await svc.create(src, dest);
    expect(existsSync(dest)).toBe(true);
  });

  it('leaves no temp files behind on success', async () => {
    const svc = new ThumbnailService({ thumbDir });
    const src = writeSource('a.png');
    await svc.create(src, svc.pathFor(contentHash(src)));

    const { readdirSync } = await import('node:fs');
    expect(readdirSync(thumbDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('two different images produce two different thumbnails', async () => {
    const svc = new ThumbnailService({ thumbDir });
    const a = writeSource('a.png', 1);
    const b = writeSource('b.png', 2);

    const da = svc.pathFor(contentHash(a));
    const db = svc.pathFor(contentHash(b));
    await svc.create(a, da);
    await svc.create(b, db);

    expect(da).not.toBe(db);
    expect(existsSync(da)).toBe(true);
    expect(existsSync(db)).toBe(true);
  });
});