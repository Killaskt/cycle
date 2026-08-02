---
id: 006
title: Intake screen
status: open
blocked_by: [001, 002]
---

## Scope

`CONTEXT.md` §4. Fields: wake time, normal-day description (freeform, stored on `cycles.normal_day_notes`), timeframe (`cycles.timeframe_days`), and per focus area: name, `target_freq`, `target_dur`, `current_freq`, `current_dur`. Record `intake_order` per focus area in entry order (needed by ticket 003's tie-break rule).

Submitting intake creates one `cycles` row (`status: 'draft'`) and its `focus_areas` rows. Does **not** call `generate` — that's ticket 008.

Not a full interview — no fields beyond what's listed here. Validate: frequencies/durations are non-negative integers; at least one focus area.

## Definition of done

- Component test: valid submission creates exactly one `cycles` row with `status: 'draft'` and the correct number of `focus_areas` rows, `intake_order` matching entry sequence.
- Validation test: negative or missing frequency/duration is rejected before submission; zero focus areas is rejected.
- Turtle asset: use `src/assets/turtle/turtle-icon.svg` if a mascot touchpoint is wanted on this screen — not required, this screen isn't in the mascot asset list (`docs/MASCOT-ASSETS.md`).

## Notes
