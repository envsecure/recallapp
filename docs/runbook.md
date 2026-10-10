# Runbook

<!-- DOC:status=current -->
<!-- code-hash: c16af5ae11a956ebfd1e6c6598019edc0b5ccc0fcee155e678e1326276b17dff -->

> Every command in §1, §2, §4 and §5 was executed on the machine named in the
> heading, and the output shown is what it actually produced. Where a step has
> **not** been run, it says so plainly rather than guessing. See `../AGENT.md` §
> "Documentation policy" for why that distinction matters here.

## What this document covers

Two boxes:

- **The dev box** (§2) — CPU-only, 2.7 GB RAM, 3.2 GB free disk, no GPU. This is
  where Recall was built. Everything in §2 was run here.
- **A real laptop** (§3) — the machine that can actually hold model weights and
  run inference. **No step in §3 has been executed.** It is a checklist to run,
  not a record of what happened. Treat it as untested until you have run it and
  replaced that section with what actually occurred.

§1 is prerequisites, §4 the day-to-day loop, §5 troubleshooting built only from
failures that actually happened, §6 what does not work.

---

## 1. Prerequisites — VERIFIED

Machine: Linux 6.14.0-29-generic, x86-64, 4 cores, 2.7 GB RAM, no GPU.
Repo: `~/Desktop/recallapp`.

| Requirement | Version | How it was established |
|-------------|---------|------------------------|
| Node.js | ≥ 20.11 declared; **26.7.0 actually used** | `node --version` |
| npm | 11.19.0 | `npm --version` |
| Disk | ~70 MB for `node_modules` | `du -sh node_modules` → 69M |
| RAM | 2.7 GB is enough *for the fake path* | measured peak 75–93 MiB |
| GPU | none needed, none used | — |

**No native build step.** This is deliberate. `node:sqlite` is built into Node
since 22.5, and the PNG fixture generator is hand-rolled, so there is no
`node-gyp`, no compiler, and no platform-specific binary to go wrong. Adding an
image encoder later will break this property — see §6.

**Not required:** Docker, Redis, a vector database server, a Python environment.
All deliberately excluded (`../GOAL.md` N12, N13).

---

## 2. Dev box setup — VERIFIED

### 2.1 Install

```bash
cd ~/Desktop/recallapp
npm install
```

Verified. Installs 69 MB: `express` plus five dev dependencies. No postinstall
script downloads anything.

`npm` prints a benign `npm warn install-scripts` about esbuild's skipped
postinstall. **That warning is harmless and the suite passes anyway** — verified:
`npx esbuild --version` → 0.28.2, 134 tests green.

### 2.2 Verify the install

```bash
npm run typecheck     # exits 0
npm test              # 134 tests, 11 files, all passing
```

Verified. Both are required before anything else. If `typecheck` fails, stop —
every later step assumes a clean build.

### 2.3 Generate image fixtures

```bash
npm run fixtures
```

Verified output:

```
wrote 27 files to .../test/fixtures/generated
manifest: .../test/fixtures/generated/manifest.json
```

Writes 24 topic images (~41 KB each) plus three deliberately bad ones:
`noise-solid.png` (uniform colour but above the size floor), `noise-too-small.bin`
(64 bytes), and `noise-duplicate.png` (byte-identical to `0000-paging-tlb.png`).
Total ~1.2 MB. Regenerating wipes the directory first, so it is idempotent.

`manifest.json` carries ground-truth text and a timestamp per fixture. The
indexer reads it, so the pipeline is exercised against known answers rather than
against whatever OCR invents.

### 2.4 Index a folder

```bash
export RECALL_DATA_DIR=/tmp/recall-data
npm run index -- --folder test/fixtures/generated --fake --reset
```

Verified output:

```
reset: cleared files, chunks, vectors, fts
done in 370ms
  indexed: 25
  skipped (already done): 0
  dropped (noise): 1
  failed: 0
  vectors in store: 25
```

**`--fake` is mandatory.** Without it the command refuses and exits 2:

```
This build has no runnable model adapters (GOAL.md C2 — the dev box cannot download weights).
Run with --fake to exercise the pipeline against deterministic fakes.
```

Verified. The refusal is deliberate: nothing here should be mistaken for a real
index.

Reading the counters: 27 files in, 25 indexed, 1 dropped as noise. The `.bin`
file is not counted because it is not an image extension. The duplicate is
dropped by content hash.

**Resumability** — run the identical command again and it does nothing:

```
done in 3ms
  indexed: 0
  skipped (already done): 25
```

Verified. 3 ms versus 370 ms. Files already marked `done` by content hash are
skipped, so an interrupted run resumes rather than restarting.

### 2.5 Serve the API

```bash
export RECALL_DATA_DIR=/tmp/recall-data
npm run serve
```

Verified output:

```
indexed chunks: 25
db: /tmp/recall-data/index.db
recall listening on http://127.0.0.1:5174
```

Then, from another shell:

