---
id: 008
title: System (locked) screen — generate, accept, regenerate-once
status: open
blocked_by: [005, 006, 007]
---

## Scope

`CONTEXT.md` §7, §6 (regenerate-once). After intake (ticket 006), call the `generate` Edge Function (ticket 005), show the resulting plan read-only. Two actions:

- **Accept**: `cycles.status` `draft` → `active`, set `started_at` = now, call slot materialization (ticket 007).
- **Regenerate** (only while `status == 'draft'` and `regenerate_used == false`): re-call `generate`, replace the `commitments` rows, set `regenerate_used = true`. Disabled once used or once the cycle is active — `CONTEXT.md` §6: "once the cycle begins, gone."

No editing UI of any kind — read-only plan display only.

## Definition of done

- Accept transitions status correctly and triggers slot materialization exactly once.
- Regenerate before accept: same formula-derived `freq`/`dur` numbers as the first generation (same inputs), but naming/placement may differ (model layer, exercised via fixture provider) — assert the deterministic parts are identical and `regenerate_used` flips to `true`.
- Regenerate attempted a second time, or attempted after `status == 'active'`, is rejected.

## Notes
