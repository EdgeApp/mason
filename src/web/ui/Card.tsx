import type { JSX, ReactNode } from 'react'
import { cx } from './cx.js'

export interface CardProps {
  title?: ReactNode
  /** The title's heading level. */
  titleAs?: 'h2' | 'h3'
  /** Trailing header content: a status, a count, the card's actions. */
  actions?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  /** No shadow, for a card inside a busy layout. */
  flat?: boolean
  /** The body without its padding: a list or a table runs edge to edge. */
  flush?: boolean
  className?: string
  /** Names the card's section for assistive tech when it has no title. */
  label?: string
}

/** A titled group of content on a solid surface. Never a card in a card. */
export function Card({
  title,
  titleAs = 'h2',
  actions,
  footer,
  children,
  flat = false,
  flush = false,
  className,
  label,
}: CardProps): JSX.Element {
  const Title = titleAs
  return (
    <section
      className={cx('m-card', flat && 'm-card--flat', className)}
      aria-label={label}
    >
      {(title != null || actions != null) && (
        <header className="m-card__header">
          <div className="m-card__title">
            {title != null && <Title className="m-t-title3">{title}</Title>}
          </div>
          {actions}
        </header>
      )}
      {flush ? children : <div className="m-card__body">{children}</div>}
      {footer != null && <footer className="m-card__footer">{footer}</footer>}
    </section>
  )
}
