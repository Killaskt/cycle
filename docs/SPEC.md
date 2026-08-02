# SPEC — Cycle (buildable schema + contracts)

Assembled from `CONTEXT.md` and `docs/adr/`. This is the concrete shape; the *why* behind each field lives in those documents — read them, don't relitigate them from tickets.

## 1. Bucket enum (reliability map, placement — CONTEXT.md §9, §12)

12 values, `day_type` × `time_of_day`:

```
day_type:    weekday | weekend
time_of_day: early_morning | morning | midday | afternoon | evening | night
```

Encoded as `{day_type}_{time_of_day}`, e.g. `weekday_early_morning`. Defined once as a Postgres enum and as a TS union type generated from the same source (`supabase gen types typescript`) — never hand-duplicated.

## 2. Database schema

RLS on every table: `using (auth.uid() = user_id)`, or via the obvious join to a `user_id`-bearing parent (`cycle_id -> cycles.user_id`, etc.). Every table below is scoped to a cycle **except** `tags`, `learnings`, `reliability_map`, `load_factor` — those are cross-cycle (CONTEXT.md §16, ADR-0001) and scoped directly to `user_id`.

```sql
create type bucket as enum (
  'weekday_early_morning','weekday_morning','weekday_midday',
  'weekday_afternoon','weekday_evening','weekday_night',
  'weekend_early_morning','weekend_morning','weekend_midday',
  'weekend_afternoon','weekend_evening','weekend_night'
);

create type action_type as enum (
  'NONE','MOVE','SHORTEN','REDUCE_FREQUENCY','REALLOCATE',
  'EASE_NEXT_DAY','REMOVE','UNHANDLED'
);

create table cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  status text not null default 'draft' check (status in ('draft','active','closed')),
  -- draft: generated, not yet accepted/started. active: day 1 has begun, locked.
  timeframe_days int not null,
  wake_time time not null,
  normal_day_notes text,
  regenerate_used boolean not null default false,
  started_at timestamptz,           -- set on transition draft -> active; regenerate only allowed while null
  closes_at timestamptz,            -- started_at + timeframe_days, set alongside started_at
  review jsonb,                     -- cycle-close answers, see §2f
  created_at timestamptz not null default now()
);

create table focus_areas (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references cycles on delete cascade,
  name text not null,               -- user's verbatim text, never rewritten
  target_freq int not null check (target_freq >= 0),
  target_dur int not null check (target_dur >= 0),   -- minutes
  current_freq int not null check (current_freq >= 0),
  current_dur int not null check (current_dur >= 0), -- minutes
  intake_order int not null,        -- ceiling back-off tie-break: last-entered first
  created_at timestamptz not null default now()
);

create table commitments (
  id uuid primary key default gen_random_uuid(),
  focus_area_id uuid not null unique references focus_areas on delete cascade,
  -- UNIQUE is the 1:1 assertion (CONTEXT.md §12) made structural, not just tested
  name text not null,
  session_shape text not null,
  freq int not null check (freq >= 0),      -- plan_freq, CONTEXT.md §5
  dur int not null check (dur >= 0),        -- plan_dur minutes
  bucket bucket not null,
  rationale text,                            -- null when the deterministic fallback produced this row
  from_fallback boolean not null default false,
  created_at timestamptz not null default now(),
  removed_at timestamptz                     -- null = active. Set by REMOVE (ticket 013, CONTEXT.md §9a's
                                              -- 3rd-fall escalation) — soft-delete, never a hard `delete`,
                                              -- since fall_offs/amendments history must survive.
);

create table slots (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references commitments on delete cascade,
  scheduled_date date not null,
  bucket bucket not null,
  status text not null default 'pending' check (status in ('pending','completed','fell_off','excused')),
  created_at timestamptz not null default now()
);

create table completions (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots on delete cascade,
  completed_at timestamptz not null default now()
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  label text not null,
  classification text not null check (classification in ('availability','motivation')),
  created_at timestamptz not null default now(),
  unique (user_id, label)
);
-- seed 'disinterest' -> 'motivation' per user on first cycle (CONTEXT.md §9a)

create table fall_offs (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots,
  cycle_id uuid not null references cycles,   -- denormalized for cycle-wide rate queries
  occurrence_in_slot int not null check (occurrence_in_slot >= 1),
  what_happened text not null,                -- verbatim, required at every occurrence
  tag_id uuid not null references tags,
  mood text,                                  -- null on 1st fall — see CLARIFICATIONS.md
  agent_followup_question text,
  agent_followup_answer text,
  created_at timestamptz not null default now()
);

create table amendments (
  id uuid primary key default gen_random_uuid(),
  fall_off_id uuid not null references fall_offs,
  action action_type not null,
  target jsonb not null,             -- e.g. { "commitment_id": "..." }
  params jsonb not null default '{}',
  reasoning text not null,           -- human-readable, always present — rule or model, same contract (ADR-0004/0007)
  confidence numeric(3,2) not null,
  proposed_by text not null default 'rule' check (proposed_by in ('rule','agent')),
  user_response text check (user_response in ('accepted','rejected')),
  rejection_reason text,
  revised_action action_type,
  revised_target jsonb,
  revised_params jsonb,
  created_at timestamptz not null default now()
);

create table blocked_windows (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references cycles on delete cascade,
  date date not null,
  affected_slot_id uuid references slots,   -- nullable: "something came up" may or may not target a specific slot
  created_at timestamptz not null default now()
);
-- MVP's only writer: the "something came up" tap. No recurring rows in MVP (ADR-0006).
-- This table is the ONLY thing a future calendar feed may ever write to.

create table learnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  tag_id uuid not null references tags,
  action action_type not null,
  confidence numeric(3,2) not null default 0.50,
  sample_size int not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, tag_id, action)
);

create table reliability_map (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  bucket bucket not null,
  completions int not null default 0,
  scheduled int not null default 0,
  unique (user_id, bucket)
);
-- "trusted" = scheduled >= 3 (CONTEXT.md §9); until then generation treats the bucket as neutral

create table load_factor (
  user_id uuid primary key references auth.users,
  last_cycle_completed_minutes int,
  updated_at timestamptz not null default now()
);
```

