# Docs index

All project documentation lives in this folder. Root-level `GOAL.md`,
`IMPLEMENTATION.md`, and `AGENT.md` stay at the root — they are the intent and
policy documents. This folder holds documents that are **derived from the code**
and therefore must be written after it exists.

## Status

`STUB` = deliberately not written yet, must be authored from real code.
`CURRENT` = written and believed to match the code (verify before trusting).

| File | Status | Written after | Authored from |
|------|--------|---------------|---------------|
| [runbook.md](runbook.md) | STUB | first working install on a machine with a GPU | real setup commands, verified on a named machine |
| [architecture.md](architecture.md) | CURRENT | P0–P3, 2026-10-10 | the module graph `src/` actually has, the SQL `src/db/` actually issues, and a per-capability real-vs-fake table |

**Why `runbook.md` is still a stub.** Its completion criteria require every
command to have been executed on the machine it claims, model disk costs to be
*measured* rather than estimated, and the troubleshooting section to contain
only errors that actually occurred. No model has ever been loaded on any machine
in this repository's history, and the GPU machine does not exist yet. Part of
§2 (fixture generation, benchmark) is genuinely runnable here, but publishing
half a runbook with a stub banner in the other half would produce exactly the
confident-wrong-file outcome the document exists to avoid.

**Why `architecture.md` can be written now.** Its criteria are about the code,
not about machines: every subsection cites a path under `src/`, §3 states which
adapters are real and which throw, §8 is non-empty, and SQL is quoted rather
than reconstructed. All four hold. The code-hash marker means the audit will
flag the document as `STALE` the moment `src/` moves.

## The rule

A STUB document must not be filled in from imagination, from the plan, or from
another document's description of it. These two files are written by reading the
code after it exists. If you cannot cite the file and line you are describing,
it does not go in.

Concretely: `architecture.md` documents the module graph that
`src/` actually has, the queries `src/db/` actually issues, and the interfaces
`src/interfaces/` actually declares. `runbook.md` documents commands that were
actually run successfully on a machine — including which box they ran on.

## Why these two are deferred

They are the two documents most likely to be wrong, because both describe
systems that do not exist yet. A runbook written from the plan documents a
setup that was never performed. An architecture doc written from the plan
documents a design that implementation quietly abandoned. Both are worse than
absent: they read as authoritative and will be trusted by someone who never
sees the git history.