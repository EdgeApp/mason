import type { JSX } from 'react'
import { Page } from '../../layout/Page.js'
import { useShell } from '../../layout/ShellContext.js'
import { homeFor } from '../../profile/navigation.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'

/** 404 inside the shell: the address names no page here. */
export function NotFound(): JSX.Element {
  const { nav, openPalette } = useShell()
  const home = nav[0]
  return (
    <Page crumbs={[{ label: 'Not found' }]} title="Not found">
      <section className="m-card">
        <EmptyState
          icon="search"
          title="There is no such page"
          actions={
            <>
              <ButtonLink variant="primary" to={homeFor(nav)}>
                {home?.label ?? 'Your account'}
              </ButtonLink>
              <Button variant="secondary" icon="search" onClick={openPalette}>
                Search
              </Button>
            </>
          }
        >
          The address may be mistyped, or the page moved.
        </EmptyState>
      </section>
    </Page>
  )
}
