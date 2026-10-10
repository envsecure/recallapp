/**
 * Folder scan — recursive, deterministic, never throws on a bad file.
 *
 * Runs BEFORE any expensive work (C6): every file that survives here costs OCR
 * time and a vector downstream, so the NoiseFilter gate lives in this pass.
 * A single unreadable file must not abort the run — it is collected in
 * `errors` and scanning continues (resumability, IMPLEMENTATION.md P1).
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '@/errors';
import {
  NoiseFilter,
  contentHash,
  looksSolid,
  perceptualHash,
} from '@/index/filter';

export interface ScannedFile {
  path: string;
  bytes: number;
  mtimeMs: number;
  contentHash: string;
  phash: string;
}

export interface ScanFileError {
  path: string;
  error: string;
}

export interface ScanOptions {
  filter?: NoiseFilter;
}

export interface ScanResult {
  files: ScannedFile[];
  errors: ScanFileError[];
}

function isSkippedName(name: string): boolean {
  // Dotfiles/dot-directories carry no retrievable content, and node_modules
  // would flood the index with thousands of tiny vendored images.
  return name.startsWith('.') || name === 'node_modules';
}

export function scanFolder(root: string, opts?: ScanOptions): ScanResult {
  const filter = opts?.filter ?? new NoiseFilter();
  // A re-index must not reject its own previous output as duplicates (filter.ts).
  filter.reset();

  const files: ScannedFile[] = [];
  const errors: ScanFileError[] = [];

  function walk(dir: string): void {
    // Annotated as Dirent[] rather than ReturnType<typeof readdirSync>: that
    // alias resolves to the Buffer overload and makes entry.name a Buffer.
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: dir, error: errorMessage(e) });
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (isSkippedName(name)) continue;
      const fullPath = join(dir, name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        // Content-based gate only — never filename-based (filter.ts).
        // Call shape is load-bearing: check(path, contentHash(path), looksSolid(path)).
        const hash = contentHash(fullPath);
        const solid = looksSolid(fullPath);
        const verdict = filter.check(fullPath, hash, solid);
        if (!verdict.keep) continue;

        files.push({
          path: fullPath,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          contentHash: hash,
          phash: perceptualHash(fullPath),
        });
      } catch (e) {
        errors.push({ path: fullPath, error: errorMessage(e) });
        continue;
      }
    }
  }

  try {
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) {
      errors.push({ path: root, error: `not a directory: ${root}` });
      return { files, errors };
    }
  } catch (e) {
    errors.push({ path: root, error: errorMessage(e) });
    return { files, errors };
  }

  walk(root);
  // Deterministic order so re-indexes and tests see the same sequence.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, errors };
}
