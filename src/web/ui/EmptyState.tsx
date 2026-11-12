import type { JSX, ReactNode } from 'react'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'
import type { Tone } from './status.js'

export interface EmptyStateProps {
  icon?: IconName
  /** Colours the glyph by a status tone (an error, a warning). */
  tone?: Tone
  title?: ReactNode
  /** The title's level: `h1` when the state is the whole page (404, 403). */
  titleAs?: 'h1' | 'h2' | 'h3'
  /** Gives an `h1` title the page heading's id, so route changes focus it. */
  titleId?: string
  children?: ReactNode
  actions?: ReactNode
}

/** Nothing to show, an error, or a state of the whole page: a glyph, a title, a sentence and what to do. */
export function EmptyState({
  icon,
  tone,
  title,
  titleAs = 'h2',
  titleId,
  children,
  actions,
}: EmptyStateProps): JSX.Element {
  const Title = titleAs
  return (
    <div className="m-empty">
      {icon != null && (
        <div
          className="m-empty__glyph"
          style={tone == null ? undefined : { color: `var(--m-${tone}-solid)` }}
        >
          <Icon name={icon} />
        </div>
      )}
      {title != null && (
        <Title
          className="m-t-title2"
          id={titleId}
          tabIndex={titleId == null ? undefined : -1}
        >
          {title}
        </Title>
      )}
      {children != null && <p>{children}</p>}
      {actions != null && (
        <div className="m-row" style={{ justifyContent: 'center' }}>
          {actions}
        </div>
      )}
    </div>
  )
}
