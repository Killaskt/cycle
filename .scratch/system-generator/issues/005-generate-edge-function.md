---
id: 005
title: generate Edge Function — provider seam, validation, invariants, fallback
status: done
blocked_by: [001, 003]
---

## Scope

`docs/SPEC.md` §3, `docs/adr/0005-generation-model-code-split.md`. Build `supabase/functions/generate/`:

- Provider seam selected by `MODEL_PROVIDER` env var (`fixture` | `live`) — same pattern for both, see `.claude/skills/local-supabase-stack/SKILL.md`.
- Per-focus-area model call, response validated against the shape in `docs/SPEC.md` §3.
- Deterministic post-processing using the ticket-003 math library: `plan_freq`/`plan_dur`, ceiling check, final bucket resolution against `blocked_windows` + reliability map (reliability map input is `[]` on cycle 1 — must not crash or special-case this away, just treat every bucket as neutral).
- Runtime invariant validator (the four checks in `docs/SPEC.md` §3) — retry once on failure, then apply the deterministic fallback from `CONTEXT.md` §12 **for the offending focus area(s) only**.

## Definition of done

- Fixture-provider tests: canned valid responses produce the expected `commitments` output through the real function, served locally (`supabase functions serve generate`), no live network call.
- A fixture returning a malformed/out-of-enum `preferred_bucket` triggers exactly one retry, then the deterministic fallback — assert `commitment_name` is the verbatim focus-area text, `session_shape` is a flat block, and `bucket` is the first non-blocked bucket in wake-time order.
- Invariant tests, run against fixture output: no commitment lands in a `blocked_windows` date; `Σ(freq×dur) <= ceiling`; exactly one commitment per submitted focus area; every `freq`/`dur` within delta-formula bounds.
- Contract test: every checked-in fixture file passes the invariant validator (catches prompt/schema drift without a live call).

## Notes

Implemented in `supabase/functions/generate/`:
- `types.ts` — request/response/model-response shapes, `Bucket` enum (docs/SPEC.md §1, §3).
- `bucketOrder.ts` — wake-time-ordered bucket scan, blocked-window derivation, reliability-based reassignment, first-available-bucket fallback.
- `validate.ts` — model response shape validator (docs/SPEC.md §3).
- `invariants.ts` — the four runtime invariants (one commitment/focus area, no blocked-bucket collision, freq/dur within delta bounds, load <= ceiling), reusing `computeStep`/`computeDurationStep` from `src/lib/generationMath.ts`.
- `provider.ts` — `MODEL_PROVIDER=fixture|live` seam; fixture provider keyed by focus-area name against `fixtures/*.json`, plus a `__invalid_bucket__` sentinel name (not a checked-in fixture) to deliberately exercise the retry-then-fallback path; live provider calls Anthropic's Messages API (untested here, no key in this environment — see CLARIFICATIONS.md).
- `index.ts` — orchestrates: `applyCeiling` (ticket 003 math, reused not reimplemented) → per-focus-area model call with shape-validation retry-once-then-fallback → bucket resolution → aggregate invariant validator with its own retry-once-then-fallback for any offending focus area(s).
- `fixtures/running.json`, `fixtures/spanish.json`, `fixtures/strength_training.json` — canned valid model responses.

Tests (all green): `supabase/functions/generate/{validate,bucketOrder,invariants}.test.ts` (pure unit tests), `supabase/functions/generate/fixtures.contract.test.ts` (every checked-in fixture file passes the shape validator), `src/test/integration/generate.test.ts` (HTTP tests against the function served locally via `MODEL_PROVIDER=fixture supabase functions serve generate` — happy path, multi-focus-area ceiling, malformed-response fallback, invariant checks). `npm run typecheck` and `npm test` both green (115 tests, 17 files).

Five genuine spec gaps hit and logged to `docs/agents/CLARIFICATIONS.md` under `[005]` (all conservative, reversible assumptions, none blocking): `blocked_windows` collision has no time-of-day to compare against (resolved via day_type-wide blocking), `time_of_day` clock boundaries, day-type scan priority, the reliability "meaningfully worse" threshold, and which model API the live provider calls.
