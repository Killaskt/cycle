# Handoff: System Generator App

## Ask

Read this brief, then produce a plan: which of your skills to run, in what order, with what input at each step, to get from this brief to an implementable ticket queue tonight and an unattended `/implement` loop overnight. Flag anything in the brief that is underspecified enough to break a loop running without me.

---

## The product

A system generator. The user names their focus areas and a timeframe; the app generates a system — a schedule plus goals for that window — and locks it. When the user falls off, one button picks them back up.

**Thesis:** take system design out of the user's hands. Every productivity tool hands you infinite configurability and you burn your energy on the meta-layer instead of the work. Constraint is the product. The user's only job is to pick a path and stick to it for the timeframe.

**The bet on retention:** the value has to accrue in the record — what you committed to, what you actually did, where and how often you fell off. If all the value lands at generation time, this is an LLM wrapper. The fall-off history is what makes generation #7 better than generation #1.

## Core mechanics

### Intake (delta-based, not conversational)

Not a full interview. Ask what time they wake, what a normal day already looks like, and what they want to focus on. Compute the gap between real and ideal, then move a fraction of it — a ~1% change, not a life overhaul. Locking a small delta is defensible; locking a fantasy schedule is why people quit on day 3.

### The system

One generated schedule + goals for the window. Read-only. Accept, or regenerate once, then locked for the timeframe. No editing, no re-optimizing on day 4.

### Today

One view: what today asks of you. Check off or don't.

### "I fell off" — the core feature

Not a nice-to-have. It is the only channel of real-world signal the app has; everything else is self-report.

**Escalate friction, not guilt:**

| Occurrence | Flow |
|---|---|
| 1st | One tap. No survey. Straight back in. |
| 2nd | Mood tap + three factual questions. |
| 3rd | No survey. Forced downscope — the app removes something from the plan. |

**Ask facts, not attribution.** Never "was it you or the system?" — self-blamers pick themselves every time and nothing ever changes. Ask instead: what did you hit, what did you miss, what got in the way on which days. The app does the attribution silently. Same slot fails twice → system problem, regardless of what the user believes about their discipline. Never surface the verdict; just move the slot.

**Reassurance framing, no statistics.** Don't cite percentages — the real numbers don't exist in citable form, invented ones are a liability, and "87% of people fall off" tells the user that quitting is normal. Frame the fall as anticipated: the system was built expecting this, which is why the button exists. Vary the copy by occurrence count (1st: barely a screen. 2nd: "twice now — let's look at what's actually in the way." 3rd: "the plan is wrong, we're cutting it down.").

**The downscope at 3 is the differentiator.** Nothing else on the market will reduce your goals for you.

## MVP scope

Four screens: Intake → System (locked) → Today → I Fell Off.

Storage: one JSON blob per cycle.

**Explicitly out:** accounts beyond auth, streaks, notifications, multi-cycle history, plan editing, social, analytics.

## Success test

Run myself through one two-week cycle. The signal that matters: does the fall-off button feel like relief or like guilt.

## Constraints for tonight's loop

- Local markdown files as the issue tracker — no network dependency at 3am.
- Repo is `git init`'d with a green build and test command before any skill runs; clean baseline commit exists.
- Tests are the only verification signal while I'm asleep. Every ticket needs a machine-checkable definition of done.
- Storage shape and per-ticket done criteria must be settled before `/implement` starts.