import { useEffect, type JSX, type ReactNode } from 'react'
import { PageHeader } from '../ui/PageHeader.js'
import { Breadcrumbs, type Crumb } from './Breadcrumbs.js'
import { useShell } from './ShellContext.js'
import { ShellBanners } from './ShellBanners.js'

export interface PageProps {
  /** The trail after the node's pill; the last is this page. */
  crumbs: Crumb[]
  title: string
  /** The `h1`'s content, when it is more than the title (a link). */
  heading?: ReactNode
  pill?: ReactNode
  meta?: ReactNode
  description?: ReactNode
  details?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}

/**
 * A signed-in page: breadcrumbs, the shell's banners, the header with the
 * one `h1`, then the content. It names itself to the top bar and the tab.
 */
export function Page({
  crumbs,
  title,
  heading,
  pill,
  meta,
  description,
  details,
  actions,
  children,
}: PageProps): JSX.Element {
  const { setMeta } = useShell()
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined
  const backLabel = parent?.label
  const backTo = parent?.to
  useEffect(() => {
    setMeta({
      title,
      ...(backLabel == null || backTo == null
        ? {}
        : { back: { label: backLabel, to: backTo } }),
    })
    document.title = `${title} · Mason`
  }, [setMeta, title, backLabel, backTo])
  return (
    <div className="m-page">
      <Breadcrumbs crumbs={crumbs} />
      <ShellBanners />
      <PageHeader
        title={heading ?? title}
        pill={pill}
        meta={meta}
        description={description}
        details={details}
        actions={actions}
      />
      {children}
    </div>
  )
}
