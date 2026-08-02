# ADR-0005: Generation uses a live model call in MVP; the model interprets, code schedules

## Status
Accepted

## Context

Generation needs to turn a freeform focus area ("get better at Spanish") into something schedulable. Two options: defer any live model call in MVP (template-based generation from the deterministic formula alone), or build the one Edge Function generation actually needs. A model call requires a server-side hop (a mobile client can't hold the API key), so either way an Edge Function has to exist for the amendment path eventually — the question is only whether generation uses it tonight.

Template-only generation is cleaner for the unattended loop, but a two-week cycle whose plan was never actually generated doesn't test the product's real premise, and doesn't produce meaningful data for whether generation quality improves cycle over cycle.

## Decision

Build one Edge Function (`generate`) and use it for real in MVP. Split responsibility narrowly: the model returns `{ focus_id, commitment_name, session_shape, preferred_bucket, rationale }` — naming and qualitative shape only. All numbers — frequency, duration (the delta formula, CONTEXT.md §5), the load ceiling, and final placement (reliability map, blocked windows) — are computed deterministically in code and never touch the model.

Same provider-seam pattern as the amendment path (ADR-0004): fixture provider (canned, schema-valid responses) in tests, real provider in dev, selected by env var. Runtime validator: invalid output → retry once → deterministic fallback (verbatim focus-area text as name, a flat block sized to the formula's duration, first non-blocked bucket in wake-time order). Invariant tests (no commitment in a blocked window, load ≤ ceiling, one commitment per focus area, freq/duration within delta bounds) run in CI and as the actual runtime validator, not just as tests.

## Consequences

- Generation is exercised for real from cycle 1, which is a precondition for the product's own success test #2 (does cycle 2 differ *because of* real fall data).
- Nondeterminism is scoped to naming/placement suggestions only — every number in a plan is reproducible from the same inputs, so the vast majority of generation logic needs no model in its test path at all.
- Generation can never fail to produce a plan, and can never produce an invalid one — the retry-then-deterministic-fallback path is a hard runtime guarantee, not just a test convenience.
