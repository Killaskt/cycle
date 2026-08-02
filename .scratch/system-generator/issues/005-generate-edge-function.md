---
id: 005
title: generate Edge Function — provider seam, validation, invariants, fallback
status: open
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