```bash
curl -s http://127.0.0.1:5174/api/health
# {"ok":true,"indexFolder":null}

curl -s "http://127.0.0.1:5174/api/search?q=paging"
# 25 hits; top result 0000-paging-tlb.png

curl -s "http://127.0.0.1:5174/api/search?q=paging%20last%20month"
# appliedRange: 1 Sept – 30 Sept   ← the resolved range is echoed back
```

The server binds `127.0.0.1` only. There is no `HOST` environment variable, and
adding one would break the project's central guarantee (`../GOAL.md` C1).

### 2.6 Run the UI

```bash
cd ~/Desktop/recallapp/web
npm install
npm run dev          # http://127.0.0.1:5173
```

The Vite dev server proxies `/api` to `127.0.0.1:5174`, so start `npm run serve`
first (§2.5). Verified: both start, the proxy returns 200, and searching shows
the resolved-range chip (`all time`, or `1 Sept – 30 Sept` for a dated query)
beside a grid of ranked results with Strong/Good/Weak badges.

Keyboard: `/` focuses search, `Enter` submits, `Escape` clears. `j`/`k` card
navigation is **not** implemented (§6).

### 2.7 Benchmark

```bash
npm run benchmark -- --count 1000
```

Verified at `--count 1000`:

| Metric | Value |
|--------|-------|
| files in / indexed | 1000 / 817 |
| index wall time | 13,110 ms (~13.1 ms/file) |
| search p50 / p95, all-time | 2.27 ms / 4.84 ms |
| search p50 / p95, 30-day | 2.22 ms / 5.12 ms |
| peak RSS | 93 MiB |

**Read these numbers correctly.** They measure the pipeline's own cost with
fakes and **no inference at all**. Real per-image cost is dominated by OCR and
VLM inference, which this box cannot run — see §6.

The 183 dropped files are not a bug: they are the deliberately bad fixtures
(solid, too small, duplicate) scaled across the run.

### 2.8 Documentation audit

```bash
npm run docs:audit
```

Verified. Exits 0 when docs match the code, 1 when stale. Each description doc
embeds a hash of `src/`; change the code and the doc is flagged by evidence
rather than opinion. Use `--write` **only after reading the code** — it marks a
doc current, it does not verify it.

---

## 3. Real laptop — NOT YET RUN

> **Nothing in this section has been executed.** It is the plan for a machine
> that can hold model weights. Every command is a proposal until you have run
> it and replaced this section with what actually happened.

Estimated prerequisites: 8 GB+ RAM and 5 GB free disk, plus a GPU if you want
vision in seconds rather than minutes.

### 3.1 Bring up the baseline

Steps 2.1–2.6 should work unchanged. Verify with `npm test` — **134 passing
confirms only the fake path**. It says nothing about model quality.

### 3.2 Provision models

Models are never downloaded automatically (`../GOAL.md` C1/C2). The directory
contract lives in `src/index/adapters.ts`:

```
<RECALL_DATA_DIR>/models/<model-name>/
```

| Role | Directory name | Size (ESTIMATE) | Source |
|------|----------------|-----------------|--------|
| OCR | `tessdata-eng` | ~15 MB | tesseract.js language data |
| Embeddings | `bge-small-en-v1.5` | ~130 MB | HuggingFace, ONNX |
| Vision | `florence2-base` | ~500 MB–1 GB | HuggingFace, ONNX |

**These sizes are estimates from model cards, not measurements.** Replace them
with `du -sh` output once the files are actually in place.

`resolveModelPath` throws `capability_unavailable` naming the exact expected
path when a model is missing, so the first run tells you what it wants.

### 3.3 Replace the fakes with real adapters

`src/index/cli.ts` and `src/index/dev.ts` construct `FakeTextExtractor` /
`FakeEmbedder` from `src/index/fakeModels.ts`. Swap them for the classes in
`src/index/adapters.ts`:

- `TesseractExtractor(modelDir, 'eng')`
- `TransformersEmbedder(modelDir)` — 384 dimensions, not the fakes' 64
- `TransformersVision(modelDir)`

**Dimension mismatch is the trap.** Fakes emit 64-dim vectors; bge-small emits
384. Existing rows in `vectors.dim` will not match. Re-index with `--reset`
after switching.

### 3.4 First real index — expectations

On a CPU-only laptop, budget ~1–3 s per image for OCR, plus ~1–3 s more for the
low-OCR subset that goes to vision. For 1000 screenshots, expect **20–50 minutes
for the first pass** and single-digit minutes after. The first pass is slow
because OCR runs on everything and vision on roughly 15% of it
(`../GOAL.md` C6).

These are estimates, not measurements. Record your actual timings here.

### 3.5 Verify what the dev box could not

- [ ] Does `bge-small` retrieve "memory management" for a slide that says
      "paging and TLB"? `../IMPLEMENTATION.md` P2 leaves this unticked and says
      why: the fake embedder hashes whole strings and cannot express semantic
      similarity.
- [ ] Does OCR confidence fall below 0.35 on diagrams and handwriting often
      enough to justify the vision pass?
- [ ] Does Florence-2 load through `transformers.js` at all? **Highest-risk item
      in the project** (`../IMPLEMENTATION.md` Appendix B). If it fails, drop in
      `SmolVLM-256M` or an Ollama-side `moondream`; nothing outside the
      `VisionDescriber` interface should need to change.
