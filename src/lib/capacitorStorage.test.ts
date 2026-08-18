import { describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/preferences', () => {
  const store = new Map<string, string>()
  return {
    Preferences: {
      get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        store.set(key, value)
      }),
      remove: vi.fn(async ({ key }: { key: string }) => {
        store.delete(key)
      }),
    },
  }
})

import { Preferences } from '@capacitor/preferences'
import { capacitorStorage } from './capacitorStorage'

describe('capacitorStorage', () => {
  it('returns null for a key that was never set', async () => {
    await expect(capacitorStorage.getItem('missing')).resolves.toBeNull()
  })

  it('round-trips setItem -> getItem', async () => {
    await capacitorStorage.setItem('session', 'the-value')
    await expect(capacitorStorage.getItem('session')).resolves.toBe('the-value')
  })

  it('removeItem clears a previously set key', async () => {
    await capacitorStorage.setItem('session', 'the-value')
    await capacitorStorage.removeItem('session')
    await expect(capacitorStorage.getItem('session')).resolves.toBeNull()
  })

  it('delegates to the underlying Preferences plugin', async () => {
    await capacitorStorage.setItem('k', 'v')
    expect(Preferences.set).toHaveBeenCalledWith({ key: 'k', value: 'v' })

    await capacitorStorage.getItem('k')
    expect(Preferences.get).toHaveBeenCalledWith({ key: 'k' })

    await capacitorStorage.removeItem('k')
    expect(Preferences.remove).toHaveBeenCalledWith({ key: 'k' })
  })
})
