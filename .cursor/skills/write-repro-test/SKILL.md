---
name: write-repro-test
description: Write one failing BeanBox vitest repro at tests/repro/<slug>.test.ts. Use when triaging a new bug and adding the reproduction test.
---

# Write a repro test

Add exactly one file, `tests/repro/<slug>.test.ts`. Follow `.cursor/rules/triage.mdc`. Copy the style of `tests/cart.test.ts`, `tests/checkout.test.ts`, `tests/store.test.ts`, and `tests/upstash.test.ts`.

## Steps

1. Read the report and the suspected code under `src/`. Name the `it` for the behaviour (`drops the line when quantity reaches zero`), not the ticket id.
2. Import the module under test with the `@/` alias. For a pure function, call it the way `tests/cart.test.ts` calls `total` and `tests/checkout.test.ts` calls `checkout`. For an HTTP route, call the handler with `new Request` and assert `res.status` plus the JSON body, the way `tests/store.test.ts` does.
3. Put a passing control `it` next to the failing one. The control matches current main. The failing `it` is the report.
4. Derive the expected value from the report or from `src/data/products.json` (see the `// 3 x 1200` note in `tests/cart.test.ts`). Do not invent a number from a previous run.
5. Assert observable behaviour: a return value, an HTTP status or body, or saved state. Do not assert a private function, a call count, or a log line.
6. Mock only an external edge. Stub `fetch` for Upstash the way `tests/upstash.test.ts` does. Mock `@/lib/shopper` when the route needs an Auth0 session. Do not `vi.mock` the module under test.
7. No snapshots. No `setTimeout` or real `Date.now()`. If time matters, use `vi.useFakeTimers()` and `vi.setSystemTime(new Date("2026-10-31T00:00:00.000Z"))`. If a seed is unavoidable, pass a fixed seed. Prefer no randomness; `tests/checkout.test.ts` only checks `order?.id` with `/^BB-/`.
8. Run `npx vitest run tests/repro/<slug>.test.ts`.

## Done when

- The file imports and the setup succeeds on main.
- The only failure is the assertion. Quote that message (for example `expected 3600 to be 0`). An import, type, or setup error is not a repro.
- The control case passes.
