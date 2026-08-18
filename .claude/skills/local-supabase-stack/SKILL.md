---
name: local-supabase-stack
description: Start, verify, and use the local Docker-based Supabase stack for this repo (Postgres, Auth, Edge Functions). Use before running any test or dev command that touches the database, auth, or the generate Edge Function, and whenever a command fails with a connection error to 127.0.0.1:54321-54324.
---

# Local Supabase stack

This repo never points automated tests or dev work at the hosted Supabase project (`docs/adr/0002-local-supabase-docker-for-dev-test.md`). Everything runs against a local Docker-based stack instead. The CLI is invoked via `npx`, not a global install — global install of the `supabase` npm package is unsupported and will error.

## Check it's running

```bash
docker ps
```
If this errors with a pipe/connection failure, Docker Desktop itself isn't running — launch it from the Start menu and wait ~30-60s before retrying.

## Start the stack (first time, or after a reboot)

```bash
npx -y supabase@latest start
```

First run pulls Docker images (a few minutes). Every run after is seconds. On success it prints a block of URLs and keys — the ones that matter:

```
API_URL:           http://127.0.0.1:54321
DB_URL:            postgresql://postgres:postgres@127.0.0.1:54322/postgres
STUDIO_URL:        http://127.0.0.1:54323
MAILPIT_URL:       http://127.0.0.1:54324   (local email capture — magic links land here, not a real inbox)
ANON_KEY / SERVICE_ROLE_KEY / JWT_SECRET: fixed local demo values, safe to hardcode in local env files, never valid against the hosted project
```

If it's already running, `start` is idempotent — just prints the same block again.

## Apply schema changes

Migrations live in `supabase/migrations/`. After adding or editing one:

```bash
npx -y supabase@latest db reset
```

This rebuilds the local DB from migrations + `supabase/seed.sql` from scratch — safe, it's local-only data. Use this instead of hand-editing local tables when a migration changes.

## Serve the `generate` Edge Function locally

```bash
MODEL_PROVIDER=fixture npx -y supabase@latest functions serve generate
```

`MODEL_PROVIDER=fixture` selects the canned-response provider (no network, no key, no cost, deterministic) — this is what automated tests must use. Omit it (or set `MODEL_PROVIDER=live`) for real dev testing against an actual model API, which requires the real provider's API key set in `supabase/functions/generate/.env.local` (never commit this file).

## Minting a test user without email

Tests never trigger real magic-link auth. Use the service-role key to create a pre-confirmed user directly:

```ts
const { data } = await supabaseAdmin.auth.admin.createUser({
  email: 'test@example.com',
  email_confirm: true,
})
```

`supabaseAdmin` = a client constructed with `SERVICE_ROLE_KEY` against the local `API_URL`. Never use the service-role key in app code — test setup only.

## Common failure modes

- **"connection refused" / "ECONNREFUSED 127.0.0.1:54321"** → stack isn't running, see "Start the stack" above.
- **Port already in use** → a previous `supabase start` from another terminal/session is still up; check `docker ps` before assuming something is broken, it may already be running and fine.
- **Schema drift between tests** → run `db reset`, don't hand-patch.
- **Magic-link email "not received"** → it was never sent to a real inbox; check Mailpit at `http://127.0.0.1:54324`.
