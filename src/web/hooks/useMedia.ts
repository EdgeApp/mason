import { useSyncExternalStore } from 'react'

/** The narrow shell: phones, and short screens below the wide tier (DESIGN-LANGUAGE.md §8.1). */
export const NARROW =
  '(max-width: 46.49em), (max-height: 31.24em) and (max-width: 79.99em)'
/** The wide shell, with the sidebar. */
export const WIDE = '(min-width: 80em)'
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/** Whether a media query matches, kept current as it changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', changed)
      return () => media.removeEventListener('change', changed)
    },
    () => window.matchMedia(query).matches,
  )
}

export type Tier = 'narrow' | 'medium' | 'wide'

/** The shell's tier: narrow (tab bar), medium (rail) or wide (sidebar). */
export function useTier(): Tier {
  const narrow = useMedia(NARROW)
  const wide = useMedia(WIDE)
  return narrow ? 'narrow' : wide ? 'wide' : 'medium'
}
