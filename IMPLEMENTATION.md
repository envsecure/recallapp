# IMPLEMENTATION.md — phase plan

Each phase lists: what to build, what NOT to build in it, and the exact
conditions that mean it is finished. Do not start phase N+1 until phase N's DONE
conditions are met. A phase that is not done is not done because you ran out of
time — it is not done because its conditions are unmet.

A note on the environment: this is a CPU-only dev box with 2.7 GB RAM and 3.3 GB
free disk. Phases P0–P5 below are all buildable and testable here **using only
fakes** (`GOAL.md` C2, C3). Real-model validation is a different task on a
different machine, and is deliberately excluded from every DONE condition below.

---

## P0 — Foundation

**Goal: a running, testable skeleton with all the seams in place.**

### Do

- Repo scaffold: TypeScript, ESM, strict mode, `vitest`, `npm run typecheck`
- `src/interfaces/` — one interface per external capability, zero implementations:
  - `TextExtractor` — image in, text + bounding boxes + confidence out
  - `VisionDescriber` — image in, natural-language caption out
  - `Embedder` — text in, float32 vector out (normalised)
  - `Summarizer` — prompt + context in, answer text out
  - `VectorStore` — upsert, query, delete by file id
- One fake per interface in `test/fakes/`, all deterministic, all with
  failure knobs. **This is the single most important deliverable in P0.**
- `src/db/` — schema and migrations (files, chunks, vectors, fts). One `.db` file.
  The sqlite-vec extension may be absent in dev; abstract behind `VectorStore`
  so tests run against an in-memory fake store.
- Thumbnail generation module behind an interface, fake in tests.
- Express app with `/api/health` and `/api/search`, binding `127.0.0.1`.
- React + Vite shell: search bar, empty state, results grid, wired to the API.

### Do not

- No model code. No adapters. No downloads.
- No watcher, no OCR, no embeddings — those are P1/P2.

