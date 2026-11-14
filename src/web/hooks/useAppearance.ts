// The viewer's Appearance (Dark, Light, Match system), as theme-boot.js
// applied it before first paint: changing it here saves it in this browser
// and re-applies it to <html> at once.
import { useCallback, useSyncExternalStore } from 'react'
import {
  APPEARANCE_KEY,
  readAppearance,
  themeFor,
  type Appearance,
} from '../theme/theme-boot.js'

export type { Appearance }

/** The words the account menu and Your account show. */
export const APPEARANCE_LABELS: Record<Appearance, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'Match system',
}

const listeners = new Set<() => void>()

/** Saves an Appearance (if storage allows) and applies it to the page now. */
export function saveAppearance(
  appearance: Appearance,
  win: Window = window,
): void {
  try {
    win.localStorage.setItem(APPEARANCE_KEY, appearance)
  } catch {
    // Storage is unavailable (a private window): it applies until reload.
  }
  win.document.documentElement.dataset.theme = themeFor(appearance, win)
  current = appearance
  for (const listener of [...listeners]) listener()
}

/** What this page last applied, which storage may not hold (a private window). */
let current: Appearance | undefined

/** The viewer's Appearance and the way to change it. */
export function useAppearance(): [
  Appearance,
  (appearance: Appearance) => void,
] {
  const appearance = useSyncExternalStore(
    (changed) => {
      // Another tab's choice: storage decides again (theme-boot re-applies it).
      const onStorage = (): void => {
        current = undefined
        changed()
      }
      listeners.add(changed)
      window.addEventListener('storage', onStorage)
      return (): void => {
        listeners.delete(changed)
        window.removeEventListener('storage', onStorage)
      }
    },
    () => current ?? readAppearance(window),
  )
  const set = useCallback((value: Appearance) => saveAppearance(value), [])
  return [appearance, set]
}

/** Forgets what this page applied, so storage decides again (tests). */
export function resetAppearance(): void {
  current = undefined
}
