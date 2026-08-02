# ADR-0002: Local Supabase via Docker for all dev/test — never a separate local backend, never the hosted project

## Status
Accepted

## Context

ADR-0001 requires a durable backend; Supabase (project `cycle`, already provisioned) is the intended production destination. Two alternatives were considered for the unattended overnight build loop:

1. A different local-only backend for dev/test (flat file or SQLite), Supabase only for "real" deployment — this was `docs/oneDoc.md` §10's original suggestion, written before local Supabase was confirmed running in this environment.
2. Point automated tests directly at the hosted Supabase project.

Option 1 means building and maintaining two storage implementations, and means the automated loop never actually exercises the thing most likely to be broken by adopting a new backend: RLS policies and schema constraints. Option 2 reintroduces exactly the network-dependency risk this project already ruled out for its issue tracker ("no network dependency at 3am") — a transient network blip would fail tests unrelated to code correctness, and worse, automated test runs would write real rows into the same project reserved for the actual two-week personal run, risking contamination.

## Decision

Local Supabase via the Supabase CLI + Docker (`supabase start`) for all dev and automated test activity — real Postgres, real GoTrue auth, real RLS, on localhost. The hosted `cycle` project is reserved exclusively for actual personal use.

Test users are minted directly via the service-role key (`auth.admin.createUser`, `email_confirm: true`) — no real magic-link email is ever sent by an automated test.

## Consequences

- Same offline guarantee as a flat-file approach, with no migration debt later and no second implementation to maintain — RLS/schema bugs surface tonight, in the loop, instead of at the real launch.
- Adds one one-time setup cost (Docker + `supabase init && supabase start`, ~5–10 minutes including first-run image pulls) as a precondition alongside the build/test baseline.
- `docs/oneDoc.md` §10's SQLite/local-file suggestion is superseded by this ADR.
