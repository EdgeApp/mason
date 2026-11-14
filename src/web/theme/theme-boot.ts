// Applies the viewer's Appearance before the first paint. bundle-web.mjs
// builds it into theme-boot.js, which index.html loads synchronously before
// the stylesheet, and which calls bootTheme() at once.

/** Where the account menu keeps the viewer's Appearance. */
export const APPEARANCE_KEY = 'mason-appearance'

/** What the viewer chose: a theme, or Match system. */
export type Appearance = 'dark' | 'light' | 'system'
/** What the page shows: tokens.css's `[data-theme]`. */
export type Theme = 'dark' | 'light'

const LIGHT_SCHEME = '(prefers-color-scheme: light)'

/**
 * The stored Appearance. Dark, the default, when nothing valid is stored or
 * storage throws (a private window, blocked site data).
 */
export function readAppearance(win: Window): Appearance {
  try {
    const value = win.localStorage.getItem(APPEARANCE_KEY)
    if (value === 'light' || value === 'system') return value
  } catch {
    // Storage is unavailable; the default applies.
  }
  return 'dark'
}

/** The system's scheme, if the browser can say; dark otherwise. */
function systemScheme(win: Window): MediaQueryList | undefined {
  try {
    return win.matchMedia(LIGHT_SCHEME)
  } catch {
    return undefined
  }
}

/** The theme an Appearance shows: Match system follows the OS scheme. */
export function themeFor(appearance: Appearance, win: Window): Theme {
  if (appearance !== 'system') return appearance
  return systemScheme(win)?.matches === true ? 'light' : 'dark'
}

/**
 * Sets `data-theme` on `<html>` from the stored Appearance, and again when
 * the OS scheme changes or another tab changes the Appearance. Returns a
 * function that stops listening.
 */
export function bootTheme(win: Window = window): () => void {
  const apply = (): void => {
    win.document.documentElement.dataset.theme = themeFor(
      readAppearance(win),
      win,
    )
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === APPEARANCE_KEY || event.key == null) apply()
  }
  apply()
  const media = systemScheme(win)
  media?.addEventListener('change', apply)
  win.addEventListener('storage', onStorage)
  return (): void => {
    media?.removeEventListener('change', apply)
    win.removeEventListener('storage', onStorage)
  }
}
