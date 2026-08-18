# ADR-0007: MVP amendment path is a deterministic rule behind the real agent's contract, not a live model call

## Status
Accepted

## Context

The amendment path (2nd/3rd fall-off) was originally scoped to use a live model, matching the full design in `docs/oneDoc.md` §7–8. Building it as a live model call tonight means designing and shipping a second Edge Function surface (beyond generation, ADR-0005) with its own prompt-correctness risk, retry/`UNHANDLED` logic, and confidence tracking, unattended, in one night.

## Decision

MVP ships a deterministic rule in place of a live agent for the amendment path: `MOVE` at the 2nd fall (non-destructive, net-load-neutral, reversible, addresses the most common real cause — wrong time of day), `REMOVE` at the 3rd fall on the same slot. The rule must emit the **identical contract** a real agent will later — `{ action, target, params, reasoning, confidence }` — rendered to the user, accepted or rejected-with-reason, both outcomes logged exactly as the live-agent path will log them.

This is the load-bearing constraint of this ADR: a rule that silently applies `MOVE` without producing this shape captures zero accept/reject data, and that log is exactly the training signal the future per-user preference model depends on. The rule is a stand-in for the model behind the same contract (ADR-0004) — not a bypass of it.

Generation (ADR-0005) is *not* deferred by this decision — it uses a live model in MVP regardless, because deferring generation guts the product's premise in a way deferring the amendment-proposer specifically does not.

## Consequences

- Cycle 1 still produces real amendment training data (accept/reject/reason, per slot) even with zero live model calls on this path — the swap to a real agent later is a drop-in behind the existing interface, not a rearchitecture.
- Substantially smaller unattended-build surface for tonight: no amendment-path Edge Function, no amendment prompt to get right with nobody watching.
- The deterministic rule exercises two enum members (`MOVE`, `REMOVE`) and the full escalation path from cycle 1, so none of ADR-0004's switch logic is dead code waiting on a future model.
