import { useState, type JSX } from 'react'
import { Link, useLocation } from 'react-router'
import { currentNav, tabBar, type NavItem } from '../profile/navigation.js'
import { Icon } from '../ui/Icon.js'
import { Sheet } from '../ui/Sheet.js'

/**
 * The narrow shell's floating tab-bar platter (the role's first four
 * destinations and More, or all of them when five or fewer) and its separate
 * round search button.
 */
export function TabBar({
  nav,
  onSearch,
}: {
  nav: NavItem[]
  onSearch: () => void
}): JSX.Element {
  const { pathname } = useLocation()
  const [more, setMore] = useState(false)
  const current = currentNav(pathname, nav)
  const { tabs, more: rest } = tabBar(nav)
  return (
    <nav className="m-app__tabbar m-tabbar m-glass" aria-label="Main">
      <div className="m-tabbar__platter m-glass">
        {tabs.map((entry) => (
          <Link
            key={entry.key}
            className="m-tabbar__item"
            to={entry.href}
            aria-current={entry === current ? 'page' : undefined}
            aria-label={entry.label === entry.short ? undefined : entry.label}
          >
            <Icon name={entry.icon} />
            <span>{entry.short}</span>
          </Link>
        ))}
        {rest.length > 0 && (
          <button
            type="button"
            className="m-tabbar__item"
            aria-current={
              current != null && rest.includes(current) ? 'page' : undefined
            }
            aria-haspopup="dialog"
            aria-expanded={more}
            onClick={() => setMore(true)}
          >
            <Icon name="menu" />
            <span>More</span>
          </button>
        )}
      </div>
      <button
        type="button"
        className="m-tabbar__search m-glass"
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={onSearch}
      >
        <Icon name="search" />
      </button>
      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <ul className="m-list m-more">
          {rest.map((entry) => (
            <li key={entry.key}>
              <Link
                className="m-list__row"
                to={entry.href}
                aria-current={entry === current ? 'page' : undefined}
                onClick={() => setMore(false)}
              >
                <Icon name={entry.icon} />
                <span className="m-list__main">
                  <span className="m-list__title">{entry.label}</span>
                </span>
                <Icon name="chevron_right" className="m-chev" />
              </Link>
            </li>
          ))}
        </ul>
      </Sheet>
    </nav>
  )
}
