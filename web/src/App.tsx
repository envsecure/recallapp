import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

// ---------------------------------------------------------------------------
// API shapes (JSON). Dates arrive as ISO strings — the backend serialises
// Date objects via res.json(), so we parse/format them on display.
// Only same-origin /api is ever fetched (C1 offline requirement).
// ---------------------------------------------------------------------------

interface ApiTimeRange {
  from: string;
  to: string;
  label: string;
}

interface ApiSearchHit {
  fileId: string;
  path: string;
  score: number;
  snippet: string;
  source: 'ocr' | 'vision';
  mtime: string;
  thumbUrl?: string;
}

interface ApiParsedTime {
  range: ApiTimeRange;
  remainingQuery: string;
  matched: string | null;
}

interface ApiSearchResponse {
  hits: ApiSearchHit[];
  appliedRange: ApiTimeRange;
  parsed: ApiParsedTime;
  summary?: string;
}

type Status = 'idle' | 'loading' | 'success' | 'error';
type ScoreLabel = 'Strong' | 'Good' | 'Weak';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHumanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatRangeDetail(range: ApiTimeRange): string {
  const from = formatHumanDate(range.from);
  const to = formatHumanDate(range.to);
  return `${from} → ${to}`;
}

/**
 * Bucket a fused score into a relative label. Scores from reciprocal-rank
 * fusion have no meaningful absolute scale across queries, so we bucket
 * relative to the best hit in this result set. Never show the raw float.
 */
function scoreToLabel(score: number, maxScore: number): ScoreLabel {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return 'Weak';
  }
  const ratio = score / maxScore;
  if (ratio >= 0.8) return 'Strong';
  if (ratio >= 0.45) return 'Good';
  return 'Weak';
}

function scoreToClass(label: ScoreLabel): string {
  if (label === 'Strong') return 'score score-strong';
  if (label === 'Good') return 'score score-good';
  return 'score score-weak';
}

/**
 * Only render thumbnails that are same-origin (C1). Anything else — an
 * absolute filesystem path, a remote URL — falls back to the placeholder
 * so the UI never makes an external network call.
 */
function isSameOriginThumb(url: string | undefined): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

