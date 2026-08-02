# Cycle — Context Document

> Working name: **Cycle** as the unit ("start a cycle," "day 4 of your cycle"). Brand name undecided; **Holdfast** is the leading candidate, with **Stint** and **Reprise** as alternates. The line worth keeping either way: *a cycle works against you or with you.*

---

## 1. Thesis

A system generator. The user names their focus areas and a timeframe; the app generates a system — schedule plus goals for that window — and locks it. When the user falls off, the app picks them back up and amends the system rather than the person.

**The contrarian bet:** take system design out of the user's hands. Every productivity tool hands you infinite configurability and you burn your energy on the meta-layer instead of the work. Constraint is the product. The user's only job is to pick a path and stick to it for the timeframe.

**The retention bet:** value accrues in the record — what you committed to, what you actually did, where and how often you fell off, and what amendment worked. If all the value lands at generation time, this is an LLM wrapper. The fall-off history is what makes generation #7 better than generation #1.

**What is actually being tested:** not whether the app can generate a plan (it can), but whether persisted learnings from fall-offs measurably improve the *next* cycle's generation, and whether being nudged differently helps the user stay on.

---

## 2. Two loops

| Loop | Trigger | Cadence | Purpose |
|---|---|---|---|
| **Fast** | User falls off | Within a cycle | Recover + amend the current system |
| **Slow** | Cycle timeframe ends | Between cycles | Review + generate the next system from learnings |

Build the fast loop first. It's what the user lives in daily, and the slow loop can't be tested until a full timeframe elapses.

---

## 3. Intake — delta-based, not conversational

Not a full interview. Capture:
- What time they wake
- What a normal day already looks like
- What they want to focus on (each captured as its category)
- The timeframe

The generator computes the gap between real and ideal and moves a *fraction* of it — roughly a 1% change, not a life overhaul. Locking a small delta is defensible; locking a fantasy schedule is why people quit on day 3.

**Bandwidth / load factor.** Intake captures *claimed* capacity. Completion rate reveals *actual* capacity. The ratio between them is the load factor, and subsequent cycles generate against observed capacity rather than claimed. This is what makes "1% delta" concrete instead of a vibe — you delta from measured capacity, not from what someone told you on day one. (Conceptually similar to sprint velocity, but measuring personal load rather than team throughput.)

---

## 4. The system (locked)

One generated schedule + goals for the window. Read-only. Accept, or regenerate once, then locked for the timeframe. No editing, no re-optimizing on day 4.

The only thing that changes a locked plan is an **amendment**, which is triggered by a fall-off and executed by code — never by free-form user editing.

---

## 5. Today

One view: what today asks of you. Check off or don't.

Completions are logged continuously, not just failures. Without them the next cycle only knows what to avoid and never what to repeat.

---

## 6. The fall-off map

Counters are **per slot**. Falling off your run once and your reading once is two 1st falls, not a pattern. A **separate cycle-wide counter** tracks total falls across all slots — five 1st falls across five slots is an overload signal with its own response.

| Fall (per slot) | What happens |
|---|---|
| **1st** | Reassurance screen → tag + "what happened." Back on. **No plan change.** |
| **2nd** | **The Amendment.** Agent proposes one specific action with reasoning. User accepts, or rejects with a reason → agent revises once. Both outcomes logged as training signal. |
| **3rd** (same slot, post-amendment) | The amendment was wrong. Escalate to remove-or-restructure. Downgrade that `tag → action` mapping's confidence for this user. |

Implement as an explicit switch on fall count. The map should be readable at a glance in the code.

### Reassurance framing

No statistics. Real numbers don't exist in citable form, invented ones are a liability, and "87% of people fall off" tells the user quitting is normal. Frame the fall as **anticipated**: the system was built expecting this, which is why the button exists.

Copy varies by occurrence:
- 1st: barely a screen — "back on."
- 2nd: "twice now — let's change the plan."
- 3rd: "the plan is wrong. We're cutting it down."

### Escalate friction, not guilt

The user's effort goes *down* as falls accumulate, not up. A third fall should feel like relief, not an interrogation.

### What the survey asks

Ask **facts, not attribution**. Never "was it you or the system?" — self-blamers pick themselves every time and nothing changes. The app does attribution silently and never shows the verdict.

