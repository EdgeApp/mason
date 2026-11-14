import type { JSX, ReactNode } from 'react'

/** The page heading's id: route changes move focus to it. */
export const PAGE_TITLE_ID = 'page-title'

export interface PageHeaderProps {
  title: ReactNode
  /** A status or kind pill beside the title. */
  pill?: ReactNode
  /** A line of facts under the title (when, where, who). */
  meta?: ReactNode
  /** One sentence about the page. */
  description?: ReactNode
  /** Blocks after the description: a reason, a disclosure. */
  details?: ReactNode
  /** The page's actions, on the right: at most one primary. */
  actions?: ReactNode
}

/** The page's one `h1`, its pill, description and actions. */
export function PageHeader({
  title,
  pill,
  meta,
  description,
  details,
  actions,
}: PageHeaderProps): JSX.Element {
  return (
    <header className="m-page__header">
      <div className="m-page__heading">
        <div className="m-page__titleline">
          <h1 className="m-t-title1" id={PAGE_TITLE_ID} tabIndex={-1}>
            {title}
          </h1>
          {pill}
        </div>
        {meta}
        {description != null && <p className="m-page__desc">{description}</p>}
        {details}
      </div>
      {actions != null && <div className="m-page__actions">{actions}</div>}
    </header>
  )
}