### DONE when

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` runs green with ≥ 1 test per interface fake
- [ ] `test/fakes/` contains a fake for every interface, each deterministic and
      each with failure knobs
- [ ] Every native-resource module exposes idempotent `load()`/`unload()` and has
      a test asserting double-unload safety
- [ ] A test asserts the HTTP server binds `127.0.0.1`
- [ ] `grep -rEn "\.onnx|from_pretrained|https?://" src/` is empty (no model
      download in `src/`). Keep the pattern broad — it must also catch ESM
      `import` and plain URL mentions, and err toward failing loud. The narrower
      `require\(.onnx` form misses `require('./x.onnx')` and false-matches
      `require('onnxruntime')`.
- [ ] UI shell renders and a hardcoded fake result set appears in the grid
- [ ] No dependency downloads model weights at install time

---

## P1 — Indexing

**Goal: get images into the database, incrementally, resumably.**

### Do

- Folder selection (a path, config-persisted). Recursive.
- Filesystem watcher (chokidar) with debounce; plus a full-scan path for the
  first run
- Noise filter *before* indexing: size floor, solid-colour detection, hash dedupe
- Content hash and perceptual hash per file, for dedupe and clustering later
- OCR adapter (real `tesseract.js`) implementing `TextExtractor`, plus reading-
  order reconstruction from bounding boxes. The adapter is written on this box but
  never executed here — it downloads traineddata on first use. Tests drive it
  through the fake `TextExtractor`.
- Chunking: split long OCR text; one chunk per slide-like region where possible
- Persist `files` and `chunks` rows; store OCR text with its source label
- Thumbnail pipeline → WebP, cached by content hash
- Index progress: queued / running / done / failed counters, resumable across restarts
- CLI: `npm run index -- --folder <path> --reset`

### Do not

- No embeddings, no vision, no semantic search yet.
- Do not delete or move user files. Ever.

### DONE when

- [ ] Indexing a folder of N fixture images yields exactly N `files` rows
- [ ] Re-running is a no-op (0 rows rewritten, mtimes unchanged)
- [ ] Touching one file re-indexes exactly one file
- [ ] Deleting a file removes its rows
- [ ] Killing the process mid-index and restarting resumes without reprocessing
      done files
- [ ] Noise filter drops each of: a 500-byte file, a solid-colour image, an exact
      duplicate — each with its own test
- [ ] A full-text search for a word that appears in a fixture's OCR text returns
      that fixture (FTS5 wired end to end)
- [ ] Peak RSS during indexing is recorded in the benchmark output

---

## P2 — Semantic search

**Goal: the version that solves the user's actual problem. Ship here.**

### Do

- Embedding adapter (real `bge-small-en-v1.5` via transformers.js) implementing
  `Embedder`
- Embed all chunks; store as float32 BLOB, **L2-normalised on write**
- Query embedding + ANN/cosine search over `VectorStore`
- **Time filter applied in SQL before ranking** (see `GOAL.md` / rationale below)
- Time expression parser → `{from, to, label}`, with "last month" defaulting to
  the previous calendar month
- Hybrid ranking: fuse vector score and FTS5 score
- Light RRF-style score fusion (cheap, no tuning)
- API: `/api/search?q=...&folder=...`, returns ranked hits with
  `{fileId, path, score, snippet, thumbUrl}`
- UI: resolved-range chip in the search bar, click to change; result grid;
  click a result to open the original image at full size

### Do not

- No VLM / vision fallback (P3).
- No LLM summariser (P4).

### DONE when

- [ ] Embeddings are stored normalised: a test asserts `‖v‖ ≈ 1` within 1e-4
- [ ] Semantic test passes: query "memory management" ranks a fixture whose text
      is "paging and TLB" in the top 10 — using a fake embedder with deterministic
      similarity, plus a marked integration test marked `@integration` skipped by
      default
- [ ] "last month" returns only files inside the resolved range
- [ ] Time filter is pushed into the WHERE clause — asserted by inspecting the SQL
      passed to the store, not by checking results only
- [ ] The range label rendered in the UI equals the range applied to the query
- [ ] Hybrid ranking beats vector-only on a fixture set where an exact keyword
      match should outrank a fuzzy semantic match
- [ ] Search over the 1000-image fixture set returns in under 200 ms (p95)
- [ ] No network call during a full index + search cycle (network stubbed to throw)

---

## P3 — Vision fallback

**Goal: find the screenshots OCR cannot read.**

### Do

- Confidence heuristic → routes to vision or skips it
- Vision adapter (Florence-2-base via transformers.js) implementing
  `VisionDescriber`
- Model registry: mapping logical name → local path, **no download at import**,
  manual `npm run models:pull` for humans
- Model residency manager: at most one model resident (C4); `load`/`unload`
  explicit, unload idempotent
- Vision captions stored as a separate chunk source, weighted differently at rank time
- Slide clustering: perceptual hash + timestamp proximity → clusters

### Do not

- Do not run a VLM in any test.
- Do not make vision a required step for search. Search must work with vision
  entirely absent.

### Do NOT download

`npm run models:pull` should exist as a documented, human-invoked command, but
**must not run in tests, in CI, or at startup.** If you see a download in a test,
that is a bug.

### DONE when

- [ ] High-OCR image (dense text fixture) → vision interface NOT called (spy)
- [ ] Low-OCR image (diagram/whiteboard fixture) → vision interface IS called
- [ ] Vision captions weighted differently from OCR text at rank time (asserted)
- [ ] At most one model resident at any point; a test asserts this
- [ ] `unload()` called twice does not throw
- [ ] Search works with the vision adapter entirely absent

---

## P4 — Answer synthesis

**Goal: a written answer with cited thumbnails.**

### Do

- Summariser adapter (local GGUF or Ollama on 127.0.0.1) implementing `Summarizer`
- Prompt construction: hits as context, each with a citation id
- Grounded answering: the prompt instructs the model to cite ids and say
  "not found" when context is insufficient
- Streaming response over SSE
- UI: summary panel above the grid, each citation clickable → opens that image
- Small model on purpose (Qwen 1.5B-class, ~1 GB). It writes a paragraph over
  results already retrieved; it does not retrieve

### Do not

- Do not let the LLM influence *which* images are retrieved. Retrieval stays
  pure. This is the guard against hallucinated results.

### DONE when

- [ ] Retrieval path is byte-identical whether the summariser is present or absent
- [ ] Retrieval tests pass with the summariser stubbed as always-failing
- [ ] Every claim in the answer maps to a citation id present in the input
- [ ] Summariser stubbed to fail → API still returns results, no 500
- [ ] Summariser stubbed to cite an id not in the input → that citation is dropped

---

## P5 — Quality of life

### Do

- Dedupe UI; re-index all; index stats
- Per-folder excludes; drag a folder in
- Keyboard-first: j/k, enter, esc, `/` to focus search
- First-run progress UI for indexing
- Packaging thoughts (single binary via pkg/SEA is out; document build steps)

### Do not

- Do not add a plugin system (N14).

### DONE when

- [ ] 1000-image fixture benchmark reports index time, p50/p95 search latency, peak RSS
- [ ] Keyboard shortcuts work and are documented
- [ ] A user can go from cold start to a working search in one command

---

## Appendix A — Why the time filter runs before ranking

Post-filtering by date after a vector search is the classic mistake and it fails
in a specific way: you ask the vector store for the top 20 matches globally,
discard the ones outside your date range, and are left with 2 results — while
perfectly good in-range images sat at ranks 21–200 and were never returned.

The filter must be part of the query the vector store executes. So
`/api/search` builds a range first, then calls
`VectorStore.query(vector, {from, to, limit})`, and the store applies the range in
its own WHERE clause. Test by asserting the SQL/params, not by asserting results,
because a result-set assertion can pass for the wrong reason.

## Appendix B — Model choices and their uncertainty

| Role | Choice | Confidence |
|------|--------|-----------|
| OCR | `tesseract.js`, eng | High |
| Embeddings | `bge-small-en-v1.5` ONNX | High |
| Vector store | sqlite-vec | High |
| Vision | Florence-2-base via transformers.js | **Low — this is the P0/P3 risk item** |
| Summariser | Qwen 1.5B-class GGUF | Medium |

Florence-2 through `transformers.js` needs remote code execution, and its ONNX
export does not behave identically on every platform. This is why it is isolated
behind `VisionDescriber` and why the real-model validation is explicitly deferred.
If it fails on the target machine: `SmolVLM-256M`, or an Ollama-side
`moondream`/`llava` are the drop-ins. Nothing outside `VisionDescriber` should
know which one is in use.

## Appendix C — What is deliberately unverifiable on this box

Do not write tests for these, and do not claim they work:

- Real OCR accuracy on real screenshots
- Real embedding quality
- Real VLM caption quality
- Real LLM answer quality
- Actual wall-clock performance of inference

These require models we cannot download here. The architecture isolates them
behind interfaces so their absence degrades gracefully — but "degrades
gracefully" is not "verified". `GOAL.md`'s Definition of Done was written to be
honest about this line.