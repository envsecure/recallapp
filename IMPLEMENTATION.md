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

- [x] `npm run typecheck` exits 0  *(verified 2026-10-10: `tsc --noEmit`, exit 0)*
- [x] `npm test` runs green with ≥ 1 test per interface fake  *(133 tests, 11 files, all pass; every one of the 7 fakes is exercised in `test/fakes/fakes.test.ts`)*
- [x] `test/fakes/` contains a fake for every interface, each deterministic and
      each with failure knobs  *(7/7. Determinism: mulberry32 seeded by FNV-1a,
      `FIXED_EPOCH`, no `Date.now()`. Knobs: `shouldFailLoad/Unload/Extract/
      Embed/Upsert/Query/Search/Describe`, `lowConfidencePaths`, `failPaths`,
      `forced`, `forcedCitations`. Note: `src/index/fakeModels.ts` holds a
      second, thinner fake pair so `cli.ts`/`dev.ts` never import `test/` —
      architecture §8.8)*
- [x] Every native-resource module exposes idempotent `load()`/`unload()` and has
      a test asserting double-unload safety  *(`TextExtractor`, `VisionDescriber`,
      `Embedder`, `Summarizer` all declare both; `test/fakes/fakes.test.ts:21-34`
      asserts unload-before-load and double-unload do not throw. Nothing in `src/`
      actually loads a model — architecture §7)*
- [x] A test asserts the HTTP server binds `127.0.0.1`  *(`test/index/server.test.ts:57-61`,
      asserting on `server.address().address`. Re-confirmed out of band: `ss -ltn`
      showed `127.0.0.1:5174` only)*
- [ ] `grep -rEn "\.onnx|from_pretrained|https?://" src/` is empty.  **NOT MET.**
      One hit, benign but real: `src/index/server.ts:83` logs
      `` `recall listening on http://${HOST}:${deps.config.port}` ``. No model
      download, no remote fetch and no CDN reference exists anywhere in `src/` —
      but the box as written is not empty, so the condition as stated fails.
      Fix the log line or narrow the pattern; the substance of the check holds.
