/**
 * Text chunking — pure functions, no I/O.
 *
 * Long OCR text must be split before embedding: one vector per slide-sized
 * unit retrieves better than one vector for a whole document, and a single
 * huge input can exceed an embedder's context. Overlap keeps a sentence cut
 * at a boundary retrievable from either side.
 *
 * Token estimate is ~4 chars/token (see db/keyword and index/cli token math),
 * so ~400 tokens ~= 1600 chars and ~60 tokens ~= 240 chars. Word boundaries
 * are always respected so no chunk cuts a word in half.
 */

export interface ChunkOptions {
  /** Target chunk size in tokens. Default 400. */
  maxTokens?: number;
  /** Overlap between consecutive chunks in tokens. Default 60. */
  overlapTokens?: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 60;

function resolveSizes(opts?: ChunkOptions): { maxWords: number; overlapWords: number } {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  // Approximate 1 word ~= 1 token; keeps the window in word units so
  // boundaries are never split, while staying close to the char-based
  // estimate (avg English word + space ~= 5-6 chars ~= 1.5 tokens).
  const maxWords = Math.max(1, Math.floor(maxTokens));
  const overlapWords = Math.min(Math.max(0, Math.floor(overlapTokens)), maxWords - 1);
  return { maxWords, overlapWords };
}

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/**
 * Split long text into overlapping chunks.
 *
 * Never returns an empty array for non-empty input, and never returns a
 * chunk that is only whitespace.
 */
export function chunkText(text: string, opts?: ChunkOptions): string[] {
  if (isBlank(text)) return [];
  const trimmed = text.trim();
  const { maxWords, overlapWords } = resolveSizes(opts);

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  if (words.length <= maxWords) return [words.join(' ')];

  // Single pathological token longer than the window: split by chars so a
  // caller never gets one unbounded chunk. Overlap still applies.
  if (words.length === 1) {
    const maxChars = maxWords * CHARS_PER_TOKEN;
    const overlapChars = overlapWords * CHARS_PER_TOKEN;
    return chunkByChars(words[0] as string, maxChars, overlapChars);
  }

  const step = Math.max(1, maxWords - overlapWords);
  const out: string[] = [];
  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(start + maxWords, words.length);
    const chunk = words.slice(start, end).join(' ');
    if (!isBlank(chunk)) out.push(chunk);
    if (end >= words.length) break;
  }
  // Non-empty input always yields at least one chunk.
  if (out.length === 0) return [words.join(' ')];
  return out;
}

function chunkByChars(text: string, maxChars: number, overlapChars: number): string[] {
  const safeMax = Math.max(1, Math.floor(maxChars));
  const safeOverlap = Math.min(Math.max(0, Math.floor(overlapChars)), safeMax - 1);
  const step = Math.max(1, safeMax - safeOverlap);
  const out: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    const piece = text.slice(start, Math.min(start + safeMax, text.length)).trim();
    if (!isBlank(piece)) out.push(piece);
    if (start + safeMax >= text.length) break;
  }
  return out.length > 0 ? out : [text.trim()];
}

/**
 * Split multi-slide OCR output on blank lines.
 *
 * Slide dumps arrive as blocks separated by blank lines; keeping each slide
 * whole retrieves better than an arbitrary 400-token window across a slide
 * boundary. When the text does not look like slides (fewer than 2 blocks),
 * falls back to chunkText. Over-long single slides are further split.
 */
export function chunkSlides(text: string, opts?: ChunkOptions): string[] {
  if (isBlank(text)) return [];
  const parts = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2) return chunkText(text, opts);

  const out: string[] = [];
  for (const part of parts) {
    const sub = chunkText(part, opts);
    for (const s of sub) {
      if (!isBlank(s)) out.push(s);
    }
  }
  return out.length > 0 ? out : chunkText(text, opts);
}
