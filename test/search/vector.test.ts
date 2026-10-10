import { describe, it, expect } from 'vitest';
import { l2Normalise, norm, dot, toBlob, fromBlob } from '@/search/vector';

describe('vector helpers', () => {
  it('normalises a vector to unit length', () => {
    const v = l2Normalise(new Float32Array([3, 4]));
    expect(norm(v)).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves an already-normalised vector essentially unchanged', () => {
    const v = new Float32Array([0, 1, 0]);
    const out = l2Normalise(v);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it('returns the input unchanged for a zero vector instead of dividing by zero', () => {
    const v = new Float32Array([0, 0, 0]);
    const out = l2Normalise(v);
    expect(Array.from(out)).toEqual([0, 0, 0]);
    expect(Number.isNaN(out[0]!)).toBe(false);
  });

  it('produces a NaN-free vector for negative components', () => {
    const out = l2Normalise(new Float32Array([-3, -4]));
    expect(Number.isNaN(out[0]!)).toBe(false);
    expect(Number.isNaN(out[1]!)).toBe(false);
    expect(norm(out)).toBeCloseTo(1, 6);
  });

  it('computes inner product equal to 1 for identical normalised vectors', () => {
    const a = l2Normalise(new Float32Array([1, 2, 3]));
    const b = l2Normalise(new Float32Array([1, 2, 3]));
    expect(dot(a, b)).toBeCloseTo(1, 6);
  });

  it('computes inner product of 0 for orthogonal normalised vectors', () => {
    const a = l2Normalise(new Float32Array([1, 0]));
    const b = l2Normalise(new Float32Array([0, 1]));
    expect(dot(a, b)).toBeCloseTo(0, 6);
  });

  it('round-trips through a blob without precision loss', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const restored = fromBlob(toBlob(original));
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBe(original[i]);
    }
  });

  it('fromBlob copies rather than aliasing the source buffer', () => {
    // If fromBlob aliased, mutating the restored vector would corrupt the
    // source — a real bug when vectors come from a shared mmap'd region.
    const source = new Float32Array([1, 2, 3, 4, 5, 6]);
    const view = new Uint8Array(source.buffer, 0, 8);
    const restored = fromBlob(view);
    restored[0] = 99;
    expect(source[0]).toBe(1);
  });
});