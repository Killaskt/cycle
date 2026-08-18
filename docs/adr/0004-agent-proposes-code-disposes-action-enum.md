# ADR-0004: Bounded ActionType enum as the single contract for every plan mutation — agent proposes, code disposes

## Status
Accepted

## Context

Any amendment to a locked plan (fall-off response, mid-cycle or cycle-wide) needs to eventually be proposable by a model, but a model's output can never be trusted to touch a plan directly — malformed or unexpected output must not be able to corrupt a locked system, and every amendment needs to be deterministically testable without a model in the loop.

## Decision

Define a single bounded enum, `ActionType = { NONE, MOVE, SHORTEN, REDUCE_FREQUENCY, REALLOCATE, EASE_NEXT_DAY, REMOVE, UNHANDLED }`, in code. Any proposer — rule-based (MVP, see ADR-0007) or model-based (post-MVP) — must return `{ action, target, params, reasoning, confidence }`. Code validates the response against the enum, then executes via a switch statement; it never trusts or interprets free-form model output directly. Malformed or out-of-enum output: retry once, then fall to `UNHANDLED` (applies `NONE`, writes a dev report, never surfaces anything unusual to the user).

The enum is the single source of truth — any future prompt's action menu is generated from it at runtime, never hand-maintained as a parallel list.

Guardrails enforced in code regardless of proposer: net load can only go down or stay flat at a fall-off; `EASE_NEXT_DAY` must auto-expire; reductions have a floor, below which the only remaining action is `REMOVE`.

## Consequences

- A bad model response can never corrupt a plan — the failure mode is always "nothing happened, developer got a report," never "the plan is now wrong."
- New actions are additive to a stable vocabulary; guardrails and future analytics attach to that vocabulary rather than to free text.
- Every amendment, rule-based or model-based, is tested identically — one deterministic test per enum member (ADR-0007).
