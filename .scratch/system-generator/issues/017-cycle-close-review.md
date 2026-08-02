---
id: 017
title: Cycle-close review screen
status: open
blocked_by: [009, 010, 011]
---

## Scope

`CONTEXT.md` §11. Ends on the user's press (no notifications, no auto-close, no cycle-close nudge — `CONTEXT.md` §13/§17 explicitly reverses `docs/oneDoc.md`'s reintroduction of notifications; this ticket must not add one).

**Shown, not asked:** the falls-and-recoveries timeline for the cycle with tag frequencies, assembled from `fall_offs` — read-only, confirms what was already tracked.

**Asked — four inputs:**
1. Per goal (per `focus_areas`/`commitments`): hit/partial/missed.
2. Per goal: keep/drop for next cycle.
3. Confirm or correct the fall/tag summary — **including correcting a tag's `availability`/`motivation` classification** (ticket 004's tags, corrected here per `CONTEXT.md` §9a/§11).
4. One freeform box: "what should next cycle do differently?"

Write all four into `cycles.review` per the shape in `docs/SPEC.md` §2f. Set `cycles.status = 'closed'`.

## Definition of done

- The shown timeline correctly aggregates this cycle's `fall_offs` by tag, with no user input required to produce it.
- Submitting the review writes a `cycles.review` jsonb matching `docs/SPEC.md` §2f exactly, and sets `status: 'closed'`.
- Correcting a tag's classification in this screen updates the `tags` row (not just the review blob) — future fall-offs using that tag must see the corrected classification.
- A closed cycle can no longer be edited (no write path back to `draft`/`active` exists for it).

## Notes