function fileNameOf(path: string): string {
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : path;
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

interface ResultCardProps {
  hit: ApiSearchHit;
  maxScore: number;
  onOpen: (hit: ApiSearchHit) => void;
}

function ResultCard({ hit, maxScore, onOpen }: ResultCardProps): JSX.Element {
  const label = scoreToLabel(hit.score, maxScore);
  const date = formatHumanDate(hit.mtime);
  const hasThumb = isSameOriginThumb(hit.thumbUrl);

  const open = (): void => {
    onOpen(hit);
  };

  return (
    <article
      className="card"
      tabIndex={0}
      role="button"
      aria-label={`Open result ${fileNameOf(hit.path)}, ${label} match, ${date}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="thumb" aria-hidden="true">
        {hasThumb ? (
          <>
            <div className="thumb-placeholder">
              <span className="thumb-icon">◈</span>
            </div>
            <img
              className="thumb-img"
              src={hit.thumbUrl}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </>
        ) : (
          <div className="thumb-placeholder">
            <span className="thumb-icon">◈</span>
            <span className="thumb-text">No preview</span>
          </div>
        )}
        <span className={scoreToClass(label)} title="Relative relevance for this search">
          {label}
        </span>
      </div>
      <div className="card-body">
        <p className="snippet">{hit.snippet || fileNameOf(hit.path)}</p>
        <div className="meta">
          <span className="date">{date}</span>
          <span className="dot" aria-hidden="true">
            ·
          </span>
          <span className="source">{hit.source}</span>
        </div>
        <div className="path" title={hit.path}>
          {fileNameOf(hit.path)}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

export default function App(): JSX.Element {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [hits, setHits] = useState<ApiSearchHit[]>([]);
  const [appliedRange, setAppliedRange] = useState<ApiTimeRange | null>(null);
  const [matched, setMatched] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [chipOpen, setChipOpen] = useState(false);
  const [selected, setSelected] = useState<ApiSearchHit | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('loading');
    setError(null);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        let message = `Search failed (HTTP ${res.status})`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === 'string' && body.error.length > 0) {
            message = body.error;
          }
        } catch {
          // Keep the default message when the error body is not JSON.
        }
        throw new Error(message);
      }

      const data = (await res.json()) as ApiSearchResponse;
      if (!data || !Array.isArray(data.hits) || !data.appliedRange) {
        throw new Error('Unexpected response from server');
      }

      setHits(data.hits);
      setAppliedRange(data.appliedRange);
      setMatched(data.parsed?.matched ?? null);
      setSummary(typeof data.summary === 'string' && data.summary.length > 0 ? data.summary : null);
      setLastQuery(trimmed);
      setChipOpen(false);
      setStatus('success');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Search failed');
      setStatus('error');
    }
  }, []);

  // "/" focuses search when not already typing. Registered once.
  useEffect(() => {
    const onWindowKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const inField =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === '/' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onWindowKey);
    return () => {
      window.removeEventListener('keydown', onWindowKey);
    };
  }, []);

  // Abort any in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Escape in the detail dialog closes it.
  useEffect(() => {
    if (!selected) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('keydown', onEsc);
    };
  }, [selected]);

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void runSearch(query);
  };

  const maxScore = hits.reduce((m, h) => (h.score > m ? h.score : m), 0);
  const rangeLabel = appliedRange ? appliedRange.label : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span className="brand-name">Recall</span>
          <span className="offline-pill" title="Fully offline — the UI only calls same-origin /api">
            offline
          </span>
        </div>
        <div className="hints" aria-hidden="true">
          <kbd>/</kbd> to search · <kbd>esc</kbd> to clear · <kbd>↵</kbd> to open
        </div>
      </header>

      <main className="main">
        <section className="search-section" aria-label="Search">
          <form className="search-row" role="search" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setQuery('');
                  inputRef.current?.blur();
                }
              }}
              placeholder='Try "notes from last month" — press Enter'
              aria-label="Search your images"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="search-btn" type="submit" disabled={status === 'loading'}>
              {status === 'loading' ? 'Searching…' : 'Search'}
            </button>

            {rangeLabel ? (
              <div className="range-wrap">
                <button
                  type="button"
                  className={matched ? 'range-chip' : 'range-chip range-all'}
                  title={
                    matched
                      ? `Understood "${matched}" as ${rangeLabel}. Click to correct it in your query.`
                      : 'No time expression detected — searching all time. Click to refine your query.'
                  }
                  aria-label={`Time range understood: ${rangeLabel}. Activate to edit your query.`}
                  aria-expanded={chipOpen}
                  onClick={() => {
                    setChipOpen((v) => !v);
                  }}
                >
                  <span className="range-dot" aria-hidden="true" />
                  <span className="range-label">{rangeLabel}</span>
                  <span className="range-edit" aria-hidden="true" title="Edit">
                    ✎
                  </span>
                </button>
                {chipOpen && appliedRange ? (
                  <div className="range-pop" role="dialog" aria-label="Time range details">
                    <div className="range-pop-title">Time range understood</div>
                    <div className="range-pop-label">“{appliedRange.label}”</div>
                    <div className="range-pop-detail">{formatRangeDetail(appliedRange)}</div>
                    {matched ? (
                      <div className="range-pop-matched">
                        Matched <code>{matched}</code> in your query.
                      </div>
                    ) : (
                      <div className="range-pop-matched">No time words matched — all time.</div>
                    )}
                    <div className="range-pop-actions">
                      <button
                        type="button"
                        className="range-pop-btn"
                        onClick={() => {
                          setChipOpen(false);
                          inputRef.current?.focus();
                          inputRef.current?.select();
                        }}
                      >
                        Edit query
                      </button>
                      <button
                        type="button"
                        className="range-pop-btn range-pop-close"
                        onClick={() => setChipOpen(false)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="range-wrap">
                <span className="range-chip range-empty" title="Run a search to see the understood time range">
                  <span className="range-dot" aria-hidden="true" />
                  <span className="range-label">No range yet</span>
                </span>
              </div>
            )}
          </form>

          {summary && status === 'success' ? <p className="summary">{summary}</p> : null}
        </section>

        <section className="results-section" aria-label="Results" aria-live="polite">
          {status === 'idle' ? (
            <div className="state state-idle">
              <p className="state-title">Search your offline archive</p>
              <p className="state-sub">
                Type a query and press <kbd>Enter</kbd>. The understood time range will appear as a
                pill next to the search bar so you can correct it.
              </p>
            </div>
          ) : null}

          {status === 'loading' ? (
            <div className="state state-loading" aria-busy="true">
              <div className="spinner" aria-hidden="true" />
              <p className="state-title">Searching…</p>
              <p className="state-sub">Looking through your offline index.</p>
              <div className="skeleton-grid" aria-hidden="true">
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
            </div>
          ) : null}

          {status === 'error' ? (
            <div className="state state-error" role="alert">
              <p className="state-title">Something went wrong</p>
              <p className="state-sub">{error ?? 'Search failed. Is the local backend running?'}</p>
              <button
                type="button"
                className="retry-btn"
                onClick={() => {
                  void runSearch(lastQuery || query);
                }}
              >
                Retry
              </button>
            </div>
          ) : null}

          {status === 'success' && hits.length === 0 ? (
            <div className="state state-empty">
              <p className="state-title">No results</p>
              <p className="state-sub">
                Nothing for <strong>“{lastQuery}”</strong>
                {rangeLabel ? (
                  <>
                    {' '}
                    in <strong>{rangeLabel}</strong>
                  </>
                ) : null}
                . Try different words or broaden the time range.
              </p>
            </div>
          ) : null}

          {status === 'success' && hits.length > 0 ? (
            <>
              <p className="result-count">
                {hits.length} result{hits.length === 1 ? '' : 's'}
                {rangeLabel ? (
                  <>
                    {' '}
                    · <span className="result-range">{rangeLabel}</span>
                  </>
                ) : null}
              </p>
              <div className="grid" role="list">
                {hits.map((hit) => (
                  <div role="listitem" key={hit.fileId}>
                    <ResultCard hit={hit} maxScore={maxScore} onOpen={setSelected} />
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </main>

      {selected ? (
        <div
          className="overlay"
          onClick={() => setSelected(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target === e.currentTarget) setSelected(null);
          }}
          role="presentation"
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Result ${fileNameOf(selected.path)}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-head">
              <span className={scoreToClass(scoreToLabel(selected.score, maxScore))}>
                {scoreToLabel(selected.score, maxScore)}
              </span>
              <button
                type="button"
                className="dialog-close"
                autoFocus
                onClick={() => setSelected(null)}
                aria-label="Close details (Escape)"
              >
                ✕
              </button>
            </div>
            {isSameOriginThumb(selected.thumbUrl) ? (
              <img className="dialog-img" src={selected.thumbUrl} alt="" />
            ) : (
              <div className="thumb-placeholder dialog-placeholder" aria-hidden="true">
                <span className="thumb-icon">◈</span>
                <span className="thumb-text">No preview</span>
              </div>
            )}
            <p className="dialog-snippet">{selected.snippet || fileNameOf(selected.path)}</p>
            <dl className="dialog-meta">
              <div>
                <dt>File</dt>
                <dd title={selected.path}>{selected.path}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatHumanDate(selected.mtime)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selected.source}</dd>
              </div>
            </dl>
            <p className="dialog-hint">
              Press <kbd>esc</kbd> to close.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
