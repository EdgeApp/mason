import type { JSX, ReactNode } from 'react'

/** A key or shortcut as the viewer types it. */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="m-kbd">{children}</kbd>
}

/** Whether the viewer's platform says ⌘ rather than Ctrl. */
export const isApple = (nav: Navigator = navigator): boolean =>
  /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent)

/** The palette's shortcut as this platform writes it. */
export const paletteShortcut = (nav: Navigator = navigator): string =>
  isApple(nav) ? '⌘K' : 'Ctrl K'
