# Clarifications Log

Where any agent working this build — `/implement`, `/tdd`, or otherwise — writes down a real ambiguity the spec doesn't resolve, so the questions are visible in one place instead of buried in commit messages or silently guessed away.

## Rule

This file is for genuine spec gaps, not test failures.

- **Tests won't go green?** That's the existing retry-cap rule: 2 failed attempts → mark the ticket `blocked: needs-human` with notes, move to the next unblocked ticket. Log it there, not here.
- **Spec is simply silent on something, and a defensible default has to be picked to keep moving?** That's this file.

Never block the loop waiting for an answer — nobody's watching it overnight. Instead:

1. Make the most conservative, most reversible assumption available.
2. Log it here before moving on.
3. Keep building against that assumption for the rest of the ticket.
4. If the assumption turns out wrong later, it's a follow-up ticket, not a fire.

## Entry format

```
## [ticket-id] Short question — YYYY-MM-DD HH:MM
**Question:** ...
**Assumption made:** ...
**Confidence:** low | medium
**Status:** open
```

Flip `Status` to `resolved` (one-line resolution note) once it's been reviewed — either by editing this file directly or telling the next agent to fold in the change.

---

## Log

## [018] Between-cycle regeneration: exact per-band target numbers, "actually completed" for duration, ceiling wiring, and load_factor write timing — 2026-08-02 19:40
**Question:** CONTEXT.md §6 gives the band responses in prose ("advance one more step toward target," "hold — same plan," "retreat halfway toward what was actually completed") and the ticket says these "need concrete target numbers... derive these deterministically from the prior cycle's `commitments.freq`/`dur` and the band" — but neither source specifies (a) whether `target_freq`/`target_dur` for the `advance` band should stay the original intake target or become some newly-computed number, (b) what "what was actually completed" means numerically for `dur`, since the schema has no per-slot actual-duration signal — only a binary `completed`/not per slot (docs/SPEC.md §2 `slots.status`) — so there's no direct "completed minutes for this one goal" figure to retreat toward, (c) whether the cycle-2+ ceiling override should be wired through the real `generate` Edge Function contract or only exist as an isolated client-side/pure-math concern, and (d) whether `load_factor.last_cycle_completed_minutes` should be written at cycle-close or next-cycle-start (the ticket explicitly leaves this open).
**Assumption made:**
(a) `advance`: new cycle's `currentFreq/Dur = priorPlanFreq/Dur` (prior `commitments.freq`/`dur`), `targetFreq/Dur` = the focus area's **original** intake target, left unchanged — so the very next `generate` call's own `computeStep`/`computeDurationStep` (ticket 003, reused not reimplemented) naturally takes one more delta step from where the prior cycle left off. `hold`: both `current` and `target` pinned to `priorPlanFreq/Dur`, forcing a guaranteed zero-gap so no downstream rounding can drift it. `retreat_halfway`: "actually completed" is derived as `completionRate * priorPlanFreq/Dur` (the same rate `completionBand` used to pick the band) — averaged with the prior plan and rounded — then both `current` and `target` pinned to that number, same technique as `hold`. Implemented in `src/lib/generationMath.ts`'s `computeNextCycleGoalPlan`.
(b) Same rate-based interpolation as freq, applied to `dur` — there is no independent "actual completed duration" signal in the schema (a completed slot only proves the session happened, not how long it ran), so the per-goal completion rate is treated as the best available proxy for both axes rather than inventing a new, unmeasured duration-specific signal.
(c) Wired through the real pipeline: `applyCeiling` (`src/lib/generationMath.ts`) gained an optional `ceilingBasisMinutes` parameter (omitted = cycle-1 stated-current default, unchanged); the `generate` Edge Function's request contract (`docs/SPEC.md` §3, `supabase/functions/generate/types.ts`) gained an additive optional `ceiling_basis_minutes` field threaded through `index.ts` and `invariants.ts`; `src/lib/systemPlan.ts`'s `buildGenerateRequestBody` sets it from `load_factor.last_cycle_completed_minutes` whenever that row exists for the user (`null` on cycle 1 omits the field entirely, so cycle 1 is provably unaffected). Chosen over a purely isolated pure-math test because the ticket's own DoD frames this as "the first ticket to actually read" the cross-cycle data — an override that never reaches the real generation call wouldn't satisfy that.
(d) Cycle-close, inside `src/lib/cycleReview.ts`'s `submitCycleReview` (calls `src/lib/loadFactor.ts`'s `updateLoadFactorFromCycle` right before the closing `cycles` update, so a failure there aborts the whole submission rather than closing with a silently-skipped write). Reasoning: cycle-close is the one point every closed cycle passes through exactly once; "next cycle start" isn't yet a well-defined single event (no ticket builds that screen), so deferring the write to it risks it being delayed indefinitely or skipped for a user who never starts a next cycle.
**Confidence:** medium
**Status:** open

