import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import {
  nodeInfo,
  renderApp,
  shellReplies,
  until,
  where,
} from '../test/render.js'
import { PAGE_ROUTES } from './routes.js'

afterEach(() => cleanup())

/** A record of the full loads the app asked for. */
const server = (
  here: string,
): { here: string; go: (url: string) => void; went: string[] } => {
  const went: string[] = []
  return { here, go: (url) => went.push(url), went }
}

describe('The routes the app has ported and the node’s own pages', () => {
  it('has ported Projects & apps, Artifacts, Search and the run page', () => {
    assert.deepEqual(
      PAGE_ROUTES.filter((route) => route.page != null).map(
        (route) => route.path,
      ),
      ['/projects', '/artifacts', '/search', '/runs/:id'],
    )
  })

  it('leaves for the node’s own page at an address it has not ported, outside the mount', async () => {
    const pages = server('/projects')
    renderApp({ path: '/nodes?tab=pools', server: pages })
    await screen.findByRole('status', { name: 'Opening the page' })
    await until(() => pages.went.length === 1, 'the full load')
    assert.deepEqual(pages.went, ['/nodes?tab=pools'])
  })

  it('draws the placeholder, never a full load, where the node answered the app itself', async () => {
    const pages = server('/nodes')
    renderApp({ path: '/nodes', server: pages })
    await screen.findByRole('heading', { name: 'Coming in M9' })
    assert.deepEqual(pages.went, [])
  })

  it('sends `/` to the node’s own home outside the mount when it is not Projects & apps', async () => {
    const pages = server('/projects')
    renderApp({
      node: nodeInfo('host'),
      path: '/',
      replies: shellReplies('developer', 'host'),
      server: pages,
    })
    await until(() => pages.went.length === 1, 'the full load')
    assert.deepEqual(pages.went, ['/'])
    cleanup()
    // Where the node answered the app at `/`, the first destination opens.
    renderApp({
      node: nodeInfo('host'),
      path: '/',
      replies: shellReplies('tester', 'host'),
      server: server('/'),
    })
    // …which is the node's own page too.
    await until(() => where.path === '/apps', 'Install apps')
  })

  it('opens the ⌘K palette at /search, and again from its button', async () => {
    renderApp({ path: '/search' })
    await screen.findByRole('heading', { level: 1, name: 'Search' })
    const field = await screen.findByRole('combobox', {
      name: 'Search projects, app IDs, runs, commits and branches',
    })
    assert(field.closest('dialog')!.open)
    fireEvent.keyDown(field.closest('dialog')!, { key: 'Escape' })
    assert.equal(document.querySelector('dialog'), null)
    await act(async () =>
      within(document.querySelector('main')!)
        .getByRole('button', { name: 'Search' })
        .click(),
    )
    await screen.findByRole('combobox', {
      name: 'Search projects, app IDs, runs, commits and branches',
    })
  })
})
