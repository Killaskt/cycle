# Known Issues

Log every bug hit and fixed here **before** the ticket that fixed it is marked done. Every ticket-implementing agent checks this file before starting, so the same issue never gets independently rediscovered and re-fixed by a later ticket.

This is for real bugs with a real fix applied — not open design questions (`docs/agents/CLARIFICATIONS.md`) and not test failures still in progress (leave those on the ticket itself until resolved).

## Entry format

```
## <short title> — <ticket-id> — YYYY-MM-DD
**Symptom:** what broke, concretely (error message, wrong output, failing assertion)
**Root cause:** why it happened
**Fix:** what changed
**Watch for:** anywhere else this same mistake could recur, if applicable
```

---

## Log

## RLS policies alone don't grant table access — 001 — 2026-08-02
**Symptom:** After creating all tables + RLS policies, every PostgREST request from an `authenticated` client failed with `permission denied for table cycles` (code `42501`), even though the RLS policy itself was correct.
**Root cause:** Enabling RLS and adding a policy only controls *row* visibility once a role already has table-level privileges. This local stack's migration user doesn't come with `anon`/`authenticated`/`service_role` pre-granted on newly created tables in `public` — Supabase's hosted projects set this up as part of project provisioning, but a from-scratch local migration has to do it explicitly.
**Fix:** Added explicit grants at the end of `supabase/migrations/20260802000000_initial_schema.sql`: `grant usage on schema public` + `grant all on all tables/sequences/routines in schema public` to `anon, authenticated, service_role`, plus matching `alter default privileges` so future tables/migrations inherit the same grants automatically.
**Watch for:** Any future migration that adds a new table needs no extra grant statement (covered by the `alter default privileges` already in place) — but if a future migration recreates the public schema, disables that default-privileges rule, or adds tables in a different schema, this will resurface.

## Shared jsdom localStorage clobbers concurrent Supabase auth sessions in tests — 001 — 2026-08-02
**Symptom:** An RLS test that signed in two different minted users in the same test run intermittently had the first user's insert rejected with `new row violates row-level security policy`, even though the insert's `user_id` matched the signed-in user.
**Root cause:** `createClient` defaults to persisting the session in `localStorage` under a fixed per-project storage key. Vitest's `jsdom` environment gives the whole test file one shared `window`/`localStorage`, so two separately-created clients in the same test file share the same storage key — signing in as user B fires a storage-change listener that silently swaps user A's in-memory client session to user B's, and a query issued right after runs under the wrong identity.
**Fix:** Test-only Supabase clients (`src/test/integration/rls.test.ts`) are created with `auth: { persistSession: false, autoRefreshToken: false }` so each minted user's client keeps its session in memory only, with no shared storage key.
**Watch for:** Any future test file that signs in more than one user via `createClient` + `signInWithPassword` in the same process needs this same option, or it will see the same intermittent cross-user session bleed.

## Native HTML constraint validation silently swallows form submit, hiding custom validation — 006 — 2026-08-02
**Symptom:** In `Intake.test.tsx`, clicking the "Start cycle" button with an out-of-range value (e.g. a negative number in a `min={0}` field) never triggered the component's `onSubmit` handler — no custom validation error rendered, no `alert` role element, test timed out on `findByRole('alert')`.
**Root cause:** jsdom implements HTML5 constraint validation on form submission. `<input type="number" min={0} required>` etc. cause the browser (and jsdom) to block the `submit` event entirely via its own native validation UI when a value violates those constraints — so React's `onSubmit` handler, and the custom validate()-driven error message, never runs at all.
**Fix:** Added `noValidate` to the `<form>` in `src/screens/Intake.tsx`. The component already does thorough manual validation (`validate()`) and renders a custom `role="alert"` message, so native browser validation was redundant and actively hid that logic instead of complementing it.
**Watch for:** Any future form component that uses HTML5 validation attributes (`required`, `min`, `max`, `pattern`, etc.) alongside custom JS validation needs `noValidate` on the `<form>`, or both the real UI and any test driving it via `fireEvent.click`/`requestSubmit` will silently no-op on invalid native-constrained input.
