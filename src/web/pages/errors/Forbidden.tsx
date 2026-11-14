import type { JSX } from 'react'
import { useNavigate } from 'react-router'
import type { Role } from '../../../shared/permissions.js'
import type { Crumb } from '../../layout/Breadcrumbs.js'
import { Page } from '../../layout/Page.js'
import { useShell } from '../../layout/ShellContext.js'
import { audience } from '../../profile/navigation.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'

/** 403 inside the shell: names the page, who can open it and the viewer's role. */
export function Forbidden({
  title,
  least,
  crumbs,
}: {
  title: string
  least: Role
  crumbs: Crumb[]
}): JSX.Element {
  const { session } = useShell()
  const navigate = useNavigate()
  return (
    <Page crumbs={crumbs} title={title}>
      <section className="m-card">
        <EmptyState
          icon="lock"
          title={`${title} is for ${audience(least)}`}
          actions={
            <Button
              variant="secondary"
              icon="arrow_back"
              onClick={() => void navigate(-1)}
            >
              Go back
            </Button>
          }
        >
          Your role is {session.role}. Ask an administrator if you need access.
        </EmptyState>
      </section>
    </Page>
  )
}
