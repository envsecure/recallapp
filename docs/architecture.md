# Architecture

<!-- DOC:status=current -->
<!-- code-hash: c16af5ae11a956ebfd1e6c6598019edc0b5ccc0fcee155e678e1326276b17dff -->

> **This document describes what exists.** Every claim below cites a file under
> `src/` or a file under `test/`. Where the code disagrees with
> `../IMPLEMENTATION.md`, §8 says so.
>
> Written by reading the code at fingerprint `ee5e9c0323daf804…` (22 files in
> `src/`, commit `8607a00`). `npm run docs:audit` records that fingerprint and
> fails once `src/` moves without this file being re-read.

---

## 1. System overview

One Node process. One Express server bound to loopback. One SQLite file. No
daemon, no worker pool, no separate vector service (`GOAL.md` C1, C5).

```
  ┌──────────────────────── one process, port 5174 ─────────────────────────┐
  │                                                                          │
  │  HTTP  (src/index/server.ts)                                            │
  │    GET /api/health      → { ok, indexFolder }                            │
  │    GET /api/search      → SearchService.search()                         │
  │    GET /thumb/:name     → file from <dataDir>/thumbs, name must match    │
  │                            /^[a-f0-9]+\.webp$/                            │
  │    ALL  /api/*           → JSON 404 (never express' HTML default)        │
  │           │                                                              │
  │           ▼                                                              │
  │  SearchService (src/search/service.ts)                                  │
  │    parseTimeExpression → embedder → VectorStore.query(range) →           │
  │    KeywordIndex.search → fuseRank → optional Summarizer                  │
  │           │                                                              │
  │           ▼                                                              │
  │  SqliteVectorStore (src/db/vectorstore.ts)   ── WHERE mtime range        │
  │  SqliteKeywordIndex (src/db/keyword.ts)      ── FTS5 MATCH              │
  │           │                                                              │
  │           ▼                                                              │
  │  node:sqlite  →  <dataDir>/index.db   (one file, C5)                    │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  Indexing is a SEPARATE process, not a background task:
      npm run index -- --folder <path> --fake [--reset]
      → src/index/cli.ts → Indexer (src/index/indexer.ts) → same .db
```

Data directory defaults to `$RECALL_DATA_DIR` or `$HOME/.localrecall`
(`src/config.ts:32`). Inside it: `index.db`, `thumbs/`, `models/`
(`src/config.ts:40-44`). `models/` exists as a path contract only — nothing in
this repo has ever written to it.

**Two entrypoints exist and one of them is not reachable from npm.**
`src/index/dev.ts` wires the real SQLite stores to `SearchService` and listens —
verified running, see §8.1. `package.json` has no script for it. The `dev`
script runs `tsx watch src/index/server.ts`, and `server.ts` has no top-level
`listen()` — it only exports `createApp` and `startServer`. So `npm run dev`
starts a watcher over a module that does nothing.

---

## 2. Module map

22 files, 2621 lines under `src/`.

