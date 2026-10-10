# Recall — GOAL

## The problem

A student accumulates 1000+ screenshots in a flat folder: lecture slides, whiteboard
photos, code snippets, diagrams, chat forwards. By exam time they cannot find the
one screenshot that mattered. Filenames are useless (`Screenshot 2024-03-11 at
14.22.07.png`). Folders are unused. Text search fails because slide text is buried
in pixels.

Recall indexes a folder of images **locally** and lets the user find screenshots by
describing what they remember: *"computer architecture notes from last month"*.

## Success statement

The user types a sentence, gets a ranked grid of the actual screenshots, and
recognises the right one within a few seconds. The sentence does not have to
contain words that appear in the image — it may describe the *subject*
("paging", "cache miss") or the *time* ("last month") or both.

## Features (v1 must have all)

| # | Feature | Notes |
|---|---------|-------|
| F1 | Local image indexer | Watches a user-chosen folder, recursive, incremental |
| F2 | Text extraction | OCR on every image, with bounding boxes |
| F3 | Semantic embeddings | Every image's text is embedded; stored locally |
| F4 | Natural-language search | Returns ranked matches by meaning, not keywords |
| F5 | Temporal filtering | "last month", "in october", "3 weeks ago" narrow results |
| F6 | Visible resolved range | Search bar shows what time range was understood; one-click correct |
| F7 | Thumbnail gallery | Virtualised grid, fast scroll at 10k+ images |
| F8 | Hybrid ranking | Vector similarity + FTS5 keyword score, blended |
| F9 | Vision fallback | VLM caption for images where OCR confidence is low |
| F10 | Fully offline | No network calls at runtime. Ever. |

## Features (post-v1, in order)

- F11 Written summary above results, with cited thumbnails
- F12 Slide-deck clustering (consecutive frames → one result)
- F13 Duplicate detection and removal UI
- F14 Per-folder include/exclude rules
- F15 Keyboard-first UI (j/k navigate, enter opens, esc back)

## Constraints

### Hard constraints (non-negotiable)

- **C1 — No data leaves the machine.** No cloud inference, no telemetry, no CDN
  scripts, no remote fonts. The server binds `127.0.0.1` only.
- **C2 — No model downloads in the dev environment.** The dev box is CPU-only,
  2.7 GB RAM, 3.3 GB free disk, 4 cores. Model weights cannot be fetched or run.
- **C3 — Tests use fakes, never real models.** Every model-touching module is
  defined behind an interface with a deterministic fake. See `test/fakes/`.
- **C4 — One model resident at a time.** Explicit load/unload. Never hold OCR +
  VLM + embedder + LLM simultaneously. This is a hard RAM ceiling, not a nicety.
- **C5 — Single-file database.** One `.db`, no server, no daemon, no Docker.
  *Amended 2026-10-10:* the original text said "SQLite + sqlite-vec". The code
  uses Node's built-in `node:sqlite` with a brute-force JS vector scan and does
  **not** use sqlite-vec — no native build step, because this box has no
  toolchain guarantee. `docs/architecture.md` §8.2 records the divergence. The
  single-file property this constraint exists to protect still holds.

### Development environment constraints

| Resource | Value | Consequence |
|----------|-------|-------------|
| RAM | 2.7 GB total, ~1.3 GB free | Model loading is the bottleneck; leak in one module and everything OOMs |
| Disk | 3.3 GB free (86% used) | No multi-GB model downloads; no duplicate venvs |
| GPU | none | CPU inference only; this is the design baseline |
| Cores | 4 | Indexer concurrency capped at 2–3 |
| Node | dev box | Target the installed Node; no bleeding-edge APIs |

### Design constraints

- **C6 — OCR-first, VLM-second.** OCR runs on everything (fast). The VLM runs
  only on the low-confidence subset. This is what makes CPU-only viable: ~15% of
  images get expensive treatment, not 100%.
- **C7 — Never embed images.** We embed *text about* images and return the real
  file. No image vector DB, no regeneration, no quality loss.
- **C8 — Never store generated descriptions as truth.** OCR text and VLM captions
  are both stored, with their source, so ranking can weight them differently.
- **C9 — Every external dependency gets an interface + fake before it gets a real
  implementation.** No exceptions. This is what makes C2/C3 workable.

## Non-features (explicitly NOT doing)

These are decisions, not omissions. Do not add them. If someone proposes one,
point at this section.

| # | Not doing | Why |
|---|-----------|-----|
| N1 | Cloud APIs / hosted inference | Violates C1. The entire point is offline |
| N2 | Documents (PDF, DOCX, PPTX) | User deferred. v1 is images only |
| N3 | Video indexing | User deferred |
| N4 | Audio / transcription | Out of scope |
| N5 | Web clipper / browser extension | Separate product, separate threat model |
| N6 | Multi-user / accounts | Single user, single machine |
| N7 | Network sharing / remote access | Contradicts C1 |
| N8 | Mobile app | Desktop only |
| N9 | Cloud sync / backup | Contradicts C1 |
| N10 | Editing images | Read-only viewer |
| N11 | Custom model training / fine-tuning | Out of scope, needs data we do not have |
| N12 | Re-implementing OCR or VLM from scratch | Use existing libraries |
| N13 | Docker / microservices | Single local process, single DB |
| N14 | Plugin system | Premature |
| N15 | Full-text inside images as the primary path | Keyword-only search already fails; semantic is the point |

## Definition of Done

The project is **done for v1** when every one of these is true and verified:

1. **C1 holds under test.** An automated test asserts zero outbound network calls
   during a full index + search cycle (network stubbed to throw).
2. **Indexing is correct and incremental.** Pointing Recall at a folder of N
   images produces N records; re-running adds nothing; touching one file
   re-indexes exactly one file; deleting a file removes its record.
3. **Search is semantic, not lexical.** A query using *none* of the words in the
   target image ("memory management" finds a slide that says "paging and TLB")
   returns that image in the top 10. Tested against the fixture set using the
   deterministic fake embedder. This proves the ranking path is wired, not that
   a real model retrieves semantically — see "Explicitly deferred" below.
4. **Temporal queries work.** "last month" on a fixture folder with known-dated
   files returns only files in the resolved range, and the range shown in the UI
   matches the range actually applied to the query.
5. **Time filter runs before ranking, not after.** Test asserts that a date range
   with a matching-but-low-ranked item does not crowd out in-range results.
6. **The low-OCR fallback triggers.** Fixtures with no text (diagram, whiteboard)
   are routed to the vision interface; high-OCR fixtures are not.
7. **Memory ceiling respected.** Test asserts at most one model interface is
   "resident" at any point, and unload is idempotent.
8. **The dev box runs the test suite green** using only fakes, in under 60s,
   without downloading a single model weight.
9. **The 1000-image scenario is simulated.** A fixture generator produces 1000
   fake images with known timestamps and known topics; a benchmark script reports
   index time, search latency, and peak RSS against the fakes.
10. **No dead ends.** Every module has a fake-backed test; no module is unwired.

## Explicitly deferred to a later project

Replacing fakes with real models and validating on a real machine with 8 GB+ RAM
and a GPU. **That validation is a separate task on a different box.** Recall's v1
is correct if and only if the interfaces, indexing, ranking, and UI are correct —
model quality is a configuration detail behind those interfaces.