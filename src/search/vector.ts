/**
 * L2-normalisation and vector helpers.
 *
 * Vectors are stored and queried as normalised float32 so the store can use
 * inner product instead of cosine (GOAL.md — P2 DONE condition asserts this).
 * Normalisation happens on write, once, rather than per query.
 */

export function l2Normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

export function norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return Math.sqrt(sum);
}

/** Inner product. Assumes both vectors are already normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Float32Array -> BLOB, little-endian, no JSON. */
export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: the source may be a view into a larger buffer we do not own.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}