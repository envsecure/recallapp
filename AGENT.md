# AGENT.md — instructions for coding agents in this repo

Read this before writing any code. It describes how to work in this repository.

## What this project is

A fully-offline semantic search engine for a folder of images. Node + Express +
React + TypeScript. See `GOAL.md` for what it is and is not.

## The one rule that shapes everything

**This dev box cannot run models.** 2.7 GB RAM, 3.3 GB free disk, 4 cores, no GPU.
You cannot download model weights and you cannot run inference here.

Therefore:

- **Never write code that downloads a model at import time, module load time, or
  test time.** Not lazily-on-first-call either. Downloads happen behind a
  explicitly-invoked, human-triggered step that is skipped in tests.
- **Never write a test that touches a real model.** Every model dependency is an
  interface. Tests exercise them through the fakes in `test/fakes/`.
- **If you need to check whether a real model would work, you cannot.** Write the
  adapter, note the uncertainty in a comment, move on. Do not guess about model
  output and bake the guess into a test.

The temptation to "just add a quick test" that loads something real is the single
most common way to waste an hour here. Don't.

## How to run OpenCode in this repo

The dev box has `opencode` at `~/.opencode/bin/opencode` (v1.18.x).

Use the contributor 1.3 model at high effort:

```bash
cd ~/Desktop/recallapp
opencode run --model opencode/muse-spark-1.3-contributor-free --variant xhigh "<task>"
```

- `--variant xhigh` is accepted by this OpenCode build and does raise reasoning
  effort. Caveat: it is also **silently ignored when the value is unrecognised** —
  we verified a bogus variant still exits 0. So it is best-effort, not
  guaranteed. Do not treat a passing run as proof the variant applied.
- `opencode run` needs no PTY. Use `background=true, pty=true` only for the
  interactive TUI.
- Exit the TUI with Ctrl+C. `/exit` is not valid — it opens an agent picker.
- Always scope a session to this one repo (`workdir=~/Desktop/recallapp`).

### The `-f` flag is broken in this build — do not use it

In opencode 1.18.35, `-f` greedily consumes every remaining argument as a
filename. Passing a prompt after `-f` fails with `File not found: <your prompt>`
and produces no work:

```bash
# WRONG — the prompt gets eaten as a filename
opencode run -f AGENT.md "implement the fakes"

# RIGHT — put the prompt first, or attach files via `--file` one at a time,
# or just inline the constraints you need. There is no reliable way to combine
# them on this build.
opencode run "implement the fakes (constraints: ...)"
```

Verified by running both forms. If a task needs several files in context,
read them yourself and paste the relevant contract into the prompt instead.

## Test conventions

- Tests live in `test/`. Unit tests mirror the source path:
  `src/search/rank.ts` → `test/search/rank.test.ts`.
- Runner: `vitest`. Command: `npm test`.
- **Fakes live in `test/fakes/` and are imported by tests only.** Nothing in
  `src/` may import from `test/`.
- A fake must be deterministic. Use a seeded PRNG (never `Math.random()`) and
  fixed timestamps (never `Date.now()`) so a failing test always fails the same
  way.
- Fakes must be able to fail on purpose. Each fake exposes knobs to force
  errors, return empty results, or exceed a limit, so error paths are testable
  without monkey-patching.
- Image fixtures are generated, not committed as binaries. `test/fixtures/`
  contains a generator script; `npm run fixtures` writes small PNGs to a gitignored
  directory.

## Module conventions

- TypeScript strict mode. No `any` in exported signatures.
- Every external capability sits behind an interface defined in
  `src/interfaces/`. The real adapter and the fake both satisfy it.
- Services take their dependencies as constructor arguments (or a plain deps
  object). **No module-level singletons.** This is required so tests can inject
  fakes and so the RAM ceiling in `GOAL.md` C4 is enforceable.
- Resource lifetime is explicit: anything that allocates native memory exposes
  `load()` and `unload()`. `unload()` must be idempotent and safe to call twice.
  There is a test that asserts this for every such module.
- Database access goes through `src/db/`. No raw SQL scattered in route handlers.
- The HTTP server binds `127.0.0.1`. Do not add a `HOST` env override that could
  widen this. There is a test asserting the bind address.

## Error handling

- Errors crossing a module boundary are typed (`AppError` with a `code`). No bare
  `throw new Error()` in service code.
- Indexing is **resumable**. If the process dies mid-index, restarting continues
  from where it stopped. Any new file-writing code must not break this.
- Indexing never deletes a user's image files. It only writes to its own data
  directory.

## Style

- Match the surrounding code. Do not reformat files you did not otherwise change.
- Comments explain *why*, not *what*. The "why" here is usually a constraint from
  `GOAL.md` — reference it (`C6`, `C4`) instead of re-explaining at length.
- Prefer small, focused modules. A file that needs a paragraph to describe is two
  files.

## Definition of "done" for any task

- Code compiles (`npm run typecheck` passes).
- Tests pass (`npm test`) and new behaviour has a test using fakes.
- No new network dependency. No model download.
- No `any` in exported signatures.
- If you changed an interface, every implementor and fake was updated.

## Things not to do

- Do not add cloud APIs "just for a quick test".
- Do not add Docker, Redis, or a separate vector DB server.
- Do not expand scope past images into documents or video (`GOAL.md` N2/N3).
- Do not create large binary fixtures. 3.3 GB of free disk is not a budget.
- Do not leave a TODO that says "wire this up later" — wire it or remove it.

## Documentation policy

Docs in this repo fall into two classes, and the difference is not stylistic.

**Intent documents** — `GOAL.md`, `IMPLEMENTATION.md`, `AGENT.md`, and this
section. These describe what we intend to build. They are written before the code
and are updated as decisions change.

**Description documents** — everything in `docs/`: `runbook.md`,
`architecture.md`. These describe what *exists*. They are written only by reading
the code, after it exists. They carry a higher burden of proof than intent
documents, because a reader cannot tell which kind they are holding.

### Rules

1. A description document is never written from a plan, a memory, or another
   document's account of it. If you cannot cite the file you are describing, the
   claim does not go in.
2. `docs/runbook.md` records commands **that were actually run**, on a named
   machine. A step nobody executed does not go in it.
3. `docs/architecture.md` records the module graph `src/` actually has — including
   the ugly parts, and explicitly **which adapters are real and which are fakes**.
   A reader must be able to tell at a glance how much of the system has ever run
   real inference.
4. `docs/architecture.md` §8 (divergences from the plan) must never be empty. If
   the code agrees with `IMPLEMENTATION.md` everywhere, the architecture doc has
   not been read carefully enough.
5. When a change makes a description document wrong, fix the doc **in the same
   commit as the code**. A wrong doc is worse than an absent one: absence prompts
   the reader to think, a confident wrong file does not.
6. Documents carry a status marker so staleness is detectable without reading
   them:

   ```
   <!-- STUB:status=not-written -->     deliberately unwritten; must be authored from real code
   <!-- STUB:status=stale -->           was written, code has moved since
   <!-- DOC:status=current -->           written, believed to match the code
   ```

   Run `npm run docs:audit` to check. See `scripts/docs-audit.mjs`.

### Marking a stub as written

Only remove the `<!-- STUB -->` markers when the file meets its own completion
criteria (each stub lists them). Do not delete the markers to make an audit pass.
An audit that can be satisfied by deleting the warning is not an audit.

## Current state

Phases P0–P2 are the v1 target. See `IMPLEMENTATION.md` for what each phase
requires and how to know it is finished. Start with the earliest phase whose
"DONE when" conditions are not yet met.