/**
 * Config.
 *
 * The host is not configurable and that is deliberate: GOAL.md C1 requires the
 * server to bind loopback only, and a `HOST` env override would be a one-line
 * way to break the project's core promise (AGENT.md, module conventions).
 */

import { join } from 'node:path';

export const HOST = '127.0.0.1';

export const DEFAULT_PORT = 5174;

export interface DataPaths {
  /** The single SQLite file. Everything lives here. */
  dbFile: string;
  /** Generated thumbnails, keyed by content hash. */
  thumbDir: string;
  /** Where model weights would live if a real adapter were wired (never fetched at runtime). */
  modelDir: string;
}

export interface RecallConfig {
  dataDir: string;
  paths: DataPaths;
  port: number;
  /** User-chosen folder to index. Null until set at first run. */
  indexFolder: string | null;
}

export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return env['RECALL_DATA_DIR'] ?? join(env['HOME'] ?? '.', '.localrecall');
}

export function makeConfig(overrides: Partial<RecallConfig> = {}): RecallConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  return {
    dataDir,
    paths: {
      dbFile: join(dataDir, 'index.db'),
      thumbDir: join(dataDir, 'thumbs'),
      modelDir: join(dataDir, 'models'),
      ...overrides.paths,
    },
    // `??` does not catch NaN, so the env value is normalised explicitly —
    // otherwise an unset RECALL_PORT yields a NaN port and listen() throws.
    port: overrides.port ?? envPort() ?? DEFAULT_PORT,
    indexFolder: overrides.indexFolder ?? null,
  };
}

function envPort(): number | undefined {
  const raw = process.env['RECALL_PORT'];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}