### 2f. `cycles.review` shape

```json
{
  "goals": [
    { "focus_area_id": "uuid", "result": "hit|partial|missed", "keep_next": true }
  ],
  "fall_summary_confirmed": true,
  "tag_corrections": [ { "tag_id": "uuid", "classification": "availability|motivation" } ],
  "freeform": "what should next cycle do differently"
}
```

## 3. Edge Function: `generate`

One function, real model call, provider selected by env var (`MODEL_PROVIDER=fixture|live`) — ADR-0005.

**Request:**
```json
{
  "wake_time": "06:30",
  "focus_areas": [
    { "id": "uuid", "name": "running", "target_freq": 4, "target_dur": 30, "current_freq": 1, "current_dur": 20, "intake_order": 0 }
  ],
  "reliability_map": [ { "bucket": "weekday_morning", "completions": 8, "scheduled": 9 } ],
  "blocked_windows": [ { "date": "2026-08-05" } ]
}
```
`reliability_map` is `[]` on cycle 1 (no data yet — every bucket reads neutral, per CONTEXT.md §9).

**`ceiling_basis_minutes`** (optional, ticket 018, CONTEXT.md §6): when present, the ceiling used by both `applyCeiling` and the runtime invariant check is `ceiling_basis_minutes * 1.15` instead of the cycle-1 default (`Σ current_freq × current_dur` across `focus_areas`). `src/lib/systemPlan.ts`'s `buildGenerateRequestBody` sets it from `load_factor.last_cycle_completed_minutes` whenever that row exists for the user — i.e. automatically from cycle 2 onward, once a prior cycle has closed. Additive field; omitted (cycle 1, no `load_factor` row yet) it changes nothing.

