// `/search`: search is the ⌘K palette, which this address opens. The page
// says so, and opens it again on demand.
import { useEffect, type JSX } from 'react'
import { Page } from '../../layout/Page.js'
import { useShell } from '../../layout/ShellContext.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Kbd, paletteShortcut } from '../../ui/Kbd.js'

export function SearchPage(): JSX.Element {
  const { openPalette } = useShell()
  useEffect(() => openPalette(), [openPalette])
  return (
    <Page
      crumbs={[{ label: 'Search' }]}
      title="Search"
      description="Projects, app IDs, runs, commits and branches."
    >
      <section className="m-card">
        <EmptyState
          icon="search"
          title="Search from anywhere"
          actions={
            <Button variant="primary" icon="search" onClick={openPalette}>
              Search
            </Button>
          }
        >
          Press <Kbd>{paletteShortcut()}</Kbd> on any page to find a project, an
          app ID, a run by its number, a commit or a branch.
        </EmptyState>
      </section>
    </Page>
  )
}
