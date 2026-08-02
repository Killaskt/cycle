-- Ticket 001: initial schema — enums, all 12 tables, RLS on every table.
-- Source of truth: docs/SPEC.md §1-2. Do not add tables/columns beyond that spec.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

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
  review jsonb,                     -- cycle-close answers, see docs/SPEC.md §2f
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
  created_at timestamptz not null default now()
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
-- seed 'disinterest' -> 'motivation' per user on first cycle (CONTEXT.md §9a) — application-level, not this migration.

create table fall_offs (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots,
  cycle_id uuid not null references cycles,   -- denormalized for cycle-wide rate queries
  occurrence_in_slot int not null check (occurrence_in_slot >= 1),
  what_happened text not null,                -- verbatim, required at every occurrence
  tag_id uuid not null references tags,
  mood text,                                  -- null on 1st fall — see docs/agents/CLARIFICATIONS.md
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

-- ---------------------------------------------------------------------------
-- RLS — every table scoped by user_id directly, or via the obvious join to a
-- user_id-bearing parent (docs/SPEC.md §2, ticket 001).
-- ---------------------------------------------------------------------------

-- cycles: user_id directly
alter table cycles enable row level security;
create policy "cycles_owner" on cycles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- focus_areas: join cycle_id -> cycles.user_id
alter table focus_areas enable row level security;
create policy "focus_areas_owner" on focus_areas
  for all
  using (exists (
    select 1 from cycles c where c.id = focus_areas.cycle_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from cycles c where c.id = focus_areas.cycle_id and c.user_id = auth.uid()
  ));

-- commitments: join focus_area_id -> focus_areas.cycle_id -> cycles.user_id
alter table commitments enable row level security;
create policy "commitments_owner" on commitments
  for all
  using (exists (
    select 1 from focus_areas fa
    join cycles c on c.id = fa.cycle_id
    where fa.id = commitments.focus_area_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from focus_areas fa
    join cycles c on c.id = fa.cycle_id
    where fa.id = commitments.focus_area_id and c.user_id = auth.uid()
  ));

-- slots: join commitment_id -> commitments -> focus_areas -> cycles.user_id
alter table slots enable row level security;
create policy "slots_owner" on slots
  for all
  using (exists (
    select 1 from commitments co
    join focus_areas fa on fa.id = co.focus_area_id
    join cycles c on c.id = fa.cycle_id
    where co.id = slots.commitment_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from commitments co
    join focus_areas fa on fa.id = co.focus_area_id
    join cycles c on c.id = fa.cycle_id
    where co.id = slots.commitment_id and c.user_id = auth.uid()
  ));

-- completions: join slot_id -> slots -> commitments -> focus_areas -> cycles.user_id
alter table completions enable row level security;
create policy "completions_owner" on completions
  for all
  using (exists (
    select 1 from slots s
    join commitments co on co.id = s.commitment_id
    join focus_areas fa on fa.id = co.focus_area_id
    join cycles c on c.id = fa.cycle_id
    where s.id = completions.slot_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from slots s
    join commitments co on co.id = s.commitment_id
    join focus_areas fa on fa.id = co.focus_area_id
    join cycles c on c.id = fa.cycle_id
    where s.id = completions.slot_id and c.user_id = auth.uid()
  ));

-- tags: user_id directly (cross-cycle)
alter table tags enable row level security;
create policy "tags_owner" on tags
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- fall_offs: denormalized cycle_id -> cycles.user_id
alter table fall_offs enable row level security;
create policy "fall_offs_owner" on fall_offs
  for all
  using (exists (
    select 1 from cycles c where c.id = fall_offs.cycle_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from cycles c where c.id = fall_offs.cycle_id and c.user_id = auth.uid()
  ));

-- amendments: join fall_off_id -> fall_offs.cycle_id -> cycles.user_id
alter table amendments enable row level security;
create policy "amendments_owner" on amendments
  for all
  using (exists (
    select 1 from fall_offs fo
    join cycles c on c.id = fo.cycle_id
    where fo.id = amendments.fall_off_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from fall_offs fo
    join cycles c on c.id = fo.cycle_id
    where fo.id = amendments.fall_off_id and c.user_id = auth.uid()
  ));

-- blocked_windows: join cycle_id -> cycles.user_id
alter table blocked_windows enable row level security;
create policy "blocked_windows_owner" on blocked_windows
  for all
  using (exists (
    select 1 from cycles c where c.id = blocked_windows.cycle_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from cycles c where c.id = blocked_windows.cycle_id and c.user_id = auth.uid()
  ));

-- learnings: user_id directly (cross-cycle)
alter table learnings enable row level security;
create policy "learnings_owner" on learnings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- reliability_map: user_id directly (cross-cycle)
alter table reliability_map enable row level security;
create policy "reliability_map_owner" on reliability_map
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- load_factor: user_id directly (cross-cycle)
alter table load_factor enable row level security;
create policy "load_factor_owner" on load_factor
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Table-level grants — RLS policies gate row visibility but do not themselves
-- grant table-level privileges. Without these, PostgREST requests from
-- anon/authenticated fail with "permission denied for table X" regardless of
-- policy correctness. Mirrors Supabase's standard public-schema grant setup.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
