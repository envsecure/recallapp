/**
 * Hybrid ranking (F8).
 *
 * Blends vector similarity with keyword score. Uses Reciprocal Rank Fusion
 * rather than a weighted score sum: RRF needs no score calibration between two
 * incomparable score scales, and cannot be broken by a vector score that
 * happens to fall outside 0..1 (which inner-product on unnormalised data does).
 */

import type { FileId, RetrievedItem, SearchHit, VectorHit } from '@/interfaces/capabilities';

export interface RankInput {
  vectorHits: readonly VectorHit[];
  keywordHits: readonly { chunkId: string; score: number }[];
  /** chunkId -> the text it came from, for snippets and source labelling. */
  items: ReadonlyMap<string, RetrievedItem>;
  /** fileId -> metadata needed to build a SearchHit. */
  files: ReadonlyMap<string, { path: string; mtime: Date; thumbUrl?: string }>;
  limit: number;
  sourceWeights?: Readonly<Partial<Record<'ocr' | 'vision', number>>>;
}

const RRF_K = 60;

export function fuseRank(input: RankInput): SearchHit[] {
  const { vectorHits, keywordHits, items, files, limit } = input;
  const scores = new Map<string, { score: number; byVector: boolean }>();

  vectorHits.forEach((hit, i) => {
    scores.set(hit.chunkId, { score: 1 / (RRF_K + i + 1), byVector: true });
  });

  keywordHits.forEach((hit, i) => {
    const prev = scores.get(hit.chunkId);
    const contribution = 1 / (RRF_K + i + 1);
    if (prev) prev.score += contribution;
    else scores.set(hit.chunkId, { score: contribution, byVector: false });
  });

  const out: SearchHit[] = [];
  for (const [chunkId, { score }] of scores) {
    const item = items.get(chunkId);
    const file = item ? files.get(item.fileId) : undefined;
    if (!item || !file) continue;

    const weight = input.sourceWeights?.[item.source] ?? 1;
    out.push({
      fileId: item.fileId as FileId,
      path: file.path,
      score: score * weight,
      snippet: snippet(item.text, score),
      source: item.source,
      mtime: file.mtime,
      ...(file.thumbUrl !== undefined ? { thumbUrl: file.thumbUrl } : {}),
    });
  }

  out.sort((a, b) => b.score - a.score || b.mtime.getTime() - a.mtime.getTime());
  return out.slice(0, limit);
}

const MAX_SNIPPET = 160;

function snippet(text: string, score: number): string {
  void score;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_SNIPPET ? clean : `${clean.slice(0, MAX_SNIPPET - 1)}…`;
}