import { describe, expect, it } from 'vitest'
import { isValidBucket, validateModelResponse } from './validate'

describe('isValidBucket', () => {
  it('accepts every one of the 12 enum values', () => {
    expect(isValidBucket('weekday_early_morning')).toBe(true)
    expect(isValidBucket('weekend_night')).toBe(true)
  })

  it('rejects a non-enum string', () => {
    expect(isValidBucket('not_a_real_bucket')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isValidBucket(42)).toBe(false)
    expect(isValidBucket(null)).toBe(false)
    expect(isValidBucket(undefined)).toBe(false)
  })
})

describe('validateModelResponse', () => {
  const valid = {
    focus_id: 'abc-123',
    commitment_name: 'Morning Run',
    session_shape: 'single continuous run',
    preferred_bucket: 'weekday_morning',
    rationale: 'Consistency before the day gets busy.',
  }

  it('accepts a fully-shaped response', () => {
    expect(validateModelResponse(valid)).toEqual(valid)
  })

  it('rejects a non-object', () => {
    expect(validateModelResponse('nope')).toBeNull()
    expect(validateModelResponse(null)).toBeNull()
    expect(validateModelResponse(undefined)).toBeNull()
  })

  it('rejects an out-of-enum preferred_bucket', () => {
    expect(validateModelResponse({ ...valid, preferred_bucket: 'not_a_real_bucket' })).toBeNull()
  })

  it('rejects a missing field', () => {
    const { rationale: _rationale, ...missingRationale } = valid
    expect(validateModelResponse(missingRationale)).toBeNull()
  })

  it('rejects an empty string field', () => {
    expect(validateModelResponse({ ...valid, commitment_name: '   ' })).toBeNull()
  })

  it('rejects a wrong-typed field', () => {
    expect(validateModelResponse({ ...valid, session_shape: 42 })).toBeNull()
  })
})
