-- Ticket 013: 3rd fall-off on the same slot escalates to REMOVE
-- (CONTEXT.md §9a, §9d; docs/adr/0004-agent-proposes-code-disposes-action-
-- enum.md). REMOVE must actually take a commitment out of play in the DB,
-- but a hard `delete from commitments` cascades to `slots` (`on delete
-- cascade`) which then hits `fall_offs.slot_id`'s un-cascaded FK to `slots`
-- and fails for any commitment with fall-off history — which a 3rd-fall-
-- triggered REMOVE always has, by definition (the 3rd fall itself just got
-- inserted). Deleting fall_offs/amendments rows to allow a hard delete would
-- destroy exactly the retention data CONTEXT.md's thesis depends on (§1,
-- §16 — "get right now: what gets captured, and retention"). A soft-delete
-- flag is the only option that doesn't destroy history.

alter table commitments add column removed_at timestamptz;
-- null = active (default, all existing rows). Set once, at REMOVE time
-- (src/lib/amendment.ts applyAction's REMOVE case). Future tickets that need
-- to filter to only-active commitments (014 cycle-wide overload's "every
-- active commitment", 018 between-cycle regeneration) should read
-- `removed_at is null` as that filter.
