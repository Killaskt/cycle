# ADR-0006: The user can edit reality; the user cannot edit the plan — enforced structurally

## Status
Accepted

## Context

A locked plan (CONTEXT.md §7) is core to the product's thesis — no editing, no re-optimizing mid-cycle. But real life intrudes: a class, a trip, a schedule collision that has nothing to do with the user's discipline. If handling that means letting the user "add an event" through the same surface that touches commitments, that becomes the editing loophole that quietly kills the lock — there's no principled line between "add an event" and "just let me change my run to 2x instead of 4x."

## Decision

Two separate kinds of write, kept structurally separate — not just by convention:

- **Commitments** (the plan): written only by generation and by code-executed amendments (ADR-0004). Never by direct user edit.
- **Constraints** (`BLOCKED`/`PROTECTED` windows, representing reality): written by the user reporting something external. MVP ships exactly one path for this — a lightweight "something came up" tap, no survey, no escalation, does not increment either fall-off counter (protects reliability-map data quality; an unavoidable absence isn't a fall).

These live in physically separate tables with separate write paths, specifically so that no future feature — including an eventual calendar-feed integration — can populate anything but `BLOCKED`. The boundary is enforced by schema structure, not by discipline or code review catching a violation later.

Full life-sync (recurring constraints, mid-cycle ceiling recomputation, multi-day displacement) is explicitly post-MVP. The schema is shaped for it now anyway, since retrofitting the table separation later would be far more disruptive than building it correctly the first time.

## Consequences

- "I fell off" data stays clean — a wedding on Saturday doesn't get miscoded as a failure to keep a commitment.
- Any future calendar-feed feature is a population source for `BLOCKED`, not a new write path to review for plan-editing risk — the boundary can't be quietly eroded by a well-meaning integration.
- When full life-sync is eventually built: constraint additions should be logged the same way fall-offs are (a burst of new constraints in a week is itself an overload signal) — noted for that future work, not required tonight.
