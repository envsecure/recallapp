# Runbook

<!-- DOC:status=current -->
<!-- code-hash: 44dad1b84d59daf63300a653438de25dee708ae65329d2fcf2fb57b35a2eb06d -->

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
| Node.js | **≥ 22.5** required; 26.7.0 used here | `node --version`, or `./scripts/install-node.sh --check` |
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

### If Node is missing or too old

`./setup.sh` installs it for you. Standalone:

```bash
./scripts/install-node.sh            # pick the best method
./scripts/install-node.sh --check    # report only, change nothing
./scripts/install-node.sh --method nvm | nodesource | apt
```

Methods are tried safest-first: **nvm** (no sudo, per-user), then the
**NodeSource** apt repository (system-wide, needs sudo), then distribution
packages **only if they are new enough**.

The apt method is deliberately gated. Ubuntu 24.04 ships Node **18.19.1** and
Debian 12 ships **18**, both below the 22.5 this project needs — `apt install
nodejs` would succeed and then crash on first database open. The script checks
`apt-cache policy` first and refuses with a pointer to NodeSource rather than
installing something that cannot work.

**Why 22.5:** Recall uses Node's built-in `node:sqlite`. Below 22.5 that module
does not exist, and the failure surfaces when the index opens — well after
installation appears to have worked.

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

**This machine has no models installed**, so without `--fake` the command
refuses and exits 2:

```
No models found in /tmp/recall-data/models.
Run ./scripts/fetch-models.sh first, or pass --fake to index against deterministic fakes.
```

Verified. The refusal is deliberate: nothing here should be mistaken for a real
index. On a machine where you have run `./scripts/fetch-models.sh`, drop the
`--fake` flag and the same command uses real OCR and embeddings.

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

## 3. Real models — NOT YET RUN ON A MACHINE THAT CAN LOAD THEM

> The **setup path** in §3.1–3.3 has been written and its URLs verified, but no
> model has actually been downloaded, loaded, or executed. Everything in §3.4
> onward is still a prediction. The sizes in §3.2 are real HTTP content-lengths
> from the model repositories, not guesses from model cards — but the *code*
> that consumes those files has never run.

### 3.1 One command

```bash
./setup.sh                    # models + index + verify
./setup.sh --with-vision      # + Florence-2 for diagrams and handwriting
./setup.sh --quick            # no download at all, fake mode (~200 MB total)
```

`--quick` is the option for a machine without spare disk, or to simply see the
thing run.

### 3.2 What gets downloaded

Measured sizes, from `Content-Length` on the actual repository files:

| Role | Directory under `models/` | Size | Source |
|------|---------------------------|------|--------|
| Embeddings (int8) | `bge-small-en-v1.5` | **34 MB** | `Xenova/bge-small-en-v1.5` |
| Embeddings (fp32, optional) | same | 133 MB | same |
| OCR | `tessdata-eng` | **4.1 MB** | `tessdata_fast` |
| Vision (int8) | `florence2-base-ft` | **192 MB** | `onnx-community/Florence-2-base-ft` |
| Vision (fp32) | same | 1.09 GB | same |

Plus roughly 450 MB of `onnxruntime-node` binaries pulled by the optional npm
dependencies. Model weights default to the **int8** variants — for retrieval,
the quality difference from fp32 is not worth 30x the disk.

To fetch them without running the whole setup:

```bash
./scripts/fetch-models.sh                    # ~180 MB
./scripts/fetch-models.sh --with-vision      # +1.1 GB
./scripts/fetch-models.sh --vision-q8        # +192 MB instead
```

The script skips files already present, so re-running after a partial failure
resumes rather than restarting.

### 3.3 What happens after

Nothing further. Recall is offline from that point on: the index path and the
search path make no network calls at all, enforced by
`test/index/offline.test.ts`, which poisons `http`, `https`, `net`, `tls` and
`dns` and runs a full index+search cycle through them.

Fetch them once with internet. Then your screenshots, your index and your
queries never leave the machine.

### 3.4 First real index — EXPECTED, NOT MEASURED

On a CPU-only laptop, budget roughly 1–3 s per image for OCR, plus more for the
low-OCR subset that goes to vision. For 1000 screenshots, expect **20–50
minutes** for the first pass. Vision, if enabled, adds ~1–3 s per image for the
~15% that need it.

**These are estimates.** No model has been run, so nobody knows the real
figures. Record your actual timings here when you do.

### 3.5 Verify what has never been checked

- [ ] Does `bge-small` retrieve "memory management" for a slide that says
      "paging and TLB"? This is the project's central claim and it has never
      been tested against a real model.
- [ ] Does OCR confidence fall below 0.35 on diagrams and handwriting often
      enough to justify the vision pass?
- [ ] Does Florence-2 load through `transformers.js` at all? **Highest-risk item
      in the project** (`../IMPLEMENTATION.md` Appendix B). If it fails, swap in
      `SmolVLM-256M` or an Ollama-side model; nothing outside the
      `VisionDescriber` interface should need to change.
- [ ] Peak RSS during a real index — does the one-model-resident rule hold?
- [ ] Do 384-dim embeddings read back correctly from the `vectors` BLOB column?
      Re-index with `--reset` after switching from fakes (64d) to real (384d).

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
npm run typecheck && npm test && npm run docs:audit && npm run lint:scripts
```

`RECALL_DATA_DIR` defaults to `~/.localrecall`. Set it to isolate runs, as every
command above does, when you want a scratch index.

---

## 5. Troubleshooting

Only failures that actually occurred, with their real text.

**`MIN_MAJOR: unbound variable`, or `[ ...: integer expression expected`**
A shell script referenced a variable it never assigned, under `set -euo
pipefail`. This shipped twice in this repo and `bash -n` did not catch either
one — the syntax was valid, the logic was not.

`npm run lint:scripts` now checks for it: every `$VAR` reference must be
assigned in the same file, loop variables and `${X:-default}` forms are
recognised, and numeric comparisons must be digit-guarded. It runs as part of
`./setup.sh` verification too.

The digit guard is the specific fix for the second error:
`case "$x" in ''|*[!0-9]*) x=0 ;; esac`. A version string that fails to parse
becomes `0`, which reads as "too old" — correct, and not a crash.

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

- **No model has ever been executed.** The adapters in `src/index/adapters.ts`
  are written and their model URLs verified, but nothing has been downloaded or
  loaded. Every measurement in this document comes from deterministic fakes, so
  real OCR accuracy, embedding quality and caption quality are all unverified
  (`../IMPLEMENTATION.md` Appendix C).
- **Weights are downloaded once by `scripts/fetch-models.sh`**, not at runtime.
  After that step Recall makes no network calls at all — enforced by
  `test/index/offline.test.ts`, not just asserted.
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
- [x] Model sizes are measured — real `Content-Length` values from the model
      repositories (§3.2), not estimates from model cards
- [ ] ~~Model quality verified~~ — **cannot be met here.** No model has been
      loaded on any machine, so §3.5 stays an open checklist. The disk sizes are
      measured; the quality claims remain unverified, and saying otherwise would
      be the exact failure this document exists to avoid.
- [x] Troubleshooting contains only errors that actually occurred
- [x] The limitations section is not empty
- [x] The `STUB` marker has been removed

One criterion is deliberately left unticked. A runbook that ticks every box by
guessing is worse than a stub, and the one thing this document must not do is
claim a measurement nobody took.