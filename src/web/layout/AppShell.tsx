import type { JSX } from 'react'
import { Outlet } from 'react-router'

/**
 * The signed-in app's frame. For now it holds only the main landmark; the
 * sidebar, rail, top bar and tab bar join it with the node profiles.
 */
export function AppShell(): JSX.Element {
  return (
    <div className="m-app">
      <main id="main" className="m-app__main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
