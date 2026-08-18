---
name: implement-ticket
description: The standard procedure for building one ticket from this repo's local ticket queue to green and committed. Use whenever asked to "implement ticket <id>", work the next ticket in the queue, or continue the overnight build loop. Stands in for the mattpocock-skills /implement flow, which isn't installed in this environment.
---

# Implement a ticket

Read, in order, before writing any code:

1. `CONTEXT.md` (repo root) — domain vocabulary and mechanics. Don't invent terminology it already defines.
2. Any `docs/adr/000N-*.md` files the ticket references — the *why* behind a hard-to-reverse decision, so you don't accidentally re-litigate it.
3. `docs/SPEC.md` — the concrete schema/contract shapes. This is the ground truth for table columns, Edge Function request/response shapes, and the bucket/action enums.
4. `docs/agents/CLARIFICATIONS.md` — check whether this ticket touches an area already flagged as an open assumption. If so, build against the logged assumption; don't re-derive your own.
5. `KNOWN_ISSUES.md` — check whether a bug in this area has already been hit and fixed. Don't rediscover it.
6. The ticket file itself (`.scratch/system-generator/issues/<id>.md`) — the specific scope and DoD for *this* piece of work. Everything above is context; this is the actual task.

## Build it

Drive with TDD (`mattpocock-skills:tdd` if you want the fuller red-green-refactor discipline; otherwise the shape is: write the failing test for the DoD first, make it pass, refactor only what you touched).

- Stay inside the ticket's stated scope. If you notice something adjacent that's wrong or missing, that's a `CLARIFICATIONS.md` entry or a new ticket, not scope creep on this one.
- If you hit a genuine spec gap — the spec is silent, not just terse — log it to `docs/agents/CLARIFICATIONS.md` per that file's own format, make the most conservative/reversible assumption, and keep going. Never block waiting for an answer.
- If you find and fix a real bug (not a spec gap — an actual defect), log it to `KNOWN_ISSUES.md` before moving on.

## Verify

Run the `run-checks` skill. Both `npm run typecheck` and `npm test` must exit 0. This is the entire DoD — no simulator/device build, no manual UI check, ever, as part of this procedure.

**Retry cap:** if the same ticket fails checks twice in a row despite genuine attempts to fix it (not two trivial retries of the same broken approach — two real attempts), stop. Mark the ticket `blocked: needs-human` in its file with a note on what was tried and why it didn't work, and move to the next unblocked ticket in the queue. Do not keep retrying past this — a stuck ticket should never stall the rest of the queue.

## Close out

1. Update the ticket file's status (`done`, or `blocked: needs-human` per above).
2. Commit with a message referencing the ticket id. One commit per ticket, not one per file.
3. Check the local ticket queue for anything this ticket unblocked, so the next invocation of this skill knows what's available.

## What this skill is not

Not a substitute for `docs/agents/CLARIFICATIONS.md` or `KNOWN_ISSUES.md` — write to those files as you go, don't just hold the information in a summary at the end. A future agent (fresh context, no memory of this run) is who reads them next, not the person who kicked off tonight's build.
