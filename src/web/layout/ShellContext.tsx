// What the signed-in shell knows and every page may read: the viewer's
// session, the node's status, the viewer's destinations, and how a page tells
// the top bar its title.
import { createContext, useContext } from 'react'
import type { SessionInfo, StatusInfo } from '../../shared/api/index.js'
import type { NavItem } from '../profile/navigation.js'

/** What a page tells the top bar: its title, and its parent for the narrow back chevron. */
export interface PageMeta {
  title: string
  back?: { label: string; to: string }
}

export interface Shell {
  session: SessionInfo
  /** The latest status (live, else read); none before the first answer. */
  status: StatusInfo | undefined
  /** Reads the status again (Retry on the offline banner). */
  reloadStatus: () => void
  nav: NavItem[]
  openPalette: () => void
  setMeta: (meta: PageMeta) => void
}

export const ShellContext = createContext<Shell | undefined>(undefined)

/** The signed-in shell around the page. */
export function useShell(): Shell {
  const shell = useContext(ShellContext)
  if (shell == null) throw new Error('useShell needs the AppShell')
  return shell
}