1. **What were you supposed to be doing?** — auto-filled from the slot; confirm, don't ask.
2. **What happened instead?** — short freeform, saved verbatim. This is the raw signal.
3. **A tag** — user-created, reusable, 1–3 words, in their own words. Offered as a dropdown of their existing tags + "something else." Fuzzy-match new entries against existing tags and suggest reuse, or the vocabulary fragments by cycle 5 and the signal dilutes.
4. **Mood** — one tap.

Plus, **at most one** agent-chosen follow-up question, and only when the agent has a hypothesis worth testing (e.g. three morning falls tagged "tired" earns *"what time have you been getting to sleep?"* once). Never a fixed checklist. Never more than one. It disappears once the hypothesis resolves.

**Disinterest** is a legitimate tag with one constraint: it cannot trigger `REMOVE` before a minimum exposure (~3 completed sessions). Before that it downgrades to `REDUCE_FREQUENCY` or `MOVE` — "I don't like this" after two attempts is usually friction wearing the mask of preference. After real exposure, dropping it is legitimate and should be clean and guilt-free.

---

## 7. The action space — agent proposes, code disposes

The agent chooses the response; the code executes it. The model's output never touches the plan directly.

```
enum ActionType {
  NONE               // 1st fall — back on, no change
  MOVE               // same commitment, different time of day or day of week
  SHORTEN            // less time per session
  REDUCE_FREQUENCY   // fewer sessions per week
  REALLOCATE         // move time from this to a goal that's working
  EASE_NEXT_DAY      // temporary lighter load, auto-expires
  REMOVE             // drop it entirely
  UNHANDLED          // escape hatch — no existing action fits
}
```

**Agent contract.** Returns `{ action, target, params, reasoning, confidence }`. Code validates against the enum → switch → apply → log. Malformed or out-of-enum response: retry once, then fall to `UNHANDLED`. A bad model response can never corrupt a plan.

**Single source of truth.** Define the enum once in code and *generate* the prompt's action menu from it at runtime. Never hand-maintain two parallel lists — that's how these systems rot as the action space grows.

**`UNHANDLED` behavior.** Apply `NONE` (user gets back on, plan untouched), write a dev report containing the agent's reasoning and its suggested new action, capture the surrounding conversation, surface nothing unusual to the user. Safe default, full signal for the developer. *(Conversation capture needs consent + stripping before this reaches any user but the developer — cheap now, painful to retrofit.)*

### Guardrails

- **Net load can only go down or stay flat at a fall-off.** `REALLOCATE` moves time between goals; it never adds. Increasing total commitment at a moment of demonstrated overload is backwards.
- **`EASE_NEXT_DAY` must auto-expire.** If it doesn't restore itself, every fall permanently erodes the plan and the lock means nothing by week two.
- **Reductions need a floor.** Once a commitment can't shrink further without becoming meaningless, the only remaining option is `REMOVE` — say so honestly rather than shrinking it to a token five minutes.

---

## 8. Agent instruction set

Assembled from these design decisions and versioned in the repo. Hard constraints, not soft guidance:

- Never attribute failure to character, discipline, or willpower.
- Never imply the user should have tried harder.
- Describe the *plan* as wrong, never the person.
- Keep any follow-up questions neutral and observational ("what time did you sleep," never "did you eat too much"). Judgment-flavored questions — especially about food — invite a self-blame spiral in exactly the users this design is trying to protect, and they don't produce better data.
- Output must be one of the `ActionType` values, with reasoning.

These are testable. Tone is the thing least affordable to have drift during an unattended run.

---

## 9. Cycle close — the review

Ends on the user's press. Notifications nudge if they haven't started the next cycle.

**Shown, not asked:** the falls-and-recoveries timeline, with tag frequencies. *"Tuesday 6:30am — fell off 3x, tagged 'sleep' twice."* Memory of "what didn't work" two weeks later is far worse than tags captured in the moment. The review's job is to **confirm and close out** what was already tracked, not re-collect it.

**Asked — four inputs, three of them taps:**
1. Per goal: **hit / partial / missed** (their read; the gap between this and the completion data is itself signal)
2. Per goal: **keep or drop** for next cycle — this is goal-shift capture
3. Confirm or correct the fall/tag summary
4. One freeform box: *"what should next cycle do differently?"*

A review screen that's mostly typing is a review people skip.

---

## 10. Data model and retention

