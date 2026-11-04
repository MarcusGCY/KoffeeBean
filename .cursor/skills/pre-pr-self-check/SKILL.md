---
name: pre-pr-self-check
description: Check a BeanBox triage or fix branch before opening the PR. Use after the repro test is written (triage) or after the fix is green (fix).
---

# Pre-PR self-check

Triage items apply when the branch only adds `tests/repro/<slug>.test.ts`. Fix items apply when the branch copies that test and changes `src/`.

## Checks

- **Fix.** The repro fails on the base ref and passes on this head. Run it on the base commit, then on the head: `npx vitest run tests/repro/<slug>.test.ts`.
- **Fix.** Revert check: undo the `src/` fix, confirm the repro fails again, then restore the fix.
- **Both.** Run `npm test` once. Only the known planted failures that already fail on main may still fail.
- **Triage.** `git diff --stat` against main shows only the new `tests/repro/<slug>.test.ts`.
- **Fix.** `git diff --stat` leaves `tests/` unchanged except the copied repro, and that file is byte-identical to the triage file (`git diff --no-index` against the source, or `cmp`). No edits to config, CI, workflows, package scripts, or snapshots.
- **Both.** The diff has no secrets and no real customer data.
- **Both.** The PR body states the root cause in one or two sentences, what changed, and any risk to auth, the signed confirm, or user scoping.
