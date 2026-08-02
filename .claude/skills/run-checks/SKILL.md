---
name: run-checks
description: Run this repo's ticket definition-of-done checks (typecheck + tests). Use before marking any ticket complete, and as the first thing to run when a ticket claims to be done.
---

# Run checks

Every ticket's machine-checkable DoD is the same two commands, run from the repo root. Both must exit 0.

```bash
npm run typecheck
npm test
```

If `package.json` doesn't define these exact script names yet, that's a scaffold-ticket bug — check `KNOWN_ISSUES.md` first, then fix the script names to match rather than inventing a different check.

## What "tests" covers

`npm test` runs the full Vitest suite: deterministic math tests (no model, no DB), fixture-provider tests against the locally-served `generate` Edge Function, and invariant tests. It does **not** start Docker/Supabase or the Edge Function server itself — those must already be running (see the `local-supabase-stack` skill) before `npm test` is invoked, or every DB-touching and Edge-Function test fails with a connection error that looks like a code bug but isn't.

Before running `npm test`, always confirm:
```bash
docker ps                                    # stack up?
```
If nothing's listed, start it (`local-supabase-stack` skill) before concluding tests are broken.

## What is never part of this check

Simulator/device builds, `expo`-style native builds, EAS/App Store builds, anything requiring a UI to visually confirm. If a ticket's DoD asks for one of these, that's a spec bug — flag it in `docs/agents/CLARIFICATIONS.md`, don't attempt to satisfy it unattended.

## Reading a failure

- **Typecheck failure** → fix the types, don't `@ts-ignore` past it.
- **A specific invariant test failing** (see `docs/SPEC.md` §6-7) → this usually means the deterministic math or the Edge Function's post-processing has a real bug, not a flaky test. Check `KNOWN_ISSUES.md` for this exact invariant before re-deriving the fix from scratch.
- **Flaky failure on re-run with no code change** → almost always the local Supabase stack, not the code. Restart it before assuming the test itself is wrong.
