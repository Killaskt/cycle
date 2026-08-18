# CONTEXT.md — Cycle (working name)

Read this before exploring or building anything in this repo. See `docs/adr/` for the reasoning behind the decisions marked **(ADR-000N)** below — read the ones that touch the area you're working in.

Source material: `docs/Summary.md` (original brief), `docs/oneDoc.md` (expanded design doc), and the grilling session that resolved the open questions in both (this document is that session's output).

## 1. Thesis

A system generator. The user names focus areas and a timeframe; the app generates a system — schedule plus goals for that window — and locks it. When the user falls off, the app amends the system, not the person.

**Contrarian bet:** take system design out of the user's hands. Constraint is the product — the user's only job is to pick a path and stick to it for the timeframe.

**Retention bet:** value accrues in the record — what was committed to, what actually happened, where and how often the user fell off, what amendment worked. The fall-off history is what makes generation #7 better than generation #1.

**What's actually being tested:** not whether the app can generate a plan (it can), but whether persisted learnings from fall-offs measurably improve the *next* cycle's generation, and whether being nudged differently helps the user stay on.

## 2. Vocabulary

- **Cycle** — one timeframe: intake → locked system → daily use → close. The unit everything else happens inside.
- **Focus area** — a category the user names at intake ("running," "Spanish"). Quantified with `target_freq`, `target_dur`, `current_freq`, `current_dur`.
- **Commitment** — the generated, schedulable thing a focus area becomes (name, session shape, placement). Exactly one commitment per focus area in MVP (ADR-0005).
- **Slot** — a specific scheduled instance of a commitment on a specific day/time.
- **Fall-off** — the user reporting they didn't do a slot. Tracked per-slot *and* cycle-wide (ADR-0008) — two different counters, two different diagnoses.
- **Amendment** — the code-executed change to a locked plan triggered by a fall-off. The *only* way a locked plan changes (ADR-0006).
- **Action / ActionType** — the bounded enum an amendment executes: `NONE, MOVE, SHORTEN, REDUCE_FREQUENCY, REALLOCATE, EASE_NEXT_DAY, REMOVE, UNHANDLED` (ADR-0004).
- **Downscope** — the 3rd-fall-on-same-slot escalation: `REMOVE`, or the cycle-wide overload response.
- **Learnings store** — the only thing that persists across cycles within a user: tag→action confidence mappings, the reliability map, observed load factor.
- **Reliability map** — completion rate by (weekday/weekend × 6 time-of-day buckets), 12 buckets total, ≥3 observations before a bucket is trusted.
- **Load factor / ceiling** — the generator's cap on total planned time, derived from stated capacity (cycle 1) or measured completion (cycle 2+).
- **BLOCKED / PROTECTED windows** — time the generator may not schedule into. MVP only ever writes here via the "something came up" tap; the recurring/calendar-fed version is post-MVP, but the schema exists now (ADR-0006).

## 3. Two loops

| Loop | Trigger | Cadence | Purpose |
|---|---|---|---|
| **Fast** | Fall-off | Within a cycle | Recover + amend |
| **Slow** | Cycle ends | Between cycles | Review + regenerate from learnings |

Build the fast loop first — it's daily, and it's what's testable tonight. The slow loop's generation code and learnings-store writes must still exist from cycle 1, even though "does cycle 2 differ because of cycle 1" can't be observed until a real two-week cycle actually runs.

## 4. Intake

Captures, per focus area: `target_freq`, `target_dur` (minutes/session), `current_freq`, `current_dur` — both sides of the gap are user-stated numbers, never generator-invented defaults (ADR unnecessary — this was a direct thesis-consistency call: the app removes the *scheduling* decision, not the *what-I-want* decision). Plus wake time and a normal-day description for scheduling context, and the timeframe.

## 5. Generation (Cycle 1)

All formulas are deterministic. The model is only ever asked a narrow question (§8) — it never computes these numbers.

```
gap        = target_freq - current_freq
step       = gap > 0 ? clamp(round(0.25 * gap), 1, 2) : 0     // 0 guard: never advance past/away from a met target
dur_gap    = target_dur - current_dur
dur_step   = dur_gap > 0 ? clamp(round(0.25 * dur_gap), 5, 15) : 0   // minutes, same guard

plan_freq  = current_freq + step
plan_dur   = current_dur + dur_step

load       = Σ(plan_freq × plan_dur)
ceiling    = Σ(current_freq × current_dur) × 1.15    // cycle 1: stated current
while load > ceiling:
    back off the goal contributing the most *added* minutes, by one step
    // tie-break: intake entry order, LAST-entered goal backed off first
    // (arbitrary but deterministic and defensible — last-entered is what
    // the user was least sure about)
```

## 6. Between-cycle regeneration (cycle 2+)

Evaluated **per goal**, not aggregated across the cycle:

| Completion rate | Response |
|---|---|
| ≥ 90% | Advance one more step toward target |
| 60–89% | Hold — same plan |
| < 60% | Retreat halfway toward what was actually completed |

Ceiling for cycle N+1 = actual minutes completed in cycle N × 1.15. This is the load factor doing real work — capacity becomes measured, not claimed.

**Regenerate-once** is only available before the cycle starts (before day 1's first scheduled item). Once the cycle begins, it's locked, full stop. Same inputs produce identical formula outputs on a pre-start regenerate — only the model-driven naming/placement re-rolls.

**Counter reset:** both per-slot and cycle-wide fall counters reset at the start of every new cycle. They're within-cycle mechanics. Only the learnings store persists across cycles.

## 7. The system (locked)

One generated schedule + goals, read-only. Accept, or regenerate-once (pre-start only, §6). No editing, no re-optimizing mid-cycle.

**The boundary:** the user can edit reality; the user cannot edit the plan (ADR-0006). New external constraints (a class, a trip) get *reported*; the app amends in response. MVP only supports the lightest version of reporting — see §10.

## 8. Today

One view: what today asks of you. Check off or don't. **Completions are logged continuously** — slot + timestamp, every check-off, not just failures. Without this the reliability map only ever learns what to avoid, never what to repeat.

## 9. I Fell Off — the fall-off map

Counters are **per slot** (drives the ladder below) and **separately, cycle-wide** (drives overload detection, §9c) — same underlying events, two different diagnoses. Missing five different slots once each looks like nothing to a per-slot counter and looks like drowning to a cycle-wide one; three fails on one slot is the reverse. Neither counter alone sees both failure modes.

### 9a. Per-slot escalation ladder

| Fall (same slot) | Captures | Response |
|---|---|---|
| **1st** | Slot (auto-filled), tag, freeform "what happened" | Reassurance copy ("back on"). No mood tap. No plan change. |
| **2nd** | Slot, tag, freeform, **+ mood tap**, + at most one agent-chosen follow-up question (only if a hypothesis is worth testing — e.g. 3 morning falls tagged "tired" earns *"what time have you been getting to sleep?"*, once, disappears once resolved) | **The Amendment** (§9b) |
| **3rd**, same slot, post-amendment | — | The amendment was wrong. Escalate to `REMOVE`/restructure. Downgrade that `tag → action` mapping's confidence for this user. |

See `CLARIFICATIONS.md` — the exact 1st-vs-2nd field split above is my best reading of `docs/oneDoc.md` §6, not independently reconfirmed; flagged there.

**Tags:** user-created, reusable, 1–3 words, offered as a dropdown of existing tags + "something else," fuzzy-matched against existing tags to resist vocabulary fragmentation. **New tags only** get one extra binary tap at creation: "being busy/unavailable" or "not feeling it" (availability vs. motivation classification). Reused/fuzzy-matched tags inherit their existing classification. Correctable at cycle close, where tags are already being reviewed.

**Disinterest** is a legitimate tag. Cannot trigger `REMOVE` before **3 completed sessions** of that commitment (locked number). Before that, downgrades to `REDUCE_FREQUENCY` or `MOVE`.

### 9b. The Amendment — MVP is deterministic, contract is agent-shaped

No live model in the amendment path for MVP (ADR-0007). A deterministic rule stands in, but it **must** emit the exact same shape a real agent will later:

```
{ action, target, params, reasoning, confidence }
```

...rendered to the user, accepted or rejected-with-reason (→ one revision), both outcomes logged identically to how the real agent path will log. **A rule that silently applies `MOVE` without producing this shape captures zero training data** — the whole point is that cycle 1's amendment log is real signal the future agent-driven version learns from.

MVP default rule: **`MOVE`** at the 2nd fall (non-destructive, net-load-neutral, reversible, addresses the single most common real cause — wrong time of day). **`REMOVE`** at the 3rd fall, same slot.

### 9c. Cycle-wide overload

Trigger: falls ≥ **40% of scheduled items over a rolling 7 days**, minimum **4 falls** (can't fire in the first two days). Fires **at most once per cycle** — a second trigger means the cycle should end early and regenerate rather than absorb another global cut (exact UX for this not specified — flagged in `CLARIFICATIONS.md`).

Before responding, discriminate placement vs. volume:

- **≥60% of the cycle-wide falls land in one time bucket** → placement problem → global `MOVE` of that cluster, load untouched.
- **Spread roughly evenly across buckets** → volume problem → global `REDUCE_FREQUENCY` across the board. (`docs/oneDoc.md` also floated "drop the lowest-completion goal entirely" as an alternative response here and never picked between them — I assumed `REDUCE_FREQUENCY` as the less-destructive default, consistent with the net-load guardrail below; flagged in `CLARIFICATIONS.md`.)

### 9d. Action space — agent proposes, code disposes

```
enum ActionType {
  NONE, MOVE, SHORTEN, REDUCE_FREQUENCY, REALLOCATE,
  EASE_NEXT_DAY, REMOVE, UNHANDLED
}
```

Code validates any proposal (rule-based now, model-based later) against this enum → switch → apply → log. **Malformed or out-of-enum: retry once, then fall to `UNHANDLED`.** The enum is defined once in code; any future prompt's action menu is generated from it at runtime, never hand-maintained twice.

**`UNHANDLED`:** apply `NONE` (back on, plan untouched), write a dev report (reasoning + suggested new action + surrounding context — needs consent + stripping before it's anything but developer-facing, cheap now, painful to retrofit), surface nothing unusual to the user.

**Guardrails:**
- Net load can only go down or stay flat at a fall-off. `REALLOCATE` moves time between goals, never adds.
- `EASE_NEXT_DAY` must auto-expire (auto-restores after 24h) or every fall permanently erodes the plan.
- Reductions need a floor. Once a commitment can't shrink further without becoming meaningless, the only remaining option is `REMOVE` — say so honestly.

**Fixed default magnitudes** (used now as the rule's output, later as what a real agent falls back to unless it explicitly overrides — every override logged; repeated overrides in one direction is evidence the constant is wrong, tune from data):

```
SHORTEN           dur × 0.6, floored at 10 min
REDUCE_FREQUENCY  freq − 1, floored at 1
MOVE              no magnitude — slot placement only
EASE_NEXT_DAY     next day's load × 0.5, auto-restores after 24h
REALLOCATE        moves freed minutes, never adds
```

If `REDUCE_FREQUENCY` would hit 0, or `SHORTEN` would breach its floor: that action is unavailable, the only remaining move is `REMOVE`.

### 9e. Reassurance framing

No statistics — the real numbers don't exist in citable form, invented ones are a liability, and "87% of people fall off" tells the user quitting is normal. Frame the fall as anticipated: the system was built expecting this. Copy escalates in *directness*, not *interrogation*, as falls accumulate — effort goes down for the user as falls accumulate, not up. 1st: barely a screen. 2nd: "twice now — let's change the plan." 3rd: "the plan is wrong, we're cutting it down."

**Hard rule for all copy and all agent output** (testable, and the thing least affordable to drift during an unattended run): never attribute failure to character/discipline/willpower. Never imply the user should have tried harder. Describe the plan as wrong, never the person. Keep any follow-up question neutral and observational, never judgment-flavored (especially about food).

## 10. External events — "something came up"

MVP scope is exactly one thing: a second, lightweight path next to "I Fell Off" — no survey, no escalation, **does not increment either fall counter**, logged separately. Protects reliability-map data quality (an unavoidable absence isn't a fall; logging it as one poisons that time bucket's data with a false negative).

Everything else — recurring constraints, `BLOCKED` windows populated by more than this one tap, full life-sync, eventual calendar-feed integration — is explicitly **post-MVP**. The schema is still shaped for it now (ADR-0006): constraint/`BLOCKED` data lives in physically separate tables from commitment data, so a future calendar feed can only ever populate `BLOCKED`, never touch a commitment. Enforced by structure, not discipline.

## 11. Cycle close — the review

Ends on the user's press. **No notifications** — this whole feature is out of scope for MVP (§13), including any "nudge to start the next cycle."

**Shown, not asked:** the falls-and-recoveries timeline with tag frequencies (e.g. *"Tuesday 6:30am — fell off 3x, tagged 'sleep' twice."*). This confirms and closes out what was already tracked; it doesn't re-collect it.

**Asked — four inputs, three of them taps:**
1. Per goal: hit / partial / missed (their read — the gap between this and completion data is itself signal)
2. Per goal: keep or drop for next cycle
3. Confirm or correct the fall/tag summary — **this is also where a tag's motivation/control classification can be corrected**
4. One freeform box: "what should next cycle do differently?"

## 12. Generation's model call (the one live LLM call in MVP)

Generation, unlike the amendment path, **does** call a real model in MVP — deferring it would mean testing a two-week cycle whose plan was never actually generated, which guts the product's own premise (ADR-0005).

The split: **the model interprets, the code schedules.**

```
model output:  { focus_id, commitment_name, session_shape, preferred_bucket, rationale }
code:          applies delta math (§5), ceiling, blocked windows, reliability map → plan
```

The model turns a freeform focus area ("get better at Spanish") into a structured commitment shape. It never sets a number — frequency, duration, and final placement are 100% deterministic, computed around whatever the model returns.

**Fallback** (model retry-once still fails validation): `commitment_name` = the user's own focus-area text, verbatim. `session_shape` = one flat block sized to the formula's `plan_dur`. `preferred_bucket` = scan buckets in a fixed order starting after wake time, take the first not `BLOCKED`/`PROTECTED` — deterministic, uses real intake data, needs no reliability history.

**Testing (ADR-0004, extended to generation):**
1. Deterministic math tests — no model at all. The majority of generation logic (§5–6).
2. Fixture provider — canned, schema-valid model responses through the real Edge Function pipeline. Selected by env var; real provider in dev. Record real dev calls as fixtures over time; contract-test every fixture against the validator to catch schema drift without a live call.
3. Invariant tests, run in CI *and* at runtime as the actual validator: no commitment in a blocked window; total load ≤ ceiling; every focus area represented exactly once (1:1 focus↔commitment for MVP — schema is an array per `focus_id` with a validator asserting length 1, so relaxing this later is loosening an assertion, not a migration); every freq/duration within delta bounds.

Invalid output → retry once → deterministic fallback above. Generation must never fail to produce a plan, and must never produce an invalid one. Temperature 0 helps marginally; the invariants are the real guarantee. `supabase functions serve` runs this Edge Function locally, so the whole path is exercised locally tonight — no cloud deploy needed for the loop.

## 13. MVP scope

Four screens — **Intake → System (locked) → Today → I Fell Off** — plus the cycle-close review.

**In scope despite looking like it should be cut:** the learnings store and its use in the next generation. That's the hypothesis; it can't be cut without gutting the point of the build.

**Explicitly out for tonight:** streaks, social, analytics dashboards, plan editing (beyond code-executed amendments), accounts beyond auth, browsing UI for past cycles, **notifications** (including any cycle-close nudge — this reverses `docs/oneDoc.md`'s reintroduction of the idea; the original brief's exclusion stands), full life-sync (§10), a live model in the amendment path (§9b — MVP is deterministic behind the agent-shaped contract).

### Success tests
1. Does the fall-off button feel like relief or guilt? (One two-week self-run cycle.)
2. Does cycle #2's plan visibly differ from cycle #1's *because of* fall data — and does that difference help?

Test 1 is not machine-checkable — don't let it become a ticket's DoD. Test 2 is partially machine-checkable (assert next-cycle generation differs given seeded fall history) and partially the same manual judgment call as test 1.

## 14. Stack and infrastructure

- **Vite + React + TypeScript + Vitest + React Testing Library**, wrapped with **Capacitor** for native mobile packaging. Every ticket's DoD is headless — `tsc --noEmit` + `vitest` — no simulator/device build, no EAS build, ever, as part of a ticket's definition of done.
- **Supabase**, project `cycle` (already provisioned, `ACTIVE_HEALTHY`) for real use. **Local Supabase via Docker** for all dev/test — real Postgres, real RLS, not a throwaway second backend (ADR-0002). Tests never touch the hosted project; local test users are minted via the service-role key, no real magic-link email sent in automated tests.
- **Auth:** Supabase anonymous session on first launch, upgradeable to a permanent identity via magic-link linking (same `auth.uid()`, no schema/RLS change) — chosen specifically because a pure anonymous session is unrecoverable across an app reinstall, which is a real risk during an active build cycle (ADR-0003). The link/login screen only ever appears at first launch or after a wipe — never in daily use.
- **Issue tracker:** local markdown files for tonight's run (overrides this repo's existing GitHub-Issues config in `docs/agents/issue-tracker.md` — needs `/setup-matt-pocock-skills` to actually flip it).
- **Retry-cap rule** for the unattended loop: 2 failed attempts on a ticket → mark `blocked: needs-human`, move to the next unblocked ticket.
- **`docs/agents/CLARIFICATIONS.md`** — standing log for genuine spec gaps discovered mid-build (not test failures — see that file's own rule). Never blocks; logs the assumption made and keeps going.
- **`docs/MASCOT-ASSETS.md`** — turtle mascot, modern/clean line-art, six placeholder asset filenames to be created as real placeholder files during the scaffold ticket.

## 15. Awareness layer

Light, general, non-prescriptive messaging (sleep/water/movement/food's role in next-day energy), delivered as occasional in-app messages, not a tracking surface. Hard limit: no targets, no scoring, no "should" language around food.

## 16. One-way doors vs. reversible

**Get right now (hard to reverse):** what gets captured, and retention (§ ADR-0001). The plan/reality structural boundary (§10, ADR-0006). The enum-as-contract shape for amendments (§9d, ADR-0004) — because the training data it produces from cycle 1 can't be regenerated later if the shape was wrong.

**Reversible, don't over-engineer:** summarization strategy, tag vocabulary, how the generator weighs learnings, storage backend choice of *where* (schema is stable regardless), UI, the exact rule-magnitudes in §9d (tunable from override data later).

## 17. Still open

- Full generator JSON schema — deliberately deferred to `/to-spec`; it's assembly from the decisions above, not a new decision.
- See `docs/agents/CLARIFICATIONS.md` for the handful of things that never got a fully crisp final answer.