- [x] UI shell renders and a hardcoded fake result set appears in the grid  *(`web/`
      React 18 + Vite: `App.tsx`, `App.css`, `main.tsx`; builds, and results render
      from `/api/search`. Note the set is **not** hardcoded — it comes from the API
      against the real SQLite store. The grid is a plain CSS grid, **not**
      virtualised: F7's fast scroll at 10k+ images is unmet)*
- [x] No dependency downloads model weights at install time  *(`package.json` runtime
      dependencies: `express` only. Dev: `@types/express`, `@types/node`, `tsx`,
      `typescript`, `vitest`. `web/`: react, react-dom, vite, typescript)*

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

- [x] Indexing a folder of N fixture images yields exactly N `files` rows  *(`integration.test.ts:101-112`:
      2 fixtures → 2 files / 2 chunks / 2 vectors / 2 fts rows)*
- [x] Re-running is a no-op (0 rows rewritten, mtimes unchanged)  *(`indexer.test.ts:102-143`:
      second run processed=0, skipped=2, extractor not called again. The skip keys on
      content hash, not mtime — see architecture §8.3)*
- [ ] Touching one file re-indexes exactly one file  **NOT MET, deliberately so.**
      The resume check is `content_hash = ? AND status = 'done'`
      (`indexer.ts:152-155`), so a `touch` that changes mtime but not bytes is
      **skipped**, not re-indexed. That is right for dedupe and wrong for this
      condition. Rewriting the box to match the code would make the plan document
      claim something it did not ask for. Architecture §8.3.
- [ ] Deleting a file removes its rows  **NOT MET.** No reconcile-removed-files
      pass exists. `scanFolder` only walks files that are present; nothing ever
      deletes a `files` row for a missing image, so its chunks, vectors and FTS
      rows — and its search hits — survive forever. The FK cascade does work when a
      row *is* deleted (`integration.test.ts:236-243`), but nothing triggers it.
      Architecture §8.3.
- [x] Killing the process mid-index and restarting resumes without reprocessing
      done files  *(same mechanism as the no-op case: a file is marked `done` only
      after all its rows commit, and the check is on `status` + hash. Verified as two
      Indexer runs over one database (`integration.test.ts:114-125`), not as an
      actual SIGKILL — the state machine is identical, the kill itself is untested)*
- [x] Noise filter drops each of: a 500-byte file, a solid-colour image, an exact
      duplicate — each with its own test  *(`integration.test.ts:292-308`: three
      separate tests for tiny / solid / duplicate. `looksSolid` skips the first 32
      bytes because every PNG shares a signature)*
- [x] A full-text search for a word that appears in a fixture's OCR text returns
      that fixture (FTS5 wired end to end)  *(`integration.test.ts:246-254`: index a
      fixture, `kw.search('slide')` returns hits. Punctuation queries also asserted
      not to throw, and `sanitize` quoting at 263-272)*
- [x] Peak RSS during indexing is recorded in the benchmark output  *(`benchmark.mjs:79`
      reads `VmHWM` from /proc/self/status: 65 MiB after index, 90 MiB overall)*

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

- [x] Embeddings are stored normalised: a test asserts `‖v‖ ≈ 1` within 1e-4  *(`integration.test.ts:137-147`
      reads the BLOB back out of SQLite and asserts the norm. Normalisation happens
      on write at `indexer.ts:237-243`, not per query)*
- [ ] Semantic test passes: query "memory management" ranks a fixture whose text
      is "paging and TLB" in the top 10.  **NOT MET.** `grep -rn "@integration" test/`
      returns nothing. The trap pairs exist in `test/fixtures/generate.mjs:69-73` and
      the ground truth is written into the generated manifest, but no test reads
      them. It could not pass with the current fake either: `hashVector`
      (`test/fakes/fakes.ts:226`) seeds a PRNG from an FNV-1a hash of the whole
      string, so the two texts are uncorrelated by construction. Needs a real
      embedder — the other box. Architecture §8.6.
- [x] "last month" returns only files inside the resolved range  *(`service.test.ts:61-86`:
      in-range and out-of-range files seeded with identical vectors; only the
      in-range one is returned. `timeparse.ts:56-65` resolves it to the previous
      **calendar** month, deliberately not "last 30 days")*
- [x] Time filter is pushed into the WHERE clause — asserted by inspecting the SQL
      passed to the store, not by checking results only  *(`vectorstore.ts:56-67`
      carries the range in the WHERE clause; `service.test.ts:41-59` asserts the
      store received the identical range object; `integration.test.ts:204-234`
      asserts it against real SQLite and via `scanCount`. `fakes.test.ts:131-152`
      covers filter-before-limit with a deliberately-too-small limit)*
- [x] The range label rendered in the UI equals the range applied to the query  *(`server.test.ts:76-86`
      asserts `appliedRange` over HTTP, comparing as instants rather than ISO
      strings. `web/src/App.tsx:329-347` renders `appliedRange.label` — the same
      object the store received, echoed at `service.ts:102`)*
- [ ] Hybrid ranking beats vector-only on a fixture set where an exact keyword
      match should outrank a fuzzy semantic match.  **NOT MET — no such test
      exists.** `grep -rni "hybrid\|vector-only" test/` returns nothing. RRF itself
      is implemented (`rank.ts:25-60`) and its arithmetic is exercised indirectly,
      but the comparative claim itself is unasserted. Note also that the keyword leg
      is not confined to the semantic candidates (architecture §8.10), so this
      condition needs a decision about that before it can be tested honestly.
- [x] Search over the 1000-image fixture set returns in under 200 ms (p95)  *(measured
      2026-10-10 over 817 indexed vectors, dim 64: p50 1.96 ms / p95 5.11 ms
      all-time, p50 2.26 ms / p95 4.42 ms on a 30-day range. That is the store query
      only — it excludes query embedding, HTTP and fusion, none of which run in the
      benchmark. The ~40x margin means the condition holds, but the number is
      narrower than the headline suggests)*
- [x] No network call during a full index + search cycle (network stubbed to throw)  *(`test/index/offline.test.ts`
      `vi.mock`s `node:http`/`https`/`net`/`tls`/`dns` with throwing stubs, first
      asserts the stubs are actually installed, then runs index+search and asserts
      zero attempts. This is GOAL.md DoD item 1)*

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

- [x] High-OCR image (dense text fixture) → vision interface NOT called (spy)  *(`route.test.ts:34-40`
      and `integration.test.ts:323-325`: dense confident text → `decideVision` false.
      Honest caveat: the spy is on the **decision function**, not on a
      `VisionDescriber`. No vision adapter is constructed outside tests, so
      "not called" holds partly because it could not have been — see the next box*
- [ ] Low-OCR image (diagram/whiteboard fixture) → vision interface IS called.  **NOT MET.**
      `decideVision` returns true for empty / low-confidence / short extractions
      (`route.test.ts:24-52`) and `FakeVisionDescriber` can be forced to be called
      (`fakes.test.ts:204-210`) — but **nothing in the indexing flow calls
      `decideVision`**. `Indexer` re-implements the thresholds inline at
      `indexer.ts:196` to set the `needs_vision` column, and then nothing reads
      that column. The decision is computed, stored, and ignored: there is no
      vision fallback path end to end. Architecture §8.4.
- [x] Vision captions weighted differently from OCR text at rank time (asserted)  *(`fakes.test.ts:162-179`:
      with `sourceWeights: { vision: 2 }` the vision-sourced hit outranks an
      identical-vector OCR hit. The weight is applied at `vectorstore.ts:72` and
      again at `rank.ts:46-50`. The mechanic works; **no real vision caption ever
      exists to be weighted**, so this asserts the mechanism, not the outcome)*
- [ ] At most one model resident at any point; a test asserts this.  **NOT MET.**
      `grep -rn "resident\|resource_budget" src/` finds only two comments admitting
      the absence. There is no residency manager, no budget counter, and the
      `resource_budget` error code is declared (`errors.ts:13`) and never
      constructed. The condition is currently vacuous rather than satisfied:
      nothing can be resident because nothing in `src/` can load a model. That is
      not the same as a test asserting the rule. Architecture §7.
- [x] `unload()` called twice does not throw  *(`fakes.test.ts:28-34`, and 21-27 for
      unload-before-load)*
- [x] Search works with the vision adapter entirely absent  *(`service.test.ts:143-152`:
      hits and scores are identical with and without a summarizer. For vision the
      guarantee is stronger — vision is not in the query path at all (architecture
      §6), so its absence cannot affect retrieval. Trivially true, and honestly so)*

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

- [x] 1000-image fixture benchmark reports index time, p50/p95 search latency, peak RSS  *(`benchmark.mjs`,
      run 2026-10-10: 817 indexed / 185 dropped, 13615 ms (13.62 ms/file), p50 1.96
      / p95 5.11 ms, peak RSS 90 MiB. Fakes only — zero inference in these numbers,
      and the script says so on its own output)*
- [ ] Keyboard shortcuts work and are documented.  **PARTIALLY MET, not ticked.**
      `web/src/App.tsx` implements `/` to focus search (243-258), `esc` to clear the
      input (308-317), `esc` to close the detail dialog (269-277) and `enter` to
      open a result (123-129). **No j/k navigation** — `grep -rn "'j'\|'k'\|ArrowDown"
      web/src/` returns nothing — so P5's j/k/enter/esc is not delivered, and no
      runbook documents what exists (the runbook is still a stub).
- [ ] A user can go from cold start to a working search in one command.  **NOT MET.**
      `package.json` maps `dev` → `tsx watch src/index/server.ts`, and `server.ts`
      has no top-level `listen()` — it only exports `createApp`/`startServer`.
      Run here: `npm run dev` starts a watcher, prints nothing and serves nothing.
      The entrypoint that works is `src/index/dev.ts`, and no script references it.
      Verified out of band: `npx tsx src/index/dev.ts` serves on `127.0.0.1:5174`,
      `/api/health` returns ok, and `/api/search?q=paging last month` returns
      label "1 Sept – 30 Sept". Architecture §8.1.

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