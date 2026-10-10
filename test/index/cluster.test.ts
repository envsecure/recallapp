import { describe, it, expect } from 'vitest';
import { clusterFrames, clusterSlides } from '@/index/cluster';
import type { ClusterFrame } from '@/index/cluster';

const SAME_A = 'aaaaaaaaaaaaaaaa';
const SAME_B = 'aaaaaaaaaaaaaaaa';
// Far apart: every hex digit differs -> 64 bits differ.
const FAR = 'ffffffffffffffff';

function frame(
  path: string,
  mtimeMs: number,
  phash: string,
): ClusterFrame {
  return { path, mtimeMs, phash };
}

describe('clusterFrames', () => {
  it('identical phash within the time gap clusters together', () => {
    const frames = [frame('/a.png', 1000, SAME_A), frame('/b.png', 2000, SAME_B)];
    const result = clusterFrames(frames);
    expect(result.count).toBe(1);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]?.frames.length).toBe(2);
  });

  it('phash far apart does not cluster', () => {
    const frames = [frame('/a.png', 1000, SAME_A), frame('/b.png', 2000, FAR)];
    const result = clusterFrames(frames);
    expect(result.count).toBe(2);
    expect(result.clusters.length).toBe(2);
  });

  it('frames outside the time gap do not cluster', () => {
    const frames = [
      frame('/a.png', 0, SAME_A),
      frame('/b.png', 90000 + 1, SAME_A),
    ];
    const result = clusterFrames(frames);
    expect(result.count).toBe(2);
  });

  it('single frame yields one cluster', () => {
    const result = clusterFrames([frame('/only.png', 5000, SAME_A)]);
    expect(result.count).toBe(1);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]?.startMs).toBe(5000);
    expect(result.clusters[0]?.endMs).toBe(5000);
  });

  it('empty input yields zero clusters', () => {
    const result = clusterFrames([]);
    expect(result.count).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const a = frame('/a.png', 1000, SAME_A);
    const b = frame('/b.png', 2000, SAME_A);
    const r1 = clusterFrames([a, b]);
    const r2 = clusterFrames([b, a]);
    expect(r1).toEqual(r2);
  });

  it('clusterSlides agrees with clusterFrames', () => {
    const frames = [frame('/a.png', 1000, SAME_A), frame('/b.png', 2000, SAME_A)];
    expect(clusterSlides(frames)).toEqual(clusterFrames(frames));
  });
});