| Module | Owns | Called by |
| --- | --- | --- |
| `src/errors.ts` | `AppError` + 7 `ErrorCode`s, `isAppError`, `errorMessage` | everything |
| `src/config.ts` | `HOST` (hardcoded), `DEFAULT_PORT`, `makeConfig`, `DataPaths` | `server.ts`, `cli.ts`, `dev.ts`, `sqlite.ts` consumers |
| `src/interfaces/capabilities.ts` | all 7 capability interfaces + `TimeRange`, `SearchHit`, `RetrievedItem`, branded `FileId`/`ChunkId` | every consumer |
| `src/db/sqlite.ts` | `openDb`, `migrate` (schema), `getState`, `setState`, `runSafe` | `vectorstore.ts`, `keyword.ts`, `indexer.ts`, `cli.ts`, `dev.ts` |
| `src/db/vectorstore.ts` | `SqliteVectorStore` — the WHERE-clause time filter, brute-force scan | `service.ts` |
| `src/db/keyword.ts` | `SqliteKeywordIndex`, `sanitize()` | `service.ts`, `indexer.ts` |
| `src/search/vector.ts` | `l2Normalise`, `norm`, `dot`, `toBlob`, `fromBlob` | `vectorstore.ts`, `indexer.ts`, fakes |
| `src/search/timeparse.ts` | `parseTimeExpression`, 8 time patterns | `service.ts` |
| `src/search/rank.ts` | `fuseRank` (RRF, k=60), snippet builder | `service.ts` |
| `src/search/service.ts` | `SearchService` — the orchestration | `server.ts` |
| `src/index/scan.ts` | `scanFolder` — recursive, deterministic, never throws | `indexer.ts` |
| `src/index/filter.ts` | `NoiseFilter`, `isTooSmall`, `looksSolid`, `contentHash`, `perceptualHash`, `hammingDistance` | `scan.ts`, `indexer.ts`, `cluster.ts` |
| `src/index/chunk.ts` | `chunkText`, `chunkSlides` (pure, no I/O) | `indexer.ts` |
| `src/index/indexer.ts` | `Indexer` — the resumable per-file pipeline | `cli.ts`, tests |
| `src/index/route.ts` | `decideVision`, `VISION_CONFIDENCE_THRESHOLD`, `VISION_MIN_CHARS` | tests only — see §8.4 |
| `src/index/cluster.ts` | `clusterFrames` / `clusterSlides` | tests only — see §8.7 |
| `src/index/thumbs.ts` | `ThumbnailService`, `thumbCacheKey`, `thumbDimensions`, **stub encoder** | `/thumb` route serves from disk; nothing generates |
| `src/index/adapters.ts` | `TesseractExtractor`, `TransformersVision`, `TransformersEmbedder`, `resolveModelPath`, `availableModels` | nothing — see §3 |
| `src/index/fakeModels.ts` | minimal `FakeTextExtractor`, `FakeEmbedder` for `src/` entrypoints | `cli.ts`, `dev.ts` |
| `src/index/cli.ts` | index CLI; requires `--fake` or exits 2 | npm `index` |
| `src/index/dev.ts` | serve entrypoint — **no npm script** | manual |
| `src/index/server.ts` | `createApp`, `startServer` | `dev.ts`, `server.test.ts` |

### The seams that are ugly, stated plainly

- **`src/index/indexer.ts` duck-types two methods.** `asRegisterFile` and
  `asKeywordRegister` (lines 77-102) probe the store and the keyword index for
  optional `registerFile` / `register` methods and bind them. Neither is on the
  `VectorStore` or `KeywordIndex` interface. Without the `.bind(store)` the
  method loses `this` and `registerFile` throws — that bug was fixed in commit
  `641d32b`. The interfaces do not describe what the indexer actually needs.
- **`src/index/dev.ts` and `src/index/cli.ts` do not share an indexing path.**
  `cli.ts` re-implements indexing inline (its own `INSERT INTO files`, its own
  chunk write) rather than calling `Indexer`. They are two different programs
  that happen to write the same tables.
