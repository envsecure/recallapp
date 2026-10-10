# Architecture

<!-- STUB:status=not-written -->

> **STATUS: STUB — INTENTIONALLY EMPTY.**
>
> Written **after** the code exists, by reading the code. Every claim here must
> point at a real file. If you cannot cite `src/...`, it does not go in.
>
> Before writing any of it, read `../AGENT.md` § "Documentation policy".

## Why this is empty

An architecture document written before the implementation describes the design
that was *intended*. Implementation diverges — always, and in ways nobody
predicts. Names change, a layer gets flattened because it was ceremony, two
subsystems turn out to be one. A reader who finds a confident architecture doc
next to unfamiliar code will assume the code matches it and lose an afternoon.

So: stub now, described-from-code later.

The pre-code design is not lost. It lives in `../GOAL.md` (constraints, features,
non-features, definition of done) and `../IMPLEMENTATION.md` (phases, checklists,
rationale appendices). Those are intent documents and are labelled as such.
This file is a description of reality and carries a higher burden of proof.

## What this document will contain

### 1. System overview

One diagram, one paragraph. The actual process topology: how many processes,
what listens on what, what is on disk. If it is one Node process and one SQLite
file, say exactly that.

### 2. Module map

The real tree under `src/`, each module with one line on what it owns and who
calls it. Include the things that are ugly: the seams where a fake replaced a
real adapter, the module that grew three responsibilities.

### 3. The interfaces

What `src/interfaces/` actually declares, and — critically — **which
implementation is currently wired in and which are fakes**. This is the single
most important section in the file. A reader must be able to tell, at a glance,
how much of this system has ever executed real inference.

### 4. Data model and access paths

- Actual schema, from the migration files
- Actual queries, from the `src/db/` code that issues them
- Where the time-range filter is applied, and the SQL that proves it
- The normalisation of stored embeddings, and where it happens

### 5. Indexing flow

Real sequence: scan, filter, hash, extract, chunk, embed, persist. With the
resume path described as implemented, not as intended.

### 6. Query flow

Real sequence: parse, resolve time, embed, vector search, fuse, respond. Note
every stage that can be skipped when an adapter is missing.

### 7. Resource lifetime

How the one-model-resident rule (`../GOAL.md` C4) is enforced in practice: who
calls `load()`, who calls `unload()`, what happens when the budget is exceeded.

### 8. Known divergences from the plan

**This section must not be empty.** Where the code departed from
`../IMPLEMENTATION.md`, record it and why. An architecture doc that agrees with
the plan everywhere has not been read carefully enough.

## Completion criteria

This file is `CURRENT` only when:

- [ ] Every subsection describes code that exists, with paths cited
- [ ] §3 states plainly which adapters are real and which are fakes
- [ ] §8 is non-empty
- [ ] SQL is quoted from the actual query code, not reconstructed
- [ ] The `STUB` marker at the top of this file has been removed

<!-- /STUB -->