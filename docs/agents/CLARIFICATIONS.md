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

## [context-doc] Exact field split between 1st and 2nd fall-off — 2026-08-02 09:00
**Question:** `docs/oneDoc.md` §6's escalation table says the 1st fall captures "tag + what happened," while its "what the survey asks" section separately lists four fields (auto-filled slot, freeform, tag, mood) without stating which occurrence(s) they apply to.
**Assumption made:** 1st fall = auto-filled slot (silent) + tag + freeform "what happened" only — no mood tap, no agent follow-up question, no plan change. Mood tap and the possible one agent follow-up question apply starting at the 2nd fall (the Amendment), alongside the same tag + freeform fields. Reasoning: the escalation table explicitly says "no survey" for the 1st fall, and reserves the fuller field set for when it actually needs to inform an amendment decision.
**Confidence:** medium
**Status:** open

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

## [003] Ceiling back-off granularity ("back off ... by one step") — 2026-08-02 08:20
**Question:** CONTEXT.md §5's back-off loop says "back off the goal contributing the most added minutes, by one step" but a goal has two independent deltas — a frequency step (`step`, 1-2) and a duration step (`dur_step`, 5-15 minutes) — and the spec doesn't say which one "one step" refers to when a goal has both, or what unit governs retreating the duration side.
**Assumption made:** Per selected goal, retreat the frequency step to 0 one unit at a time first; only once a goal's frequency step is fully retreated does its duration step begin retreating, one minute at a time. This is deterministic, reversible, and guarantees the loop terminates with `load <= ceiling`: once every goal's `freqStep` and `durStep` are both 0, `load == Σ(currentFreq × currentDur)`, which is always `<= ceiling` since `ceiling` is that same sum × 1.15. Implemented in `src/lib/generationMath.ts` (`applyCeiling`).
**Confidence:** medium
**Status:** open

## [004] Fuzzy-match algorithm and similarity threshold for tag reuse — 2026-08-02 08:40
**Question:** CONTEXT.md §9a and the ticket both say new tag entries are "fuzzy-matched against existing tags to resist vocabulary fragmentation," with "tired" vs "tierd" as the DoD's worked example — but neither names an algorithm or a similarity threshold.
**Assumption made:** Optimal string alignment distance (Levenshtein plus adjacent-transposition as a single edit, so "tired"→"tierd" costs 1 edit, not 2) normalized to a 0-1 similarity (`1 - distance / maxLength`), matched at `>= 0.7`. Reasoning: transposition is the actual shape of the worked example's typo, so a distance metric blind to it would need a looser threshold that risks collapsing genuinely distinct short tags; OSA distance stays conservative (single-edit typos match, unrelated short words don't) while still resolving the example case comfortably above threshold (0.8). Implemented in `src/lib/tagRepository.ts` (`labelsFuzzyMatch`/`editDistance`).
**Confidence:** medium
**Status:** open
