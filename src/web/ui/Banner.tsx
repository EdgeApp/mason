import { useState, type JSX, type ReactNode } from 'react'
import { Button } from './Button.js'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'

export type BannerTone = 'danger' | 'warning' | 'info' | 'success'

const ICONS: Record<BannerTone, IconName> = {
  danger: 'error',
  warning: 'warning',
  info: 'info',
  success: 'check_circle',
}

export interface BannerProps {
  tone: BannerTone
  icon?: IconName
  title: ReactNode
  /** One sentence on what it means. */
  children?: ReactNode
  /** A mono line: when, which. */
  meta?: ReactNode
  /** Its action: Retry, Reload, Open Backups. */
  actions?: ReactNode
  /** The one-line form, for informational lines. */
  compact?: boolean
  /** Announce it politely when it appears (master unreachable). */
  announce?: boolean
}

/** A condition affecting the page, with what to do about it. */
export function Banner({
  tone,
  icon,
  title,
  children,
  meta,
  actions,
  compact = false,
  announce = false,
}: BannerProps): JSX.Element {
  return (
    <div
      className={cx(
        'm-banner',
        `m-banner--${tone}`,
        compact && 'm-banner--compact',
      )}
      role={announce ? 'status' : undefined}
    >
      <Icon name={icon ?? ICONS[tone]} />
      <div className="m-banner__body">
        <span className="m-banner__title">{title}</span>
        {children != null && (
          <span className="m-t-callout m-secondary">{children}</span>
        )}
        {meta != null && <span className="m-banner__meta">{meta}</span>}
      </div>
      {actions != null && <div className="m-banner__actions">{actions}</div>}
    </div>
  )
}

/** A banner in a stack, with its tone deciding its place. */
export interface BannerItem {
  key: string
  tone: BannerTone
  node: ReactNode
}

const SEVERITY: Record<BannerTone, number> = {
  danger: 0,
  warning: 1,
  info: 2,
  success: 3,
}

/** Most severe first; equal ones keep their order. */
export const bySeverity = (items: BannerItem[]): BannerItem[] =>
  items
    .map((item, n) => ({ item, n }))
    .sort((a, b) => SEVERITY[a.item.tone] - SEVERITY[b.item.tone] || a.n - b.n)
    .map(({ item }) => item)

/** How many banners show before the rest collapse. */
export const SHOWN_BANNERS = 2

/**
 * The page's banners: up to two, most severe first; any more collapse into
 * "+N more notices", which shows them.
 */
export function Banners({
  items,
}: {
  items: BannerItem[]
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const sorted = bySeverity(items)
  const hidden = sorted.length - SHOWN_BANNERS
  const shown =
    expanded || hidden <= 0 ? sorted : sorted.slice(0, SHOWN_BANNERS)
  return (
    <section className="m-banners" aria-label="Notices">
      {shown.map((item) => (
        <div key={item.key} style={{ display: 'contents' }}>
          {item.node}
        </div>
      ))}
      {hidden > 0 && (
        <Button
          variant="plain"
          size="sm"
          className="m-banners__more"
          aria-expanded={expanded}
          onClick={() => setExpanded((was) => !was)}
        >
          {expanded
            ? 'Show fewer notices'
            : `+${hidden} more ${hidden === 1 ? 'notice' : 'notices'}`}
        </Button>
      )}
    </section>
  )
}
