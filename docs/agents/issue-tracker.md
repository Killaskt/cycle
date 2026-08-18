# Issue tracker: local markdown

Tickets for this repo live as local markdown files, **not** GitHub issues, for tonight's build. This repo's `origin` remote is a real GitHub repo (`Killaskt/cycle`) and `gh` works fine here in general — this override exists specifically so the unattended overnight build loop has zero network dependency. Revisit if/when the project moves off a single-session unattended-build workflow.

## Location

```
.scratch/system-generator/issues/<NNN>-<slug>.md
```

Zero-padded three-digit id, e.g. `001-schema-migrations.md`, `012-fall-off-escalation-ladder.md`.

## Ticket format

```markdown
---
id: 001
title: Short imperative title
status: open   # open | in_progress | blocked:needs-human | done
blocked_by: [] # list of ticket ids, e.g. [001, 003]
---

## Scope

What this ticket covers. Specific enough that "done" isn't a judgment call.

## Definition of done

Machine-checkable. Name the actual test(s)/assertion(s), not "works correctly."
Reference `docs/SPEC.md` / `CONTEXT.md` sections by number where relevant.

## Notes

(Appended during implementation: blockers hit, assumptions logged elsewhere,
anything the next reader needs. Not a duplicate of KNOWN_ISSUES.md or
CLARIFICATIONS.md — link to entries there instead of restating them.)
```

## Conventions

- **Create a ticket**: new file at the path above. `blocked_by` lists ids, not filenames.
- **Read a ticket**: read the file.
- **List tickets**: `ls .scratch/system-generator/issues/` — or grep frontmatter across the directory for a specific `status`.
- **Claim a ticket**: no separate claim step for a single-agent overnight loop — set `status: in_progress` when starting.
- **Blocking**: the `blocked_by` frontmatter list. A ticket is unblocked when every id in that list has `status: done` (not `blocked:needs-human` — a blocked blocker keeps its dependents blocked too).
- **Resolve**: set `status: done`, commit. If a ticket can't be finished after genuine retries, set `status: blocked:needs-human` with a `## Notes` entry explaining what was tried — per the retry-cap rule in `.claude/skills/implement-ticket/SKILL.md` — and move to the next unblocked ticket rather than stalling the queue.

## Frontier query

The next available ticket is: `status: open`, and every id in its `blocked_by` list has `status: done` elsewhere in the directory. When several qualify, take the lowest id first.

## When a skill says "publish to the issue tracker"

Create a ticket file at the path above.

## When a skill says "fetch the relevant ticket"

Read the ticket file directly.

## Pull requests as a triage surface

Not applicable — no PR flow for tonight's local-only loop. Ignore any skill instruction that assumes one.

## Wayfinding operations

Not used in this build (no `/wayfinder` map/child structure needed for tonight's scope). If a future session runs `/wayfinder`, revisit this section rather than improvising a local-file equivalent of GitHub's issue-dependency API — that's a bigger structural decision than a one-line convention update.
