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
| [runbook.md](runbook.md) | STUB | first working install | real setup commands, verified on a machine |
| [architecture.md](architecture.md) | STUB | after P2 | actual modules, actual data flow, actual SQL |

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