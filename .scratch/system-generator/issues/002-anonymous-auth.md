---
id: 002
title: Anonymous auth on first launch + Preferences-backed session storage
status: done
blocked_by: []
---

## Scope

Wire first-launch anonymous sign-in (`supabase.auth.signInAnonymously()`) using the already-scaffolded `src/lib/supabase.ts` client. `capacitorStorage` adapter already exists (`src/lib/capacitorStorage.ts`) — this ticket wires it into an actual auth flow, not just the client config. See `docs/adr/0003-anonymous-to-permanent-auth.md`.

Do not build the magic-link linking UI in this ticket — that's the recovery/first-launch screen, out of scope here. This ticket is: app launches, no session exists, anonymous session gets created and persisted.

## Definition of done

- Unit test: `capacitorStorage` adapter round-trips `getItem`/`setItem`/`removeItem` correctly against a mocked `@capacitor/preferences`.
- Integration test (against local stack): calling the app's auth-init function with no existing session results in a session with a valid `auth.uid()`; calling it again with a persisted session does not create a second anonymous user.

## Notes

- Built `src/lib/auth.ts` (`initAuthSession(client = supabase)`): checks `getSession()` first, only calls `signInAnonymously()` if no session is persisted; returns the resulting `Session`.
- Local stack had `enable_anonymous_sign_ins = false` in `supabase/config.toml` (default) — flipped to `true`. This required `supabase stop` + `supabase start` (config changes don't apply to already-running containers, and this repo's GoTrue container had been up for 7h). Confirmed non-destructive: `stop` preserves data volumes by default (only `--no-backup` wipes them), and DB container came back healthy with existing data intact. Verified anonymous signup working directly against GoTrue via curl before writing app code against it.
- Tests: `src/lib/capacitorStorage.test.ts` (unit, mocks `@capacitor/preferences`) and `src/lib/auth.test.ts` (integration, real local Supabase, no mocking of GoTrue — uses two separate `createClient()` instances sharing the same `capacitorStorage`-backed storage to simulate an app relaunch, and spies on the second client's `signInAnonymously` to prove it's never called when a session is already persisted). Both green.
- Unrelated failure observed in the full suite, not touched: `src/test/integration/rls.test.ts` (2 failures) — `permission denied for table cycles`, `GRANT SELECT, INSERT ON public.cycles TO authenticated` missing. This is ticket 001's (schema migrations) territory, an untracked file from that concurrent agent's in-progress work — left as-is per the concurrency note in this ticket's assignment.
- `npm run typecheck`: clean. `npm test`: 41/43 passing; the 2 failures are the pre-existing, unrelated `rls.test.ts` issue above, not caused by this ticket's changes (verified by running `src/lib/auth.test.ts` + `src/lib/capacitorStorage.test.ts` in isolation: 6/6 passing).
