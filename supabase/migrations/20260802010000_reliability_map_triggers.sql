-- Ticket 010: reliability map updater.
-- CONTEXT.md §9, §12; docs/SPEC.md §2 (`reliability_map` table, already
-- created by ticket 001's migration).
--
-- Reacts to rows appearing in `completions` / `fall_offs` — not to any
-- particular caller/UI — via AFTER INSERT triggers, so every future write
-- path (Today screen, I Fell Off screen, tests, an Edge Function) updates
-- the map identically without having to remember to call a shared helper.
--
-- On a `completions` insert: increment that slot's bucket's `.completions`
-- AND `.scheduled` for the owning user (a completed slot's scheduled time
-- has, by definition, passed).
-- On a `fall_offs` insert: increment `.scheduled` only — a fall-off is a
-- scheduled slot that did NOT complete.
--
-- `reliability_map` is scoped to `user_id`, not `cycle_id` (docs/SPEC.md §2,
-- CONTEXT.md §16/ADR-0001) — these upserts never reset across cycle
-- boundaries by construction, since there is no cycle_id anywhere in the
-- upsert key.

create or replace function reliability_map_on_completion() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_bucket bucket;
begin
  select c.user_id, s.bucket
    into v_user_id, v_bucket
    from slots s
    join commitments co on co.id = s.commitment_id
    join focus_areas fa on fa.id = co.focus_area_id
    join cycles c on c.id = fa.cycle_id
   where s.id = new.slot_id;

  if v_user_id is null then
    raise exception 'reliability_map_on_completion: no owning user found for slot %', new.slot_id;
  end if;

  insert into reliability_map (user_id, bucket, completions, scheduled)
  values (v_user_id, v_bucket, 1, 1)
  on conflict (user_id, bucket)
  do update set completions = reliability_map.completions + 1,
                scheduled = reliability_map.scheduled + 1;

  return new;
end;
$$;

create trigger completions_update_reliability_map
  after insert on completions
  for each row execute function reliability_map_on_completion();

create or replace function reliability_map_on_fall_off() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_bucket bucket;
begin
  -- fall_offs carries cycle_id denormalized already (docs/SPEC.md §2), so the
  -- owning user comes straight from cycles rather than re-walking the
  -- slots -> commitments -> focus_areas -> cycles chain.
  select c.user_id into v_user_id from cycles c where c.id = new.cycle_id;
  select s.bucket into v_bucket from slots s where s.id = new.slot_id;

  if v_user_id is null then
    raise exception 'reliability_map_on_fall_off: no owning user found for cycle %', new.cycle_id;
  end if;

  insert into reliability_map (user_id, bucket, completions, scheduled)
  values (v_user_id, v_bucket, 0, 1)
  on conflict (user_id, bucket)
  do update set scheduled = reliability_map.scheduled + 1;

  return new;
end;
$$;

create trigger fall_offs_update_reliability_map
  after insert on fall_offs
  for each row execute function reliability_map_on_fall_off();