- **`src/search/service.ts` used to look items up by the wrong key — FIXED.**
  It called `this.deps.items.get(h.fileId)` where `items` is keyed by
  **chunkId**, so the summariser silently received an empty context on the real
  wiring. No test caught it because nothing asserted on the context handed to
  the summariser. Fixed to key off `vectorHits` and covered by
  `service.test.ts` ("the summarizer receives the retrieved context, not an
  empty array"), which fails against the old code. Recorded here because a
  reader diffing the doc against git should know the defect existed.
- **`src/search/service.ts` is the only module in `src/` still using a
  TypeScript parameter property** (`constructor(private readonly deps: ...)`,
  line 61). Every other class assigns in the body. See §8.5.

---

## 3. The interfaces — what is real and what is a fake

**This is the section that matters. Nothing in this project has ever executed
real model inference, on this machine or on any machine in its history.**

`src/interfaces/capabilities.ts` declares 7 capabilities. Here is what
implements each one today:

| Capability | Declared at | Real implementation | Fake(s) | Has real inference ever run? |
| --- | --- | --- | --- | --- |
| `TextExtractor` | `capabilities.ts:50` | `adapters.ts:52` `TesseractExtractor` | `fakeModels.ts:55`; `test/fakes/fakes.ts:111` | **No.** Every method throws. |
| `VisionDescriber` | `capabilities.ts:63` | `adapters.ts:90` `TransformersVision` | `test/fakes/fakes.ts:153` | **No.** Every method throws. |
| `Embedder` | `capabilities.ts:74` | `adapters.ts:120` `TransformersEmbedder` | `fakeModels.ts:85`; `test/fakes/fakes.ts:187` | **No.** Every method throws. |
| `Summarizer` | `capabilities.ts:91` | **none at all** | `test/fakes/fakes.ts:392` | **No.** No implementation exists in `src/`. |
| `VectorStore` | `capabilities.ts:142` | `db/vectorstore.ts:33` — **real SQLite** | `test/fakes/fakes.ts:269` | n/a — not a model. |
| `KeywordIndex` | `capabilities.ts:174` | `db/keyword.ts:13` — **real FTS5** | `test/fakes/fakes.ts:352` | n/a |
| `Thumbnailer` | `capabilities.ts:186` | `index/thumbs.ts:72` — real cache, **stub encoder** | `test/fakes/fakes.ts:416` | **No.** Writes a 1×1 WebP. |

### What "real" means for the three model adapters

`TesseractExtractor`, `TransformersVision` and `TransformersEmbedder` satisfy
their interfaces and **every capability method throws
`AppError('capability_unavailable')`** (`adapters.ts:66-79, 98-112, 127-145`).
Their `load()` calls `resolveModelPath` first, which throws if
`<modelDir>/<name>` is absent — and then throws unconditionally anyway, even
when the directory exists. The file header says so: "none of these are executed
on the dev box".

`resolveModelPath` (`adapters.ts:26`) is the only real offline guarantee in the
adapter layer: a weight appears only if a human copied it in. That part is real.
The inference above it is not.

### What is genuinely real and exercised

- SQLite schema, WAL, foreign keys — `db/sqlite.ts`
- FTS5 keyword index with a porter/unicode61 tokenizer — `db/keyword.ts`
- The time-range `WHERE` clause — `db/vectorstore.ts:56-67`
- L2 normalisation on write, asserted in the blob — `indexer.ts:241`,
  `integration.test.ts:137-147`
- RRF fusion — `search/rank.ts`
- The full HTTP surface, including the `/thumb/:name` traversal guard —
  `index/server.ts:55-68`
- Index → search round trip against a real `.db` — `test/index/offline.test.ts`,
  `test/index/integration.test.ts`

### What the fakes actually are

`FakeEmbedder` maps text to a **64-dim unit vector via a seeded PRNG keyed by an
FNV-1a hash of the string** (`test/fakes/fakes.ts:226`). Two texts sharing a
word do *not* land near each other — `hashVector` seeds from the whole string,
so similarity is effectively arbitrary. `fakeModels.ts:97` is the same
construction. This is why `IMPLEMENTATION.md` P2's semantic DONE condition is
unticked (§8.6): a hash embedder cannot demonstrate that "memory management"
finds "paging and TLB", and no test tries.

---

## 4. Data model and access paths

### 4.1 Schema — quoted from `src/db/sqlite.ts:52-106`

```sql
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  mtime_ms    INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  phash       TEXT,
  kind        TEXT NOT NULL DEFAULT 'image',
  thumb_path  TEXT,
  ocr_confidence REAL,
  ocr_chars    INTEGER,
  needs_vision INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  indexed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime_ms);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,
  file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  text       TEXT NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  ord        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

CREATE TABLE IF NOT EXISTS vectors (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  text,
  chunk_id UNINDEXED,
  file_id  UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS index_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Migrations are `CREATE ... IF NOT EXISTS` only. There is no version table and
no `ALTER` path — a column added later to an existing `index.db` is **not
migrated**; `--reset` is the only escape. `getState`/`setState`/`runSafe`
(`sqlite.ts:109-129`) are exported but no caller in `src/` uses them
(§8.7).

`openDb` (`sqlite.ts:34-42`) sets `PRAGMA journal_mode = WAL` and
`PRAGMA foreign_keys = ON` per connection. Foreign keys are what make
`integration.test.ts:236-243` (delete a `files` row, vectors vanish) pass.

### 4.2 The time filter lives in the WHERE clause — `src/db/vectorstore.ts:56-67`

```sql
SELECT v.chunk_id AS chunk_id,
       c.file_id  AS file_id,
       v.vec      AS vec,
       c.source   AS source
FROM vectors v
JOIN chunks c ON c.id = v.chunk_id
JOIN files  f ON f.id = c.file_id
WHERE f.mtime_ms >= ? AND f.mtime_ms < ?
```

Bound with `range.from.getTime()` and `range.to.getTime()` (line 67). Ranking
happens after, in JS:

```ts
score: dot(vector, fromBlob(r.vec)) * (weights[r.source] ?? 1)
```

`SqliteVectorStore.scanCount` (`vectorstore.ts:93-104`) issues the same join
with `COUNT(*)`; `integration.test.ts:227-234` asserts it narrows.

**There is no ANN index.** Every candidate in range is read out of SQLite,
copied into a fresh `Float32Array` by `fromBlob` (`search/vector.ts:41-46`,
which copies because the Blob may be a view into a larger buffer), and scored
one dot product at a time. `src/db/sqlite.ts:9-12` documents the intent: fine at
thousands of chunks, revisit at 10⁶.

### 4.3 Keyword search — `src/db/keyword.ts:41-48`

```sql
SELECT chunk_id, bm25(fts) AS score
FROM fts WHERE fts MATCH ?
ORDER BY score ASC
LIMIT ?
```

`bm25` returns negative values, so the result is negated on the way out
(`keyword.ts:50`). `sanitize` (`keyword.ts:66-74`) keeps only
`[\p{L}\p{N}\s_-]`, splits on whitespace/underscore/hyphen, and wraps each term
in double quotes with internal quotes doubled — so `cache-miss` becomes
`"cache" "miss"`. Quoting also makes terms implicit-AND, which is asserted in
`integration.test.ts:263-267`.

`upsert` inserts `file_id` as the empty string (`keyword.ts:24`) and a
separate `register(id, fileId)` back-fills it via `UPDATE`. Without that second
call, `deleteByFile` cannot find the rows. `Indexer` calls it through the
duck-typed `asKeywordRegister` helper (§2).

### 4.4 Where normalisation happens

`Indexer` normalises on **write**, once per chunk, before handing vectors to the
store — `src/index/indexer.ts:237-243`:

```ts
const raw = await embedder.embed(texts[i] as string);
entries.push({ chunkId: ..., fileId, vector: l2Normalise(raw) });
```

`SqliteVectorStore.upsert` does no normalisation of its own. Storage is a raw
little-endian float32 BLOB (`toBlob`, `search/vector.ts:37-39`), never JSON.
Verified in the database by `integration.test.ts:137-147`, which reads the BLOB
back and asserts `‖v‖` within `1e-4` of 1.

### 4.5 The resume check — `src/index/indexer.ts:152-155`

```sql
SELECT id FROM files WHERE content_hash = ? AND status = ? LIMIT 1
```

bound with `(scanned.contentHash, 'done')`. Skipping keys on **content hash,
not path or mtime** — so a pure `touch` is a no-op by design (§8.3). A file is
inserted as `'pending'` before work starts (`indexer.ts:182-188`) and flipped
to `'done'` only after every row commits (`indexer.ts:251-254`); on failure it
is marked `'failed'` and its chunks/vectors/FTS rows are deleted
(`indexer.ts:256-279`).

---

## 5. Indexing flow

`src/index/cli.ts` (production-shaped path) and `src/index/indexer.ts`
(service-shaped path). **They are different code.** The sequence below is
`Indexer`; `cli.ts` does not call it.

```
scanFolder(root, {filter})                        src/index/scan.ts:48
  └─ readdirSync recursive; skip dotfiles + node_modules   scan.ts:42-46
  └─ per file: contentHash → looksSolid → filter.check     scan.ts:83-86
       calls filter.reset() first, or a re-index rejects
       its own output as duplicates                        scan.ts:51

NoiseFilter.check                                  src/index/filter.ts:147
  1. isTooSmall  — statSync().size < MIN_BYTES (2 KiB)    filter.ts:32-40
  2. looksSolid  — read ≤4096 B, skip first 32 (PNG sig),
                   ≤2 distinct bytes in the rest            filter.ts:49-74
  3. duplicate   — hash already in `knownHashes` (DB) or
                   in `seen` (this pass)                    filter.ts:159-162
  Content-based only. Never filename-based. (filter.ts:8-10)

for each surviving file — Indexer.indexFile         src/index/indexer.ts:147
  ├─ resume check: hash + status='done' → skip            indexer.ts:152
  ├─ same path, new content? delete old chunks/vectors/fts
  │  and the old files row, so path stays UNIQUE           indexer.ts:163-180
  ├─ INSERT files … status='pending'                       indexer.ts:182
  ├─ extractor.extract(path)                               ← MODEL CALL (fake)
  ├─ needs_vision = confidence < 0.35 || chars < 20        indexer.ts:196
  ├─ chunkText(ocrText)                                    index/chunk.ts:46
  ├─ DELETE chunks/vectors/fts for this file               indexer.ts:207-217
  ├─ per chunk: embed → l2Normalise → store.upsert         indexer.ts:236-244
  ├─ per chunk: keywordIndex.upsert + register             indexer.ts:245-248
  └─ UPDATE files SET status='done', indexed_at            indexer.ts:251
```

Per-file failures are caught and counted; the run continues
(`indexer.ts:133-137`). A failed file keeps a row with `status='failed'` so the
next run retries it (`integration.test.ts:178-181`).

**The vision-fallback branch is not in this flow.** `needs_vision` is written
to the column and nothing ever reads it. `decideVision` is never called by
`Indexer` — the thresholds are re-implemented inline at `indexer.ts:196`
(§8.4).

`Indexer` has no `Thumbnailer` in `IndexerDeps` (`indexer.ts:29-37`), so no
thumbnail is produced during indexing either (§8.5).

---

## 6. Query flow

```
GET /api/search?q=…&limit=…                     src/index/server.ts:32
  └─ empty q → AppError('invalid_input') → HTTP 400      server.ts:43-47
  └─ SearchService.search({q, limit})           src/search/service.ts:67
       ├─ parseTimeExpression(q, now())                   timeparse.ts:154
       │    8 patterns, first match wins, longest-first:
       │      last month | this month | last week | today | yesterday |
       │      last N days | last N weeks | in <month-name>
       │    no match → { from: epoch, to: now+1d, label:'all time' }
       │    `remainingQuery` = query minus the matched phrase
       ├─ range = req.range ?? parsed.range    (user override, F6)
       ├─ embed(parsed.remainingQuery)          ← time words stripped
       ├─ store.query(vector, { range, limit, sourceWeights? })
       │       └─ the WHERE clause above narrows candidates FIRST
       ├─ keywordIndex.search(q, chunkIds.length)   service.ts:89-91
       │    ⚠ the FULL query `q` including the time words, not
       │      remainingQuery; and the FTS search is NOT restricted to the
       │      vector candidate set — it queries the whole fts table.
       ├─ fuseRank({ vectorHits, keywordHits, items, files, limit })
       │       RRF, RRF_K = 60, 1/(60+rank+1) per list      rank.ts:23-38
       │       sourceWeights multiply the fused score       rank.ts:46-50
       └─ optional summarizer; errors swallowed            service.ts:106-115
  └─ res.json(response)  { hits, appliedRange, parsed, summary? }
```

Every stage that can be skipped when an adapter is missing:

| Missing | Behaviour | Evidence |
| --- | --- | --- |
| `Summarizer` | `summary` omitted; hits unchanged | `service.ts:106`; `service.test.ts:143-152` |
| Vision entirely | no effect — it is not in the query path | `IMPLEMENTATION.md` P3; nothing in §6 reads it |
| Keyword index returns [] | RRF falls back to the vector ordering | `rank.ts:29-38` |

`appliedRange` is echoed in every response (`service.ts:102`) and rendered by
`web/src/App.tsx:329-347`, so the label the user sees is the label the store
was given.

---

## 7. Resource lifetime

`GOAL.md` C4 requires at most one model resident. **Nothing enforces this.**

Every capability that owns memory exposes `load()`/`unload()`, and `unload()` is
idempotent — verified on the fakes at `test/fakes/fakes.test.ts:21-34`
(`unload()` before `load()` does not throw; `unload()` twice does not throw).
`FakeLifecycle` (`test/fakes/fakes.ts:67-100`) makes the ordering safe.

But there is no residency manager, no budget counter, and no `resource_budget`
throw anywhere in `src/`. `ErrorCode 'resource_budget'` is declared
(`errors.ts:13`) and never constructed. `grep -rn "resident" src/` returns two
comments admitting the absence (`adapters.ts:111, 148`: "no resident model to
release in this build").

Ownership is the caller's: `cli.ts` and `dev.ts` each `await` `load()` at
startup and never `unload()`. `Indexer` never calls `load()` or `unload()` on
anything — it is handed already-loaded capabilities, asserted by the fakes'
`assertLoaded` (`test/fakes/fakes.ts:95-99`). That is the correct direction
(AGENT.md: no module-level singletons), and it means C4 is currently vacuous:
no module in this repo can hold a model resident because no module can load one.

---

## 8. Known divergences from `../IMPLEMENTATION.md`

Required to be non-empty. Each entry cites both what the plan said and what the
code does.

### 8.1 The serve entrypoint has no npm script

Plan (P0): "Express app with `/api/health` and `/api/search`, binding
`127.0.0.1`" and P5: "a user can go from cold start to a working search in one
command". `package.json` maps `dev` → `tsx watch src/index/server.ts`, and
`server.ts` has no top-level `listen()` — it exports `createApp` and
`startServer`. Run on this box: `npm run dev` starts a watcher, prints nothing,
and serves nothing. `src/index/dev.ts` is the entrypoint that actually works,
and no script references it. Verified: `npx tsx src/index/dev.ts` prints
`recall listening on http://127.0.0.1:5174`, `/api/health` returns
`{"ok":true,"indexFolder":null}`, `/api/search?q=paging%20last%20month` returns
`appliedRange.label: "1 Sept – 30 Sept"` with `matched: "last month"`, and `ss`
shows `127.0.0.1:5174` only.

### 8.2 sqlite-vec was never added; the plan's C5 still names it

`GOAL.md` C5 reads "SQLite + sqlite-vec in one `.db`". The code uses
`node:sqlite` (`db/sqlite.ts:29-30`, loaded through `createRequire` because
Vite strips the `node:` prefix) and a brute-force JS scan. No `sqlite-vec`
dependency exists in `package.json`; `sqlite.ts:9-12` documents why. The plan's
reason was sound — no native build step on a box with no toolchain guarantee —
but the constraint text was never updated to match.

### 8.3 File deletion is never detected; "touch re-indexes" is unreachable

P1 DONE conditions include "Deleting a file removes its rows" and "Touching one
file re-indexes exactly one file". Neither is implemented. `scanFolder` only
walks files that exist; `Indexer` only ever inserts or updates. There is no
reconcile-removed-files pass, so a row for a deleted image survives forever and
keeps returning hits. And because the resume check keys on `content_hash`
(`indexer.ts:152-155`), a `touch` that changes mtime but not bytes is skipped —
correct for dedupe, but it is not the behaviour P1 specified and no test
asserts either.

### 8.4 The vision heuristic is duplicated instead of shared

`src/index/route.ts` owns the vision decision — `VISION_CONFIDENCE_THRESHOLD =
0.35`, `VISION_MIN_CHARS = 20`, and `decideVision()`. `Indexer` never calls it.
It re-implements the same two constants inline at `indexer.ts:196`
(`confidence < 0.35 || chars < 20`) to populate `needs_vision`. The two copies
can drift with nothing to catch it. `decideVision` is exercised only by
`test/index/route.test.ts` and `integration.test.ts:320-338`; nothing in the
indexing flow calls it, and no `VisionDescriber` is ever constructed outside
tests. **There is no vision fallback path end to end** — the decision is
computed and stored, and nothing acts on it.

### 8.5 Three planned subsystems exist as islands

- **Thumbnails.** `ThumbnailService` (`index/thumbs.ts`) is complete except for
  the encoder: `encodeThumbnail` (line 62) returns a hard-coded 1×1 WebP and the
  header says so. No caller constructs it — `grep -rn ThumbnailService src/`
  finds only its own definition. `Indexer` has no `Thumbnailer` dep. The
  `/thumb/:name` route serves from `thumbDir`, which nothing populates, so in
  practice every thumbnail request is a 404 and `web/src/App.tsx:142-145`
  falls back to the placeholder. The web UI shows placeholder thumbnails.
- **Clustering.** `clusterFrames` (`index/cluster.ts`) is pure, deterministic
  and fully tested (`integration.test.ts:340-400`), but no `src/` module calls
  it. F12 is not wired.
- **Chunking for slides.** `chunkSlides` (`index/chunk.ts:97`) is implemented
  and unused; `Indexer` calls plain `chunkText`.

### 8.6 P2's semantic DONE condition is unmet, and cannot be met with the current fake

P2 requires: query "memory management" ranks a fixture whose text is "paging and
TLB" in the top 10, **plus** a marked `@integration` test skipped by default.
`grep -rn "@integration" test/` returns nothing. `test/fixtures/generate.mjs:69-73`
does define the three trap pairs (`memory management` → `paging-tlb`, etc.) in
the generated manifest, so the ground truth exists — but no test reads it, and
the fake embedder could not pass it: `hashVector` seeds a PRNG from an FNV-1a
hash of the whole string, so "memory management" and "paging and TLB" are
uncorrelated by construction (§3). Leaving this unticked is the honest call; it
needs a real embedder, i.e. the other box.

### 8.7 Exported-but-unused API surface

`getState`, `setState`, `runSafe` (`db/sqlite.ts:109-129`), `index_state` (the
table itself is created and never written), `clusterFrames`, `chunkSlides`,
`SqliteVectorStore.scanCount`, `SearchService.filesFor`,
`adapters.availableModels` — all exported, all covered by tests, none called by
another `src/` module. Test-only API is normal; this is a fair amount of it, and
the `index_state` table in particular implies resumability machinery that
resumability does not actually use (it rides on `files.status` instead).

### 8.8 Fakes for `src/` entrypoints had to live in `src/`

`AGENT.md` forbids `src/` importing from `test/`. Until commit `8607a00`,
`cli.ts` and `dev.ts` imported `FakeEmbedder` from `@test/fakes/fakes`, which
is the layering violation. The fix added `src/index/fakeModels.ts` — a second,
deliberately thinner set of fakes living inside `src/`. There are now two fake
implementations of `TextExtractor` and two of `Embedder` in the repository. The
separation is documented and the `src/` copies carry no failure knobs, so the
richer fakes in `test/` are still the ones tests exercise.

### 8.9 TypeScript parameter properties

`src/db/vectorstore.ts`, `db/sqlite.ts`, `config.ts`, `indexer.ts`, `thumbs.ts`
all assign constructor fields in the body rather than using parameter
properties, which keeps the sources loadable by Node's type-stripping (which
`scripts/benchmark.mjs:93` relies on when it imports `src/db/vectorstore.ts`
directly). `src/search/service.ts:61` is the exception and still uses
`constructor(private readonly deps: SearchDeps, …)`. It is not imported by the
benchmark, so it works, but the codebase is inconsistent.

