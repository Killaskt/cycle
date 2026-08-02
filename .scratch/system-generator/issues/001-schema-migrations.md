---
id: 001
title: Database schema migrations (tables, enums, RLS)
status: open
blocked_by: []
---

## Scope

Create `supabase/migrations/` SQL for every table, enum, and RLS policy in `docs/SPEC.md` §1-2, including the `cycles.review` jsonb shape (§2f), the `commitments.focus_area_id` unique constraint (the structural 1:1 assertion), and the `blocked_windows` table being the only writer path for constraint data (`docs/adr/0006`).

RLS: every table scoped by `user_id` directly, or via the obvious join to a `user_id`-bearing parent. `learnings`, `reliability_map`, `load_factor`, `tags` are scoped directly to `user_id` (cross-cycle); everything else joins through `cycles.user_id`.

## Definition of done

- `npx supabase db reset` succeeds with no errors against the local stack.
- A Vitest integration test (service-role client, see `.claude/skills/local-supabase-stack/SKILL.md`) asserts: every table in `docs/SPEC.md` §2 exists with its expected columns (query `information_schema.columns`), both enums exist with all listed values, and RLS is enabled on every table (`pg_tables.rowsecurity` / `pg_policies`).
- A second test: insert a row as user A (via a minted test user), confirm a client authenticated as user B cannot read it.

## Notes
