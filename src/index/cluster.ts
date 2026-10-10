/**
 * Slide clustering — groups consecutive screenshots into slide clusters.
 *
 * Two frames belong to the same cluster when their perceptual-hash hamming
 * distance is <= maxDistance AND they are within maxGapMs of each other.
 * Deterministic: input is sorted by (mtimeMs, path) before clustering, input
 * is never mutated, and ids are sequential.
 */

import { hammingDistance } from '@/index/filter';

/** One input frame to cluster. */
export interface ClusterFrame {
  path: string;
  mtimeMs: number;
  phash: string;
}

/** Tuning knobs for clustering. All optional; see defaults below. */
export interface ClusterOptions {
  /** Max hamming distance to stay in the same cluster. Default 6. */
  maxDistance?: number;
  /** Alias for `maxDistance`. */
  maxHammingDistance?: number;
  /** Max gap in ms between consecutive frames. Default 90000. */
  maxGapMs?: number;
  /** Alias for `maxGapMs`. */
  gapMs?: number;
}

/** One slide cluster. */
export interface SlideCluster {
  id: string;
  frames: ClusterFrame[];
  startMs: number;
  endMs: number;
}

/** Result of clustering. `count` always equals `clusters.length`. */
export interface ClusterResult {
  clusters: SlideCluster[];
  count: number;
}

/** Default max hamming distance for the same cluster. */
export const CLUSTER_MAX_DISTANCE = 6;

/** Default max gap in ms between consecutive frames in a cluster. */
export const CLUSTER_MAX_GAP_MS = 90000;

function resolveMaxDistance(opts: ClusterOptions | undefined): number {
  if (opts?.maxDistance !== undefined) return opts.maxDistance;
  if (opts?.maxHammingDistance !== undefined) return opts.maxHammingDistance;
  return CLUSTER_MAX_DISTANCE;
}

function resolveMaxGapMs(opts: ClusterOptions | undefined): number {
  if (opts?.maxGapMs !== undefined) return opts.maxGapMs;
  if (opts?.gapMs !== undefined) return opts.gapMs;
  return CLUSTER_MAX_GAP_MS;
}

/**
 * Group consecutive screenshots into slide clusters.
 *
 * Deterministic: sorts a copy of `frames` by (mtimeMs, path), then folds
 * consecutive frames into the current cluster while both the phash and the
 * time-gap conditions hold. Never mutates the input. Non-empty input always
 * yields at least one cluster; empty input yields zero clusters.
 */
export function clusterFrames(
  frames: readonly ClusterFrame[],
  opts?: ClusterOptions,
): ClusterResult {
  const maxDistance = resolveMaxDistance(opts);
  const maxGapMs = resolveMaxGapMs(opts);

  if (frames.length === 0) return { clusters: [], count: 0 };

  const sorted: ClusterFrame[] = [...frames].sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const clusters: SlideCluster[] = [];
  let current: ClusterFrame[] = [];
  let previous: ClusterFrame | undefined = undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0] as ClusterFrame;
    const last = current[current.length - 1] as ClusterFrame;
    const id = `cluster-${clusters.length}`;
    clusters.push({
      id,
      frames: [...current],
      startMs: first.mtimeMs,
      endMs: last.mtimeMs,
    });
    current = [];
  };

  for (const frame of sorted) {
    if (previous === undefined) {
      current.push(frame);
    } else {
      const distance = hammingDistance(previous.phash, frame.phash);
      const gap = frame.mtimeMs - previous.mtimeMs;
      if (distance <= maxDistance && gap >= 0 && gap <= maxGapMs) {
        current.push(frame);
      } else {
        flush();
        current.push(frame);
      }
    }
    previous = frame;
  }
  flush();

  return { clusters, count: clusters.length };
}

/** Alias for {@link clusterFrames}. */
export function clusterSlides(
  frames: readonly ClusterFrame[],
  opts?: ClusterOptions,
): ClusterResult {
  return clusterFrames(frames, opts);
}
