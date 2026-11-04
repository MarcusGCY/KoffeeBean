---
name: minimal-fix
description: Make the smallest src/ change that turns a BeanBox repro green. Use when fixing an approved issue after the repro test is copied into the PR.
---

# Minimal fix

Follow `.cursor/rules/fix.mdc`. The copied `tests/repro/<slug>.test.ts` stays byte-identical.

## Steps

1. Run `npx vitest run tests/repro/<slug>.test.ts` and read the assertion failure.
2. Change only the `src/` files the bug points to. Keep the diff inside those files.
3. Do not special-case a fixture value. Do not add `NODE_ENV === "test"` or any test-only flag.
4. Do not add a mock of the code under fix. Do not edit the repro.
5. Rerun `npx vitest run tests/repro/<slug>.test.ts` until that file passes.
6. Run `npm test` once.
7. Run `git diff --stat` and confirm the diff is only the copied repro plus the `src/` fix.