**Model call, per focus area** — request to the provider:
```json
{ "focus_area": { "name": "running", "...": "..." }, "wake_time": "06:30" }
```
**Model response** (validated against this shape; anything else is a validation failure → retry once → fallback, CONTEXT.md §12):
```json
{ "focus_id": "uuid", "commitment_name": "string", "session_shape": "string", "preferred_bucket": "bucket enum value", "rationale": "string" }
```

**Function's deterministic post-processing** (CONTEXT.md §5, §12 — no model involved past this point):
1. Compute `plan_freq`/`plan_dur` per focus area via the delta formula.
2. Run the ceiling check across all focus areas; back off per the tie-break rule if `load > ceiling`.
3. Resolve final `bucket`: start from the model's `preferred_bucket`; if it collides with a `blocked_window` or a bucket the reliability map marks unreliable relative to alternatives, reassign to the best available bucket in wake-time order.
4. Insert one `commitments` row per focus area (unique constraint enforces exactly one).

**Response:**
```json
{
  "commitments": [
    { "focus_area_id": "uuid", "name": "string", "session_shape": "string", "freq": 3, "dur": 25, "bucket": "weekday_morning", "rationale": "string|null", "from_fallback": false }
  ]
}
```

**Invariant checks, run as the actual runtime validator (not only in tests):**
- No commitment's `bucket` collides with a `blocked_windows` row for that cycle.
- `Σ(freq × dur) <= ceiling`.
- Exactly one commitment per focus area submitted.
- `freq`/`dur` within the delta-formula's bounds for that focus area.

Any invariant failure on the *first* pass → retry the model call once. Second failure → apply the deterministic fallback (CONTEXT.md §12) for the offending focus area(s) only, not the whole request.

## 4. Amendment path (MVP — no Edge Function, ADR-0007)

Pure function, no network call:

```
proposeAmendment(fallOff, priorAmendmentsForSlot) -> { action, target, params, reasoning, confidence, proposed_by: 'rule' }
```

- Occurrence 2 for this slot → `{ action: 'MOVE', confidence: 1.0, reasoning: '<fixed string, see CONTEXT.md §9b>' }`
- Occurrence 3 for this slot → `{ action: 'REMOVE', confidence: 1.0, reasoning: '<fixed string>' }`

Same acceptance/rejection UI and logging as a future model-proposed amendment would use (`amendments` table, `proposed_by: 'rule'` today, `'agent'` later — no schema change needed to swap).

## 5. Cycle-wide overload check (CONTEXT.md §9c)

Pure function, runs after every fall-off write:

```
checkOverload(cycleId) -> null | { response: 'MOVE_CLUSTER' | 'REDUCE_FREQUENCY_ALL', bucket?: Bucket }
```

- Rate = fall_offs in last 7 days / scheduled slots in last 7 days, for the cycle.
- No trigger below 4 raw falls, regardless of rate.
- Trigger at rate ≥ 0.40: if ≥60% of those falls share one bucket → `MOVE_CLUSTER` (that bucket); else → `REDUCE_FREQUENCY_ALL`.
- A cycle-level flag (`cycles` table needs no new column — derive "already fired" from the presence of a system-generated `amendments` row with `target->>'scope' = 'cycle_wide'`) prevents firing twice; a second trigger condition is logged to `CLARIFICATIONS.md`-style handling per the existing open item, not auto-resolved.

## 6. Test layers (CONTEXT.md §12, applies to `generate`; the amendment path has no model so layers 2–3 don't apply there)

1. Deterministic math — delta formula, ceiling back-off, completion bands: no DB, no network, no model.
2. Fixture provider — `MODEL_PROVIDER=fixture`, canned responses through the real `generate` function running locally via `supabase functions serve`.
3. Invariant tests — the four checks in §3, run against both fixture and (manually, in dev) live output.

## 7. Still deferred to ticket-time, not this spec

Exact React component structure, exact routing, exact Capacitor plugin choices beyond what's already decided (Preferences for session storage). Those are implementation detail within a ticket, not schema/contract decisions.
