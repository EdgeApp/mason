// The web app's entry: bundle-web.mjs builds it into app-[hash].js, which
// index.html loads as a module. It mounts the router on #root.
import { StrictMode, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AppShell } from './layout/AppShell.js'

/** Where the master and the host mount the app beside the server pages. */
export const WEB_BASENAME = '/_web'

/** The router's basename: `/_web` inside that mount, none outside it. */
export function basenameFor(pathname: string): string | undefined {
  return pathname === WEB_BASENAME || pathname.startsWith(`${WEB_BASENAME}/`)
    ? WEB_BASENAME
    : undefined
}

/** The app's routes under one basename. */
export function App({ basename }: { basename?: string }): JSX.Element {
  return (
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="*" element={<AppShell />} />
      </Routes>
    </BrowserRouter>
  )
}

/** Mounts the app on the page's #root, if it has one. */
export function start(doc: Document = document): Root | undefined {
  const element = doc.getElementById('root')
  if (element == null) return undefined
  const root = createRoot(element)
  root.render(
    <StrictMode>
      <App basename={basenameFor(doc.location.pathname)} />
    </StrictMode>,
  )
  return root
}

start()