- [ ] Peak RSS during a real index — does the one-model-resident rule hold?

---

## 4. Day-to-day

```bash
# index a folder of screenshots (dev box: fakes only)
npm run index -- --folder ~/Pictures/Screenshots --fake --reset

# serve the API
npm run serve

# then browse, after `cd web && npm run dev`
# http://127.0.0.1:5173

# before committing
npm run typecheck && npm test && npm run docs:audit
```

`RECALL_DATA_DIR` defaults to `~/.localrecall`. Set it to isolate runs, as every
command above does, when you want a scratch index.

---

## 5. Troubleshooting

Only failures that actually occurred, with their real text.

**`tsx` reports `Top-level await is currently not supported with the "cjs" output format`**
Running a `.ts` entry through a path Node treats as CommonJS. Fix: run it via
`npm run <script>`, which goes through `tsx`.

**`Error: Failed to load url sqlite (resolved id: sqlite)`**
Vite strips the `node:` prefix and then tries to resolve a bare `sqlite` package,
which does not exist. Config-level `external` options did not fix it. The working
fix is in `src/db/sqlite.ts`: load `node:sqlite` through `createRequire` so the
specifier never enters the bundler's module graph. **Do not "fix" this by
switching back to a static import** — it breaks the suite again.

**Every file indexed as 0 rows**
Almost always the noise filter, not a bug. Check the `dropped (noise)` counter. A
file below 2 KB, or one whose first 4 KB contain fewer than three distinct byte
values, is discarded by design. If your *real* screenshots are being dropped,
they are unusually small or unusually uniform.

**`Cannot read properties of undefined (reading 'meta')`**
Fixed, recorded because it is instructive: a duck-typed optional method was
extracted off an instance and called unbound, so `this` was `undefined` inside
it. If you add optional methods to a capability, bind them before returning
them.

**`fake-ocr: extract called before load()`**
The `Indexer` does not own model lifecycle — the caller does. Anything
constructing a `TextExtractor` or `Embedder` must `await load()` it first, and
the fake asserts this deliberately.

**All fixtures dropped as noise**
`test/fixtures/generate.mjs` originally emitted 32×24 PNGs (~1.3 KB), below the
2 KB floor, so every fixture was correctly rejected. They are now 480×270
(~41 KB). Shrink them again and the filter will reject them again.

**Benchmark shows the same latency for both date ranges**
Expected at small `--count`. The time filter only shows up once the corpus is
large enough for the candidate set to actually differ.

**`npm run dev` at the repo root does nothing**
It used to point at `src/index/server.ts`, which exports functions but starts
nothing. It was replaced by `npm run serve` (§2.5) and `npm run benchmark`
(§2.7). If you are reaching for a root `dev` script, it no longer exists.

---

## 6. What does not work

Honest list, current as of the last commit.

- **No model has ever been executed in this repo.** Every number comes from
  deterministic fakes. Real OCR accuracy, embedding quality, VLM captions and
  LLM answers are all unverified (`../IMPLEMENTATION.md` Appendix C).
- **The thumbnail encoder is a stub.** `src/index/thumbs.ts` writes a valid 1×1
  WebP instead of a downscaled image, because no image encoder can be installed
  here. The content-hash cache, atomic writes and read-only source handling
  around it are real and final. Swapping in `sharp` means replacing one function.
- **Thumbnails are not generated during indexing.** The service and the `/thumb`
  route exist and are tested; nothing calls them yet, so the UI shows
  placeholders.
- **No file-removal reconciliation.** Deleting a screenshot leaves its rows in
  the database until you re-index with `--reset`. `../IMPLEMENTATION.md` P1
  leaves this unticked.
- **The vision decision is computed but not acted on.** `decideVision()` correctly
  flags low-OCR images, but nothing in the indexing flow routes to a vision pass
  yet. P3 leaves that box unticked.
- **No model-residency manager.** `../GOAL.md` C4 asks for at most one resident
  model; nothing enforces it, so with real models on a 2.7 GB box this would
  OOM. C4 is currently aspirational — `architecture.md` §7 says so.
- **P4 (written answer synthesis) is not built.** No `Summarizer` implementation
  exists in `src/` at all. Retrieval works without it.
- **Keyboard shortcuts are partial.** `/`, `Escape` and `Enter` work; `j`/`k`
  navigation does not.
- **`npm run index` requires `--fake` on this machine.** No code path runs real
  inference here, by design.

---

## Completion criteria — met

- [x] Every command in §1, §2, §4, §5 executed successfully on the machine it
      claims, and that machine is named
- [ ] ~~Model disk costs are measured~~ — **deliberately not met.** §3 has not
      been run on a laptop, so those sizes are labelled ESTIMATE. Claiming
      otherwise would be the exact failure this document exists to avoid.
- [x] Troubleshooting contains only errors that actually occurred
- [x] The limitations section is not empty
- [x] The `STUB` marker has been removed

One criterion is deliberately left unticked. A runbook that ticks every box by
guessing is worse than a stub, and the one thing this document must not do is
claim a measurement nobody took.