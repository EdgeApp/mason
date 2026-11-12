import type { JSX } from 'react'
import { Link, useLocation } from 'react-router'
import { currentNav, type NavItem } from '../profile/navigation.js'
import { Icon } from '../ui/Icon.js'

/** The medium shell's rail: the logo and every destination, icon over a short label. */
export function Rail({ nav }: { nav: NavItem[] }): JSX.Element {
  const { pathname } = useLocation()
  const current = currentNav(pathname, nav)
  return (
    <nav className="m-app__rail m-rail m-glass" aria-label="Main">
      <img
        className="m-rail__logo"
        src="/assets/logo/mason-logo-64.png"
        alt="Mason"
        width="32"
        height="32"
      />
      {nav.map((entry) => (
        <Link
          key={entry.key}
          className="m-rail__item"
          to={entry.href}
          aria-current={entry === current ? 'page' : undefined}
          aria-label={entry.label === entry.short ? undefined : entry.label}
        >
          <Icon name={entry.icon} />
          <span>{entry.short}</span>
        </Link>
      ))}
    </nav>
  )
}
