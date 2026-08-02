import { Preferences } from '@capacitor/preferences'

// Backs the Supabase auth session in Capacitor's native Preferences
// (UserDefaults on iOS, SharedPreferences on Android) instead of
// localStorage, so the session survives normal app updates.
// See docs/adr/0003-anonymous-to-permanent-auth.md.
export const capacitorStorage = {
  async getItem(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key })
    return value
  },
  async setItem(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value })
  },
  async removeItem(key: string): Promise<void> {
    await Preferences.remove({ key })
  },
}