### 8.10 The keyword leg is not actually constrained to the semantic candidates

`service.ts:89-91` calls `keywordIndex.search(q, chunkIds.length)` — the raw
query (time words included) against the whole `fts` table, with a limit borrowed
from the vector hit count. `fuseRank` then adds RRF credit to whatever comes
back, including chunks the vector search rejected. This is not what the P2
description ("re-rank semantic hits", `db/keyword.ts:4-7`) describes, and it
means a keyword-only hit can enter the result set. Not currently tested either
way.

### 8.11 Smaller things, for completeness

- `SqliteKeywordIndex.upsert` stores `file_id` as `''` and relies on a separate
  `register()` call to back-fill it (`keyword.ts:20-33`). A caller that forgets
  `register` silently loses `deleteByFile`. `Indexer` goes through a duck-typed
  optional method to do it (§2).
- The noise filter reads up to 4096 bytes per file to decide solid-colour
  (`filter.ts:57`), then `perceptualHash` reads the **whole file** again
  (`filter.ts:97`). Two full reads per candidate file.
- `web/` is a separate npm project (`web/package.json`) not wired into the root
  `package.json`; the backend serves no static files, so the built bundle in
  `web/dist/` is served by `vite preview` or nothing.
- `test/index/offline.test.ts` poisons `node:http`/`https`/`net`/`tls`/`dns`
  with `vi.mock` and asserts zero outbound calls across a full index+search
  cycle — a real C1 test (`GOAL.md` DoD item 1).

