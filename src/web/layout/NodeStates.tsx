import { useEffect, type JSX } from 'react'
import { Button } from '../ui/Button.js'
import { EmptyState } from '../ui/EmptyState.js'
import { PAGE_TITLE_ID } from '../ui/PageHeader.js'
import { BareShell } from './BareShell.js'

/** A whole-page state of the node, in the bare shell, in one card. */
function NodeState({
  title,
  children,
}: {
  title: string
  children: JSX.Element
}): JSX.Element {
  useEffect(() => {
    document.title = `${title} · Mason`
  }, [title])
  return (
    <BareShell centred>
      <section className="m-card">{children}</section>
    </BareShell>
  )
}

/** A host no master has paired, or that has not yet synced: it serves nothing yet. */
export function WaitingForMaster({
  reload = (): void => window.location.reload(),
}: {
  reload?: () => void
}): JSX.Element {
  return (
    <NodeState title="Waiting for the master">
      <EmptyState
        icon="hourglass_top"
        title="This host is waiting for its master"
        titleAs="h1"
        titleId={PAGE_TITLE_ID}
        actions={
          <Button variant="secondary" icon="refresh" onClick={reload}>
            Reload
          </Button>
        }
      >
        It serves builds as soon as the master answers.
      </EmptyState>
    </NodeState>
  )
}

/** A host past its offline grace window: it serves nothing until the master answers. */
export function Maintenance({
  reload = (): void => window.location.reload(),
}: {
  reload?: () => void
}): JSX.Element {
  return (
    <NodeState title="Maintenance">
      <EmptyState
        icon="warning"
        tone="warning"
        title="Maintenance"
        titleAs="h1"
        titleId={PAGE_TITLE_ID}
        actions={
          <Button variant="secondary" icon="refresh" onClick={reload}>
            Reload
          </Button>
        }
      >
        This host has not reached its master for too long to serve builds
        safely. It comes back as soon as the master is reachable.
      </EmptyState>
    </NodeState>
  )
}

/** The node did not answer at all: nothing to show but a way to try again. */
export function Unreachable({
  message,
  retry,
}: {
  message: string
  retry: () => void
}): JSX.Element {
  return (
    <NodeState title="Mason is unreachable">
      <EmptyState
        icon="error"
        tone="danger"
        title="Mason could not be reached"
        titleAs="h1"
        titleId={PAGE_TITLE_ID}
        actions={
          <Button variant="secondary" icon="refresh" onClick={retry}>
            Try again
          </Button>
        }
      >
        {message}
      </EmptyState>
    </NodeState>
  )
}
