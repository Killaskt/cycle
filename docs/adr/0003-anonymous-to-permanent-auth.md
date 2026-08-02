# ADR-0003: Anonymous Supabase auth on first launch, upgradeable to a permanent identity via magic-link linking

## Status
Accepted

## Context

The MVP's four screens (Intake → System → Today → I Fell Off) don't include a login screen, and "accounts beyond auth" is explicitly out of scope. But ADR-0001 means real, valuable, unrecoverable data accumulates per identity. A pure anonymous Supabase session persists across normal app *updates*, but not across an *uninstall* (the OS deletes the app's local data container, taking the session token with it) — and during an active build cycle, several things behave like a reinstall without literally being one: switching from local dev signing to a TestFlight/internal build, Xcode forcing a fresh install on a version mismatch it can't resolve, or deleting the app to clear a bad state. With pure anonymous auth, losing that token doesn't just clear a cache — it orphans every row tied to that `auth.uid()` permanently, since there's no credential to recover it with.

## Decision

Sign in anonymously (`signInAnonymously()`) on first launch — no login screen, no visible account. Support Supabase's anonymous-to-permanent upgrade (`linkIdentity()`, magic link) so the *same* `auth.uid()` gains a real recovery credential without any schema or RLS change. The link/login screen exists, but only ever appears twice in the app's life: first launch (to establish or skip linking) and recovery after a session loss — never as part of daily use.

Magic link was chosen over password auth to minimize ticket surface for the unattended build (no password strength validation, no reset-password flow).

## Consequences

- RLS is real and enforced from the start, not theater retrofitted later — every row is scoped to a genuine `auth.uid()` from cycle 1.
- Automated tests must mock or locally-mint this auth path (see ADR-0002) rather than exercising real magic-link delivery — a live network/email call during unattended tests is the same risk class ruled out elsewhere.
- This is a deliberate, small deviation from the letter of "four screens" — justified because the screen is a rare recovery path, not a daily-use addition, and is recorded here rather than silently expanding scope.