---

## 9. Verified numbers

Measured on this box, Node v26.7.0, against fakes only. **No inference is
included in any figure.**

`npx tsx scripts/benchmark.mjs --count 1000`, run during this review:

| Metric | Value |
| --- | --- |
| Fixtures written | 1002 files (1000 + 3 deliberate noise fixtures) |
| Indexed | 817 |
| Dropped by the noise filter | 185 |
| Failed | 0 |
| Vectors in store | 817, dim 64 |
| Index wall time | 13615 ms (13.62 ms/file) |
| Search p50 / p95, all-time | 1.96 ms / 5.11 ms |
| Search p50 / p95, 30-day range | 2.26 ms / 4.42 ms |
| Peak RSS | 90 MiB overall (65 MiB after index) |

`npx vitest run`: **134 tests, 11 files, all passing.** `npx tsc --noEmit`: exit
0.

The index rate is pipeline overhead only — hash, chunk, embed-hash, SQLite
insert. The dominant real cost is OCR inference, which cannot be measured here
(`IMPLEMENTATION.md` Appendix C).

---

## 10. What a reader should not conclude

- That any OCR, embedding, or vision output in this repository is real. It is
  not. See §3.
- That search is semantic. The ranking path is wired and correct; the embedder
  behind it produces hash noise.
- That a deleted image disappears from results. It does not. See §8.3.
- That `npm run dev` starts the app. It does not. See §8.1.
- That a thumbnail renders. The encoder is a 1×1 placeholder and nothing
  populates the cache. See §8.5.