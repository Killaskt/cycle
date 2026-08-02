---
id: 016
title: Disinterest tag — minimum exposure gate before REMOVE
status: open
blocked_by: [004, 012]
---

## Scope

`CONTEXT.md` §9a: the `disinterest` tag cannot trigger `REMOVE` before **3 completed sessions** of that commitment (locked number). Before that threshold, any action that would otherwise be `REMOVE` because of a `disinterest`-tagged fall downgrades to `REDUCE_FREQUENCY` or `MOVE` instead. After 3 completed sessions, `REMOVE` is allowed normally.

This overrides ticket 013's "3rd fall on same slot → REMOVE" specifically when the fall-off history for that slot is tagged `disinterest` and the commitment has fewer than 3 completions.

## Definition of done

- A 3rd-fall-same-slot tagged `disinterest`, with fewer than 3 prior completions on that commitment, produces `REDUCE_FREQUENCY` or `MOVE` (pick one, document the choice), not `REMOVE`.
- The identical scenario with 3+ prior completions on that commitment allows `REMOVE` normally.
- A 3rd fall tagged with anything other than `disinterest` is unaffected by this gate (ticket 013's plain `REMOVE` behavior still applies).

## Notes
