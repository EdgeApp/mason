import type { JSX } from 'react'
import { Link } from 'react-router'
import { useProfile } from '../profile/NodeProfile.js'
import { Icon } from '../ui/Icon.js'

/** One level of a page's trail; the last is the page itself. */
export interface Crumb {
  label: string
  to?: string
}

/**
 * The trail on every signed-in page: the node's pill first (it opens the
 * node's home), then each level; the last is the current page, in text
 * colour, not a link.
 */
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }): JSX.Element {
  const profile = useProfile()
  return (
    <nav aria-label="Breadcrumb">
      <ol className="m-crumbs">
        <li>
          <Link className="m-node-pill" to="/">
            <Icon name="lan" size="sm" />
            {profile.name}
          </Link>
        </li>
        {crumbs.map((crumb, n) => (
          <li key={`${n}-${crumb.label}`}>
            {n === crumbs.length - 1 || crumb.to == null ? (
              <span aria-current={n === crumbs.length - 1 ? 'page' : undefined}>
                {crumb.label}
              </span>
            ) : (
              <Link to={crumb.to}>{crumb.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
