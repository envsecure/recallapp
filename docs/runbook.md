# Runbook

<!-- STUB:status=not-written -->

> **STATUS: STUB — INTENTIONALLY EMPTY.**
>
> This document is written **after** the code works, by following the install
> on a real machine and recording what actually happened. It is not written
> from the plan.
>
> Before writing any of it, read `../AGENT.md` § "Documentation policy".

## Why this is empty

A runbook's entire value is that it was followed. A runbook assembled from
intentions produces setup steps that were never run, in an order that does not
work, with commands that were renamed during implementation. It is worse than no
runbook, because a missing file prompts the reader to think, and a confident
wrong file does not.

So: stub now, filled from evidence later.

## What this document will contain

Author these sections by *doing* them, not by predicting them.

### 1. Prerequisites

- Node version actually required, and how to check it
- Whether the sqlite-vec native extension is required or optional on each platform
- Anything else the target machine needs

Record where each requirement came from. If a requirement was assumed and never
verified, say so here rather than presenting it as fact.

### 2. Development box setup

The 2.7 GB / no-GPU / 3.3 GB-free-disk box. It cannot run models, and that
shapes the setup.

- Install, build, test commands — as run
- Where fakes live and how to confirm the suite is using them
- How to run the fixture generator
- Explicit note that no model weights are downloaded here, and what that forbids

### 3. Real laptop setup

The machine with a real GPU and enough disk for weights.

- Model acquisition: the manual, human-invoked step, with its actual disk cost
- Where weights are stored, and how the app finds them
- GPU/CPU runtime selection, and how to confirm which one is active
- **Every command here must have been executed on that machine before it is
  written down.** Until then this section stays stubbed.

### 4. Running

- Indexing: the exact command, expected output, how to read the progress report
- Search: how to start the server, how to open it, how to pick a folder
- First-run timing expectations, and how to tell a slow machine from a bug

### 5. Troubleshooting

Written from real failures, each with the actual error text. A troubleshooting
entry written from imagination is a guess wearing a heading.

### 6. Known limitations of this setup

The honest list: what does not work, what is slow, what is unverified.
See `../GOAL.md` and `../IMPLEMENTATION.md` Appendix C.

## Completion criteria

This file is `CURRENT` only when:

- [ ] Every command in it has been executed successfully on the machine it
      claims, and the box is named
- [ ] Model disk costs are measured, not estimated
- [ ] The troubleshooting section contains only errors that actually occurred
- [ ] The limitations section is not empty
- [ ] The `STUB` marker at the top of this file has been removed

<!-- /STUB -->