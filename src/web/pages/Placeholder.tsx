import type { JSX } from 'react'
import { useLocation } from 'react-router'
import { Page } from '../layout/Page.js'
import type { Crumb } from '../layout/Breadcrumbs.js'
import { BareShell } from '../layout/BareShell.js'
import { buttonClass } from '../ui/Button.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Icon } from '../ui/Icon.js'
import type { IconName } from '../ui/icons.js'
import { PageHeader } from '../ui/PageHeader.js'

/** Where the node's own page for this address is: outside the app's mount. */
function ServerLink({ label }: { label: string }): JSX.Element {
  const { pathname, search } = useLocation()
  return (
    <a
      className={buttonClass({ variant: 'secondary' })}
      href={`${pathname}${search}`}
    >
      <Icon name="open_in_new" />
      {label}
    </a>
  )
}

/** The words of a page a later milestone ports. */
function Coming({
  milestone,
  icon,
}: {
  milestone: string
  icon: IconName
}): JSX.Element {
  return (
    <section className="m-card">
      <EmptyState
        icon={icon}
        title={`Coming in ${milestone}`}
        actions={<ServerLink label="Open the current page" />}
      >
        Mason still draws this page on the node. It moves into the app in
        {` ${milestone}`}; until then the current page has everything it shows.
      </EmptyState>
    </section>
  )
}

/** A signed-in page a later milestone fills: its header and what is coming. */
export function PlaceholderPage({
  crumbs,
  title,
  description,
  milestone,
  icon,
}: {
  crumbs: Crumb[]
  title: string
  description: string
  milestone: string
  icon: IconName
}): JSX.Element {
  return (
    <Page crumbs={crumbs} title={title} description={description}>
      <Coming milestone={milestone} icon={icon} />
    </Page>
  )
}

/** A signed-out page a later milestone fills, in the bare shell. */
export function SignedOutPlaceholder({
  title,
  description,
  milestone,
}: {
  title: string
  description: string
  milestone: string
}): JSX.Element {
  return (
    <BareShell>
      <PageHeader title={title} description={description} />
      <Coming milestone={milestone} icon="login" />
    </BareShell>
  )
}
