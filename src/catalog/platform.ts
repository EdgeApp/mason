import { asPlatform, type Platform, text } from '../validation.js'
export const labels: Record<Platform, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
}
export function platform(
  query: unknown,
  preference: string | undefined,
  userAgent: string,
): Platform {
  if (query != null) return asPlatform(query)
  if (preference != null) {
    try {
      return asPlatform(preference)
    } catch {
      /* Ignore stale preferences. */
    }
  }
  if (/iPad|iPhone|iPod/i.test(userAgent)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  if (/Macintosh|Mac OS/i.test(userAgent)) return 'macos'
  if (/Windows/i.test(userAgent)) return 'windows'
  return 'ios'
}
export const branchKey = (branch: string): string =>
  Buffer.from(text(256)(branch)).toString('base64url')
export function branchName(key: unknown): string {
  const value = text(1400)(key)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid branch key')
  const branch = text(256)(
    new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(value, 'base64url'),
    ),
  )
  if (branchKey(branch) !== value) throw new Error('Noncanonical branch key')
  return branch
}