**Decision: retain every cycle.** One record per cycle, never overwritten, kept after close. "Multi-cycle history out of scope" means *no browsing UI* — not "don't keep the data." Missing features are cheap to add later; missing data from a cycle already run is gone forever and cannot be backfilled.

**Must be captured now, because none of it is reconstructable:**

*Per cycle*
- The generated plan itself — schedule, goals, timeframe. Without the plan you can't diff intent against outcome, and can't tell whether generation improved.
- Every completion, with slot and timestamp.
- Every fall-off event: slot, timestamp, occurrence number, verbatim "what happened," tag, mood.
- Every amendment: proposed action, agent reasoning, accepted/rejected, rejection reason, revised action.
- Review answers at close.

*Across cycles — the learnings store*
- Rolling `tag → action` mappings per user, with confidence, read by the generator when building the next cycle.
- Observed capacity / load factor.

**Raw + structured, both.** Save verbatim answers alongside whatever structure gets extracted. Summarization, tag vocabulary, and how the generator consumes learnings can all be rewritten later *against stored raw data*. Structured facts beat prose summaries for the generator — a few typed fields are easier to reason over than a paragraph the model wrote itself.

**Storage location.** Supabase is the intended destination. For an unattended overnight build, use a local file or SQLite so nothing hangs on network access or credentials at 3am, and treat "migrate to Supabase" as its own daylight ticket. The schema doesn't change based on where it lives.

---

## 11. Awareness layer

Light, general, non-prescriptive messaging about sleep, water, movement, and food, and the role they play in next-day energy and motivation. Delivered as occasional in-app messages or quotes rather than a tracking surface.

Hard limit: no targets, no scoring, no "should" language around food. A habit app that starts grading what you eat is one design decision from being actively harmful to a meaningful share of users, and the awareness goal doesn't require it.

---

## 12. MVP scope

Four screens: **Intake → System (locked) → Today → I Fell Off**, plus the cycle-close review.

**Out of scope:** browsing UI for past cycles, streaks, social, analytics dashboards, plan editing, accounts beyond auth.

**In scope despite earlier ambiguity:** the learnings store and its use in the next generation. That's the hypothesis, so it can't be cut.

### Success tests
1. Does the fall-off button feel like relief or like guilt? (One two-week cycle, self-tested.)
2. Does cycle #2's plan visibly differ from cycle #1's *because of* fall data — and does that difference help?

### Testability for an unattended run
- Assert on **applied transformations**, not agent choices. Given a plan and `REDUCE_FREQUENCY` on slot X, assert X appears half as often and nothing else changed. One deterministic test per enum member, no model in the loop.
- Every ticket needs a machine-checkable definition of done. Tests are the only verification signal available overnight.
- Toolchain green and a clean baseline commit before the loop starts.

---

## 13. Future-proofing — where each MVP decision leads

| MVP decision | What it enables later |
|---|---|
| Retain every cycle, raw + structured | Cross-cycle learning; the compounding claim; retroactive re-analysis with better extraction |
| Store the generated plan, not just outcomes | Ability to prove generation quality improved over time |
| Bounded action enum, code-executed | New actions are additive; guardrails and analytics attach to a stable vocabulary |
| Enum as single source of truth for the prompt | Action space can grow without prompt drift |
| Log accept/reject + rejection reason on every amendment | A per-user preference model; eventually pre-selecting the action they always pick |
| User-created reusable tags | A personal vocabulary that becomes the index for cross-cycle pattern matching |
| `UNHANDLED` + dev reports | A backlog of real cases driving what the next action should be — the action space grows from evidence, not guessing |
| Observed capacity / load factor | Genuinely personalized generation; the core of the "fits your life" claim |
| Per-slot *and* cycle-wide counters | Distinct responses for local friction vs. global overload |

**One-way doors (get these right now):** what gets captured, and retention. **Reversible (don't over-engineer):** summarization strategy, tag vocabulary, how the generator weighs learnings, storage backend, UI.

---

## 14. Open questions

- Concrete data structure for "a system" — the generator's output schema.
- The generation prompt itself, and how the learnings store is injected into it.
- What the cycle-wide overload counter triggers, and at what threshold.
- Minimum exposure threshold before `disinterest` can trigger `REMOVE`.
- Notification cadence for un-started cycles without becoming nagging.