import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { DB_URL } from './localSupabase'

// Ticket 001 DoD: every table in docs/SPEC.md §2 exists with its expected
// columns, both enums exist with all listed values, and RLS is enabled on
// every table. Queried directly against Postgres (not PostgREST) since
// information_schema/pg_catalog aren't exposed over the REST API.

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

const expectedColumns: Record<string, string[]> = {
  cycles: [
    'id', 'user_id', 'status', 'timeframe_days', 'wake_time',
    'normal_day_notes', 'regenerate_used', 'started_at', 'closes_at',
    'review', 'created_at',
  ],
  focus_areas: [
    'id', 'cycle_id', 'name', 'target_freq', 'target_dur',
    'current_freq', 'current_dur', 'intake_order', 'created_at',
  ],
  commitments: [
    'id', 'focus_area_id', 'name', 'session_shape', 'freq', 'dur',
    'bucket', 'rationale', 'from_fallback', 'created_at',
  ],
  slots: [
    'id', 'commitment_id', 'scheduled_date', 'bucket', 'status', 'created_at',
  ],
  completions: ['id', 'slot_id', 'completed_at'],
  tags: ['id', 'user_id', 'label', 'classification', 'created_at'],
  fall_offs: [
    'id', 'slot_id', 'cycle_id', 'occurrence_in_slot', 'what_happened',
    'tag_id', 'mood', 'agent_followup_question', 'agent_followup_answer',
    'created_at',
  ],
  amendments: [
    'id', 'fall_off_id', 'action', 'target', 'params', 'reasoning',
    'confidence', 'proposed_by', 'user_response', 'rejection_reason',
    'revised_action', 'revised_target', 'revised_params', 'created_at',
  ],
  blocked_windows: [
    'id', 'cycle_id', 'date', 'affected_slot_id', 'created_at',
  ],
  learnings: [
    'id', 'user_id', 'tag_id', 'action', 'confidence', 'sample_size',
    'updated_at',
  ],
  reliability_map: [
    'id', 'user_id', 'bucket', 'completions', 'scheduled',
  ],
  load_factor: ['user_id', 'last_cycle_completed_minutes', 'updated_at'],
}

const bucketValues = [
  'weekday_early_morning', 'weekday_morning', 'weekday_midday',
  'weekday_afternoon', 'weekday_evening', 'weekday_night',
  'weekend_early_morning', 'weekend_morning', 'weekend_midday',
  'weekend_afternoon', 'weekend_evening', 'weekend_night',
]

const actionTypeValues = [
  'NONE', 'MOVE', 'SHORTEN', 'REDUCE_FREQUENCY', 'REALLOCATE',
  'EASE_NEXT_DAY', 'REMOVE', 'UNHANDLED',
]

describe('schema: enums', () => {
  it('bucket enum has all 12 values', async () => {
    const res = await client.query(
      `select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname = 'bucket' order by e.enumsortorder`,
    )
    expect(res.rows.map((r) => r.enumlabel)).toEqual(bucketValues)
  })

  it('action_type enum has all 8 values', async () => {
    const res = await client.query(
      `select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname = 'action_type' order by e.enumsortorder`,
    )
    expect(res.rows.map((r) => r.enumlabel)).toEqual(actionTypeValues)
  })
})

describe('schema: tables', () => {
  for (const [table, columns] of Object.entries(expectedColumns)) {
    it(`${table} exists with expected columns`, async () => {
      const res = await client.query(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [table],
      )
      const actual = res.rows.map((r) => r.column_name)
      expect(actual.length).toBeGreaterThan(0) // table exists
      for (const col of columns) {
        expect(actual).toContain(col)
      }
    })
  }
})

describe('schema: RLS enabled on every table', () => {
  it('all 12 tables have rowsecurity = true', async () => {
    const tables = Object.keys(expectedColumns)
    const res = await client.query(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = any($1)`,
      [tables],
    )
    expect(res.rows).toHaveLength(tables.length)
    for (const row of res.rows) {
      expect(row.rowsecurity, `${row.tablename} should have RLS enabled`).toBe(true)
    }
  })

  it('all 12 tables have at least one policy', async () => {
    const tables = Object.keys(expectedColumns)
    const res = await client.query(
      `select tablename, count(*)::int as policy_count from pg_policies where schemaname = 'public' and tablename = any($1) group by tablename`,
      [tables],
    )
    const counts = new Map(res.rows.map((r) => [r.tablename, r.policy_count]))
    for (const table of tables) {
      expect(counts.get(table) ?? 0, `${table} should have >=1 policy`).toBeGreaterThan(0)
    }
  })
})
