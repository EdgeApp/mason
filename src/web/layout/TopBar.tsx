import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { Link } from 'react-router'
import { useProfile } from '../profile/NodeProfile.js'
import { Icon } from '../ui/Icon.js'
import { Kbd, paletteShortcut } from '../ui/Kbd.js'
import { PAGE_TITLE_ID } from '../ui/PageHeader.js'
import { AccountMenu } from './AccountMenu.js'
import { ClusterChips } from './ClusterChips.js'
import { Notifications } from './Notifications.js'
import { useShell, type PageMeta } from './ShellContext.js'

/**
 * Whether the page's title has scrolled under the top bar: the narrow top
 * bar then shows it (the iOS 27 uniform toolbar).
 */
function useScrolledPast(
  bar: RefObject<HTMLElement | null>,
  title: string,
): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const check = (): void => {
      const heading = document.getElementById(PAGE_TITLE_ID)
      const bottom = bar.current?.getBoundingClientRect().bottom ?? 0
      setScrolled(
        window.scrollY > 0 &&
          heading != null &&
          heading.getBoundingClientRect().bottom <= bottom,
      )
    }
    check()
    window.addEventListener('scroll', check, { passive: true })
    return (): void => window.removeEventListener('scroll', check)
  }, [bar, title])
  return scrolled
}

/**
 * The top bar: on narrow the back chevron (named by the parent crumb) and
 * the page's title once it scrolls away; the search capsule (⌘K / Ctrl K);
 * the cluster chips on the master; notifications; the account menu.
 */
export function TopBar({ meta }: { meta: PageMeta }): JSX.Element {
  const { status, nav, openPalette } = useShell()
  const profile = useProfile()
  const bar = useRef<HTMLElement>(null)
  const scrolled = useScrolledPast(bar, meta.title)
  const shortcut = paletteShortcut()
  const cluster = status?.cluster
  return (
    <header
      ref={bar}
      className="m-app__top m-topbar m-glass"
      data-scrolled={scrolled ? '' : undefined}
    >
      {meta.back != null && (
        <Link
          className="m-topbar__back"
          to={meta.back.to}
          aria-label={`Back to ${meta.back.label}`}
        >
          <Icon name="chevron_left" />
          <span>{meta.back.label}</span>
        </Link>
      )}
      <span className="m-topbar__title" aria-hidden={!scrolled}>
        {meta.title}
      </span>
      <div className="m-topbar__search">
        <button
          type="button"
          className="m-searchcap"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={openPalette}
        >
          <Icon name="search" />
          <span>Search projects, apps, runs, commits…</span>
          <Kbd>{shortcut}</Kbd>
        </button>
      </div>
      <div className="m-topbar__end">
        {profile.clusterChips &&
          cluster != null &&
          nav.some((entry) => entry.key === 'dashboard') && (
            <ClusterChips
              cluster={cluster}
              nodesLink={nav.some((entry) => entry.key === 'nodes')}
            />
          )}
        <Notifications />
        <AccountMenu />
      </div>
    </header>
  )
}
