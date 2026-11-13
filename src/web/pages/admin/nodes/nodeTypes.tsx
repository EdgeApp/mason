// The Nodes page's aside (screen-09-nodes): each node type by name, with
// what it installs in a few words, and a link to edit them in Settings.
import type { JSX } from 'react'
import { Link } from 'react-router'
import type { NodeTypeSoftware } from '../../../../shared/api/nodes.js'
import type { Resource } from '../../../hooks/useResource.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { Icon } from '../../../ui/Icon.js'
import { CardError, CardLoading } from './parts.js'

/** `3 Homebrew packages`: a count of a list, none when empty. */
const counted = (items: unknown[], word: string): string[] =>
  items.length === 0
    ? []
    : [`${items.length} ${word}${items.length === 1 ? '' : 's'}`]

/** A node type in a few words, what it installs and not its JSON: "Xcode 26.1, 16.4 · Node 24 · 3 Homebrew packages · Docker". */
export function nodeTypeSummary(software: NodeTypeSoftware): string {
  const version = (name: string, value: string | undefined): string[] =>
    value == null ? [] : [`${name} ${value}`]
  const parts = [
    ...(software.xcode == null || software.xcode.length === 0
      ? []
      : [`Xcode ${software.xcode.join(', ')}`]),
    ...version('Node', software.node),
    ...version('Java', software.java),
    ...version('Rust', software.rust),
    ...version('Python', software.python),
    ...version('Go', software.go),
    ...version('Ruby', software.ruby),
    ...counted(
      [...(software.brew?.formulae ?? []), ...(software.brew?.casks ?? [])],
      'Homebrew package',
    ),
    ...counted(
      [...(software.apt ?? []), ...(software.dnf ?? [])],
      'Linux package',
    ),
    ...counted(software.android ?? [], 'Android package'),
    ...(software.docker === true ? ['Docker'] : []),
  ]
  return parts.length === 0 ? 'Nothing managed yet' : parts.join(' · ')
}

/** The Node types card. */
export function NodeTypesCard({
  read,
}: {
  read: Resource<Record<string, NodeTypeSoftware>>
}): JSX.Element {
  const types = Object.entries(read.data ?? {})
  return (
    <section className="m-card" aria-labelledby="nodes-types-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="tune" />
          <h2 className="m-t-title3" id="nodes-types-title">
            Node types
          </h2>
        </div>
        <Link className="m-t-subhead" to="/settings#nodeTypes">
          Edit in Settings
        </Link>
      </header>
      {read.data == null ? (
        read.error != null ? (
          <CardError
            what="The node types"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <CardLoading label="Loading the node types" />
        )
      ) : types.length === 0 ? (
        <EmptyState icon="tune" title="None yet." />
      ) : (
        <ul className="m-list">
          {types.map(([name, software]) => (
            <li key={name} className="m-list__row">
              <span className="m-list__main">
                <span className="m-t-mono m-nodes__name">{name}</span>
                <span className="m-list__sub">{nodeTypeSummary(software)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