## [016] Which tag counts as "the relevant tag" for the disinterest gate, and MOVE vs REDUCE_FREQUENCY as the downgrade target — 2026-08-02 18:10
**Question:** `CONTEXT.md` §9a says the `disinterest` tag "cannot trigger REMOVE before 3 completed sessions... downgrades to REDUCE_FREQUENCY or MOVE instead," but a 3rd-fall's slot has up to 3 fall_offs rows with potentially different tags (1st/2nd/3rd), and the ticket doesn't say which one's tag is checked, nor pick between the two listed downgrade targets.
**Assumption made:** "The relevant tag" = the 2nd fall's tag, per the ticket's own instruction to reuse ticket 013's reasoning (CLARIFICATIONS.md [013] "Which tag→action mapping gets downgraded on a 3rd fall") for consistency — that's the tag/action pair the now-failing amendment traces back to; the 3rd fall's own tag hasn't yet been associated with any action. Downgrade target: `MOVE`, not `REDUCE_FREQUENCY` — `applyAction`'s switch (`src/lib/amendment.ts`) has no `REDUCE_FREQUENCY` case yet (ticket 014 will likely add one for cycle-wide overload) and `MOVE` alone satisfies this ticket's DoD, so this avoids touching that switch/case list and any collision risk with 014. Implemented as `applyDisinterestExposureGate` in `src/lib/amendment.ts`, reusing the existing `getSecondFallOffTag` helper (refactored out of ticket 013's `downgradeTagActionLearning`) and `pickMoveTarget`. Applied in both `proposeAmendmentForFallOff` (fresh proposals) and `rejectAmendmentWithRevision` (revisions of a rejected proposal), so neither path bypasses the gate.
**Confidence:** medium
**Status:** open

## [013] How REMOVE actually manifests in the DB — commitments has no deactivate mechanism in the existing schema — 2026-08-02 17:20
**Question:** `docs/SPEC.md`'s `commitments` table has no active/removed flag, and a hard `delete from commitments` cascades to `slots` (`on delete cascade`) which then hits `fall_offs.slot_id`'s un-cascaded FK to `slots` and fails for any commitment with fall-off history — which every 3rd-fall `REMOVE` always has (the 3rd fall itself just got inserted). Neither `CONTEXT.md` nor `docs/SPEC.md` specifies how `REMOVE` should be represented at the schema level.
**Assumption made:** Added a new migration (`supabase/migrations/20260802020000_commitments_removed_at.sql`) adding a nullable `commitments.removed_at timestamptz` column (null = active). `applyAction`'s `REMOVE` case sets it and deletes the commitment's still-`pending` slots only — `completed`/`fell_off`/`excused` slots (and all `fall_offs`/`amendments` rows) are left untouched, preserving exactly the retention data `CONTEXT.md` §1/§16 calls a one-way-door decision. Also added the column to `docs/SPEC.md` and `src/test/integration/schema.test.ts`'s expected columns. Reasoning: most conservative/reversible option available — a hard delete is actively destructive and unrecoverable, while a new nullable column is additive and changes no existing row's meaning. Future tickets (014 cycle-wide overload's "every active commitment", 018 regeneration) should read `removed_at is null` as "still active."
**Confidence:** medium
**Status:** open

## [013] Which tag→action mapping gets downgraded on a 3rd fall — 2026-08-02 17:25
**Question:** `CONTEXT.md` §9a says the 3rd fall should "downgrade that tag→action mapping's confidence," but a slot's fall-off history by that point has up to 3 different tags (1st/2nd/3rd fall, possibly all different), and the `learnings` table's `action` dimension isn't 1:1 with any single `fall_offs` row — it only exists on the `amendments` row.
**Assumption made:** Downgrade `(user_id, tag_id, action)` where `tag_id` is the *2nd fall's* tag (the fall whose tag caused the amendment now proven wrong) and `action` is whatever was actually applied from that 2nd-fall amendment (`amendments.action`, or `.revised_action` if the user rejected-and-revised it) — read from the DB rather than hardcoded to `'MOVE'`, even though ticket 012's deterministic rule only ever produces `MOVE` at occurrence 2 today. Implemented in `src/lib/amendment.ts`'s `downgradeTagActionLearning`. Reasoning: "that mapping" most naturally refers to the tag/action pair that produced the amendment which just failed a 3rd time — the 3rd fall's own tag hasn't yet been associated with any action, so there's nothing to downgrade for it.
**Confidence:** low
**Status:** open

## [013] Downgrade magnitude and timing — 2026-08-02 17:25
**Question:** The ticket says "exact magnitude is an implementation choice — document whatever you pick," and `CONTEXT.md` doesn't say whether the downgrade happens when the `REMOVE` proposal is created or only once the user accepts it.
**Assumption made:** Fixed absolute step of `-0.20`, floored at 0, applied via upsert (creating the `learnings` row at the schema default `0.50` minus the step if none exists yet, and incrementing `sample_size`). Applied at proposal time (inside `proposeAmendmentForFallOff`, unconditionally once the 3rd-fall `REMOVE` proposal is computed) — not gated behind the user accepting/rejecting that `REMOVE` proposal. Reasoning: "this tag→action mapping's prior application already failed" is a fact independent of what the user decides to do about the *current* `REMOVE` proposal, analogous to how ticket 010's reliability-map triggers react to raw `fall_offs`/`completions` inserts regardless of any downstream amendment outcome.
**Confidence:** medium
**Status:** open

## [012] Rejected amendment's revision: apply immediately, or leave pending for a further round? — 2026-08-02 16:40
**Question:** ADR-0007 describes reject-with-reason as producing "one revision," but neither `CONTEXT.md` §9b nor `docs/SPEC.md` §4 says whether that revision is applied to the commitment right away, or left as a second pending proposal the user must separately accept/reject (with MVP having no further UI round-trip specified for re-offering it).
**Assumption made:** `rejectAmendmentWithRevision` (`src/lib/amendment.ts`) applies the revision immediately — same `applyAction` "code disposes" path `acceptAmendment` uses — rather than leaving it pending. Reasoning: MVP's deterministic rule always produces a valid, guardrail-respecting `MOVE` (never a proposal that could reasonably need re-rejecting), so a second pending round adds UI/state surface with no real decision left to make; a future live-agent revision could still choose to leave its own output pending, this doesn't box that in — it only decides the current deterministic rule's behavior.
**Confidence:** medium
**Status:** open

## [context-doc] Exact field split between 1st and 2nd fall-off — 2026-08-02 09:00
**Question:** `docs/oneDoc.md` §6's escalation table says the 1st fall captures "tag + what happened," while its "what the survey asks" section separately lists four fields (auto-filled slot, freeform, tag, mood) without stating which occurrence(s) they apply to.
**Assumption made:** 1st fall = auto-filled slot (silent) + tag + freeform "what happened" only — no mood tap, no agent follow-up question, no plan change. Mood tap and the possible one agent follow-up question apply starting at the 2nd fall (the Amendment), alongside the same tag + freeform fields. Reasoning: the escalation table explicitly says "no survey" for the 1st fall, and reserves the fuller field set for when it actually needs to inform an amendment decision.
**Confidence:** medium
**Status:** resolved — ticket 012 (`src/lib/fallOff.ts`, extended) confirmed the 2nd-fall half: `mood` is now required (throws if missing/blank) exactly at `occurrence_in_slot === 2`, and an `amendments` row (a `MOVE` proposal) is created at that same occurrence via `proposeAmendmentForFallOff`. The "at most one agent-chosen follow-up question" piece of the 2nd-fall field set was deliberately **not** built — it requires pattern-detection over prior fall-off history and is model-shaped, out of scope for the deterministic MVP amendment path (ADR-0007). `agent_followup_question`/`agent_followup_answer` stay `null` at every occurrence until a future ticket adds that capability. Both halves of the original question are now verified in code and tests.

## [context-doc] Cycle-wide overload response when falls are spread evenly (volume problem) — 2026-08-02 09:00
**Question:** The source conversation floated two alternative responses to a volume-type cycle-wide overload trigger — "apply REDUCE_FREQUENCY across the board" or "drop the lowest-completion goal entirely" — without picking between them.
**Assumption made:** `REDUCE_FREQUENCY` across the board. Reasoning: less destructive than removing an entire goal, consistent with the net-load-down-or-flat guardrail (ADR-0004), and it reserves full goal removal for the more targeted per-slot 3rd-fall path (CONTEXT.md §9a) rather than duplicating that behavior at the cycle-wide level.
**Confidence:** medium
**Status:** open

## [context-doc] UX for a second cycle-wide overload trigger in one cycle — 2026-08-02 09:00
**Question:** The source conversation states a cycle-wide overload response "fires at most once per cycle... if it would fire twice, that's not overload anymore, that's a cycle that should end early and be regenerated" — but doesn't specify the actual flow: is early termination automatic, does the user get notified first, does it count as anything in the fall-off logs, and does "regenerated" mean a full re-run of intake or just re-generation from existing intake data.
**Assumption made:** None made — this path is rare enough (would require overload to fire, get a response, and then trigger again in the same cycle) that it's being left unimplemented for MVP. If the trigger condition is met a second time in one cycle, apply the same volume/placement response as the first time rather than any early-termination flow, and log that this happened for a human to review.
**Confidence:** low
**Status:** open

## [007] Blocked-date handling: skip vs. reschedule, and per-commitment vs. cycle-wide — 2026-08-02 09:30
**Question:** The ticket says to "skip/reschedule an affected date rather than double-booking it" without picking one, and `blocked_windows.affected_slot_id` is nullable ("something came up" may or may not target a specific slot) but at materialization time no slots exist yet for the cycle to reference, so it's unclear whether a blocked date should exclude only the commitment tied to a specific slot or all commitments scheduling that day.
**Assumption made:** (1) Skip, not reschedule-to-a-specific-makeup-day: a blocked date is removed from that week's eligible-day pool *before* `freq` days are picked, so materialization opportunistically fills `freq` from the remaining eligible days that week if there are enough, but never invents a rule for *which* specific day to bump a displaced occurrence to. (2) Treat every `blocked_windows` row for the cycle as blocking that date for *all* commitments (cycle-wide), not just one — since `affected_slot_id` can't yet point at anything real pre-materialization, the only information available is the date itself. Reasoning: both are the more conservative, simpler, fully reversible reading; a future ticket can add per-commitment targeting once `affected_slot_id` is populated post-materialization.
**Confidence:** medium
**Status:** open

## [007] Slot materialization idempotency: reject vs. no-op — 2026-08-02 09:30
**Question:** DoD says "Re-running materialization for the same cycle is a no-op or explicitly rejected — pick one and assert it," without specifying which.
**Assumption made:** Explicitly rejected — `materializeCycleSlots` throws if any slot already exists for the cycle's commitments, rather than silently skipping. Reasoning: a silent no-op could mask a caller bug (e.g. calling it twice with different commitment data expecting an update) whereas a thrown error surfaces the double-call immediately; this is also the more conservative/reversible choice per the CLARIFICATIONS rule since callers can always catch-and-ignore if a no-op turns out to be preferred later.
**Confidence:** medium
**Status:** open

## [015] Excusing a non-pending slot — 2026-08-02 10:00
**Question:** The ticket says tapping "something came up" sets a slot's status to `excused`, but doesn't say what should happen if the slot is already `completed` or `fell_off` (e.g. the user taps it after already checking it off, or after it's already been logged as a fall).
**Assumption made:** `excuseSlot` throws if the target slot's status isn't `pending`, rather than silently overwriting an already-completed or already-fallen-off slot's status. Reasoning: `completed`/`fell_off` are terminal, already-logged outcomes (a completion row or a fall_off row may already exist referencing that slot); silently flipping the slot's status to `excused` after the fact would desync the slot's status from that history without deleting it, and would also retroactively "un-fall" a slot in a way that's indistinguishable from data corruption. Most conservative/reversible: the caller can decide what to do (e.g. disable the button in the UI) rather than the write path guessing.
**Confidence:** medium
**Status:** open

## [005] `blocked_windows` collision check has no time-of-day to compare against — 2026-08-02 12:45
**Question:** `docs/SPEC.md` §3's `generate` request shape gives each `blocked_windows` entry only a bare `date` (e.g. `{ "date": "2026-08-05" }`), and the request itself carries no cycle start date or timeframe — so a date can't be mapped to a specific weekday occurrence, and there's no time-of-day at all to compare against a candidate `bucket`. Step 3's "if it collides with a blocked_window... reassign" can't be evaluated as a literal point-in-time overlap with the data given.
**Assumption made:** Derive `day_type` (weekday/weekend) from each blocked date and treat every bucket of that day_type as blocked for bucket-resolution purposes (`supabase/functions/generate/bucketOrder.ts` — `blockedBucketSet`). This over-blocks an entire day_type from a single blocked date, but errs toward "never place into a period with a known disruption" rather than risking a real collision, and is a one-line loosening later once `blocked_windows` carry real time-of-day info (or once slot materialization, ticket 007, gives per-date placement a place to do the precise check instead).
**Confidence:** low
**Status:** open

## [005] `time_of_day` clock boundaries — 2026-08-02 12:45
**Question:** `docs/SPEC.md` §1 defines the six `time_of_day` enum values (`early_morning, morning, midday, afternoon, evening, night`) but never states the clock-hour boundaries between them, needed to map a `wake_time` string to a bucket for "wake-time order" scanning (CONTEXT.md §12 fallback rule).
**Assumption made:** Six roughly-even bands: early_morning 05:00, morning 08:00, midday 11:00, afternoon 14:00, evening 17:00, night 20:00 (each running until the next bound). Implemented in `supabase/functions/generate/bucketOrder.ts` (`timeOfDayForMinutes`).
**Confidence:** medium
**Status:** open

## [005] Day-type scan priority in the fixed bucket order — 2026-08-02 12:45
**Question:** CONTEXT.md §12's fallback rule says "scan buckets in a fixed order starting after wake time" but doesn't say whether weekday or weekend buckets are scanned first for a given time-of-day.
**Assumption made:** Weekday buckets before weekend, for the same time-of-day-from-wake-time position (`supabase/functions/generate/bucketOrder.ts` — `wakeOrderedBuckets`). Arbitrary but deterministic; MVP intake doesn't collect a weekday/weekend preference, so there's no stronger signal to sequence by.
**Confidence:** low
**Status:** open

## [005] Reliability-based bucket reassignment threshold — 2026-08-02 12:45
**Question:** `docs/SPEC.md` §3 step 3 says a bucket may be reassigned if the reliability map marks it "unreliable relative to alternatives," without a numeric threshold for "unreliable."
**Assumption made:** Only reassign when a trusted (`scheduled >= 3`) alternative bucket's completion rate is at least 20 percentage points higher than the model's preferred bucket's trusted rate (`UNRELIABLE_GAP` in `supabase/functions/generate/bucketOrder.ts`). Untrusted buckets (< 3 observations, including the always-empty cycle-1 `reliability_map`) never trigger reassignment — they read neutral per CONTEXT.md §9.
**Confidence:** low
**Status:** open

## [009] Un-checking a completed slot — 2026-08-02 13:45
**Question:** The ticket says "decide and document whether un-checking is supported — the spec doesn't dictate undo behavior."
**Assumption made:** Un-checking is not supported. No `uncompleteSlot` function exists in `src/lib/today.ts`; `completeSlot` is idempotent (no-op) on an already-completed slot but there is no reverse operation. Reasoning: `completions` inserts are the reliability map's primary continuously-logged signal (CONTEXT.md §8), and ticket 010's DB triggers (`supabase/migrations/20260802010000_reliability_map_triggers.sql`) only ever increment `reliability_map.completions`/`.scheduled` on insert — there is no compensating decrement trigger. Supporting undo now would require either deleting a `completions` row a trigger has already reacted to (silently overcounting `reliability_map` forever after) or adding a new decrement trigger, neither of which any ticket has specified. Most conservative/reversible: ship check-only; add uncheck plus its trigger-side decrement as a follow-up ticket if product wants it.
**Confidence:** medium
**Status:** open

## [005] Live model provider/API for `MODEL_PROVIDER=live` — 2026-08-02 12:45
**Question:** Neither CONTEXT.md nor `docs/SPEC.md` names which model API the live provider should call.
**Assumption made:** Anthropic's Messages API (`https://api.anthropic.com/v1/messages`), key from `ANTHROPIC_API_KEY`, model name overridable via `MODEL_NAME` (default `claude-3-5-haiku-latest`), temperature 0 — `supabase/functions/generate/provider.ts` (`liveProvider`). Untested in this ticket (no live key in this environment; DoD is fixture-only per `.claude/skills/local-supabase-stack/SKILL.md`). The seam shape (`Provider = (input) => Promise<unknown>`, validated uniformly by `validate.ts`) means swapping providers later needs no change outside this one function.
**Confidence:** low
**Status:** open

## [003] Ceiling back-off granularity ("back off ... by one step") — 2026-08-02 08:20
**Question:** CONTEXT.md §5's back-off loop says "back off the goal contributing the most added minutes, by one step" but a goal has two independent deltas — a frequency step (`step`, 1-2) and a duration step (`dur_step`, 5-15 minutes) — and the spec doesn't say which one "one step" refers to when a goal has both, or what unit governs retreating the duration side.
**Assumption made:** Per selected goal, retreat the frequency step to 0 one unit at a time first; only once a goal's frequency step is fully retreated does its duration step begin retreating, one minute at a time. This is deterministic, reversible, and guarantees the loop terminates with `load <= ceiling`: once every goal's `freqStep` and `durStep` are both 0, `load == Σ(currentFreq × currentDur)`, which is always `<= ceiling` since `ceiling` is that same sum × 1.15. Implemented in `src/lib/generationMath.ts` (`applyCeiling`).
**Confidence:** medium
**Status:** open

## [008] Double-Accept / double-Regenerate handling not specified beyond materializeCycleSlots' own throw — 2026-08-02 13:20
**Question:** The ticket says `materializeCycleSlots` throws on a second call and that error must not be swallowed on "a legitimate second Accept," but neither `CONTEXT.md` §7 nor `docs/SPEC.md` says whether the `cycles.status`/`started_at` write that Accept performs *before* calling `materializeCycleSlots` should itself be guarded against a second call, or write blindly every time. Blindly rewriting `started_at` on every Accept call would silently desync it from slot dates already materialized off the *first* call's `started_at`, before the second call even reaches `materializeCycleSlots`'s own rejection — so the two possible readings produce different (and for the blind-write reading, actively harmful) behavior. Same question applies to `regenerateCommitments`'s `regenerate_used` flag flip.
**Assumption made:** `acceptCycle` (`src/lib/systemPlan.ts`) guards its `status`/`started_at` update with `.eq('status', 'draft')`, so a second call leaves `started_at` untouched and falls through to `materializeCycleSlots`, whose own "already materialized" throw is left uncaught — satisfying "don't swallow that error" without corrupting `started_at` first. `regenerateCommitments` similarly guards its `regenerate_used` flip with `.eq('status', 'draft').eq('regenerate_used', false)` and throws if that update matches zero rows. Reasoning: most conservative/reversible reading — no data (`started_at`, materialized slot dates) can end up inconsistent, and the required "don't swallow" behavior is preserved via the still-uncaught downstream throw.
**Confidence:** medium
**Status:** open

## [011] Does recording a fall-off write the slot's `status` to `'fell_off'`? — 2026-08-02 14:20
**Question:** Ticket 011's DoD only asserts `fall_offs` row shape and count behavior — it never mentions `slots.status`. But `docs/SPEC.md` §2's `slots.status` enum includes `'fell_off'`, and `today.ts`'s `completeSlot` already guards against (and `today.test.ts` already asserts against) a slot whose status is `'fell_off'` — so something has to be the writer of that value, and no other ticket (007 materialization, 009 Today, 015 excuseSlot) writes it either.
**Assumption made:** `recordFallOff` (`src/lib/fallOff.ts`) sets the slot's `status` to `'fell_off'` after inserting the `fall_offs` row, mirroring `completeSlot`/`excuseSlot` each flipping the slot's status as their own write's side effect. Unlike those two, `recordFallOff` does not guard on the slot's current status before writing — a 2nd/3rd fall-off on the same slot (tickets 012/013) must remain recordable even though a prior call already set `status: 'fell_off'`, since repeat recording on the same slot is the entire mechanism the escalation ladder depends on. Most conservative/reversible reading available: it only ever writes the one status value this ticket's own action logically corresponds to, never touches `completed`/`excused`/`pending` transitions owned by other modules, and doesn't invent a guard the DoD didn't ask for.
**Confidence:** medium
**Status:** open

## [017] Must `goals` cover every focus area, and is `freeform` required non-empty? — 2026-08-02 18:10
**Question:** `CONTEXT.md` §11 and `docs/SPEC.md` §2f list "per goal: hit/partial/missed" and "per goal: keep/drop" among the four asked inputs, and a freeform box, but neither says whether `submitCycleReview` should reject a submission missing a goal (or containing a stray `focus_area_id` from another cycle), nor whether the freeform box can be submitted blank.
**Assumption made:** `submitCycleReview` (`src/lib/cycleReview.ts`) throws unless `goals` contains exactly one entry per this cycle's `focus_areas` (no missing, no foreign `focus_area_id`, no duplicates), and throws on an empty/whitespace-only `freeform`. Reasoning: most conservative/reversible reading — "per goal" most naturally reads as *every* goal, not a caller-chosen subset, and every other required-freeform field already built in this codebase (`fall_offs.what_happened`, `amendments.rejection_reason`) is validated non-empty the same way, so this stays consistent with that established pattern rather than inventing a looser one. A future ticket can relax either check if product wants partial submissions.
**Confidence:** medium
**Status:** open

## [004] Fuzzy-match algorithm and similarity threshold for tag reuse — 2026-08-02 08:40
**Question:** CONTEXT.md §9a and the ticket both say new tag entries are "fuzzy-matched against existing tags to resist vocabulary fragmentation," with "tired" vs "tierd" as the DoD's worked example — but neither names an algorithm or a similarity threshold.
**Assumption made:** Optimal string alignment distance (Levenshtein plus adjacent-transposition as a single edit, so "tired"→"tierd" costs 1 edit, not 2) normalized to a 0-1 similarity (`1 - distance / maxLength`), matched at `>= 0.7`. Reasoning: transposition is the actual shape of the worked example's typo, so a distance metric blind to it would need a looser threshold that risks collapsing genuinely distinct short tags; OSA distance stays conservative (single-edit typos match, unrelated short words don't) while still resolving the example case comfortably above threshold (0.8). Implemented in `src/lib/tagRepository.ts` (`labelsFuzzyMatch`/`editDistance`).
**Confidence:** medium
**Status:** open
