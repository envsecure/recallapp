/**
 * Search service — the orchestration the HTTP layer calls.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. The time range is resolved FIRST and passed INTO the store's query
 *    (IMPLEMENTATION.md Appendix A). Filtering after ranking returns a
 *    truncated result set and silently loses in-range items that ranked below
 *    the cut. The test for this inspects the args the store received, not just
 *    the results, because a results assertion can pass for the wrong reason.
 *
 * 2. Retrieval never depends on the summariser. A failing or absent
 *    Summarizer must not change which files come back (P4 DONE condition:
 *    "retrieval is byte-identical whether the summariser is present or absent").
 */

import type {
  Embedder,
  FileId,
  KeywordIndex,
  RetrievedItem,
  SearchHit,
  Summarizer,
  TimeRange,
  VectorStore,
} from '@/interfaces/capabilities';
import { parseTimeExpression, type ParsedTime } from '@/search/timeparse';
import { fuseRank } from '@/search/rank';
import { AppError } from '@/errors';

export interface SearchDeps {
  store: VectorStore;
  keywordIndex: KeywordIndex;
  embedder: Embedder;
  /** Items by chunk id, so hits can be turned into SearchHit without a join. */
  items: ReadonlyMap<string, RetrievedItem>;
  files: ReadonlyMap<string, { path: string; mtime: Date; thumbUrl?: string }>;
  /** Optional. Search works with this absent (P3 DONE condition). */
  summarizer?: Summarizer;
  sourceWeights?: Readonly<Partial<Record<'ocr' | 'vision', number>>>;
}

export interface SearchRequest {
  q: string;
  limit?: number;
  /** Override the resolved range, e.g. when the user edits the chip (F6). */
  range?: TimeRange;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Echoed back so the UI can render exactly what was applied (F6). */
  appliedRange: TimeRange;
  parsed: ParsedTime;
  summary?: string;
}

const DEFAULT_LIMIT = 50;

export class SearchService {
  constructor(
    private readonly deps: SearchDeps,
    /** Injected so temporal resolution is deterministic in tests (AGENT.md). */
    private readonly now: () => Date,
  ) {}

  async search(req: SearchRequest): Promise<SearchResponse> {
    const q = req.q?.trim() ?? '';
    if (!q) {
      throw new AppError('invalid_input', 'q is required');
    }
    const limit = req.limit ?? DEFAULT_LIMIT;

    const parsed = parseTimeExpression(q, this.now());
    const range = req.range ?? parsed.range;

    // Embed the query with the time words stripped: "notes" is the semantic
    // content, "last month" is a filter and only adds noise to the embedding.
    const vector = await this.deps.embedder.embed(parsed.remainingQuery);

    // Range goes in here, not in a filter after this call.
    const vectorHits = await this.deps.store.query(vector, {
      range,
      limit,
      ...(this.deps.sourceWeights ? { sourceWeights: this.deps.sourceWeights } : {}),
    });

    const chunkIds = vectorHits.map((h) => h.chunkId);
    const keywordHits = chunkIds.length
      ? await this.deps.keywordIndex.search(q, chunkIds.length)
      : [];

    const hits = fuseRank({
      vectorHits,
      keywordHits,
      items: this.deps.items,
      files: this.deps.files,
      limit,
      ...(this.deps.sourceWeights ? { sourceWeights: this.deps.sourceWeights } : {}),
    });

    const response: SearchResponse = { hits, appliedRange: range, parsed };

    // Summariser is strictly downstream and strictly optional. A throw here
    // must not lose the hits.
    if (this.deps.summarizer) {
      const topItems = hits
        .map((h) => this.deps.items.get(h.fileId satisfies string))
        .filter((i): i is RetrievedItem => Boolean(i));
      try {
        response.summary = await this.deps.summarizer.summarize(q, topItems);
      } catch {
        // Deliberately swallowed: results matter, prose does not.
      }
    }

    return response;
  }

  /** Files matching a hit, resolved for the viewer. */
  filesFor(hits: readonly SearchHit[]): FileId[] {
    return hits.map((h) => h.fileId);
  }
}