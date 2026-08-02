---
id: 002
title: Anonymous auth on first launch + Preferences-backed session storage
status: open
blocked_by: []
---

## Scope

Wire first-launch anonymous sign-in (`supabase.auth.signInAnonymously()`) using the already-scaffolded `src/lib/supabase.ts` client. `capacitorStorage` adapter already exists (`src/lib/capacitorStorage.ts`) — this ticket wires it into an actual auth flow, not just the client config. See `docs/adr/0003-anonymous-to-permanent-auth.md`.

Do not build the magic-link linking UI in this ticket — that's the recovery/first-launch screen, out of scope here. This ticket is: app launches, no session exists, anonymous session gets created and persisted.

## Definition of done

- Unit test: `capacitorStorage` adapter round-trips `getItem`/`setItem`/`removeItem` correctly against a mocked `@capacitor/preferences`.
- Integration test (against local stack): calling the app's auth-init function with no existing session results in a session with a valid `auth.uid()`; calling it again with a persisted session does not create a second anonymous user.

## Notes
