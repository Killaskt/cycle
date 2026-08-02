// Contract test — docs/SPEC.md §3 / CONTEXT.md §12: "contract-test every
// fixture against the validator to catch schema drift without a live
// call." Every checked-in fixture file must pass the same shape
// validator the real function runs, once a `focus_id` (request-specific,
// never stored in the file) is merged in the way provider.ts does it.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateModelResponse } from './validate'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))

describe('generate fixtures contract', () => {
  it('found at least one checked-in fixture file', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0)
  })

  it.each(fixtureFiles)('%s passes the model response validator', (file) => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8'))
    const withFocusId = { focus_id: 'contract-test-focus-id', ...raw }
    expect(validateModelResponse(withFocusId)).not.toBeNull()
  })
})
