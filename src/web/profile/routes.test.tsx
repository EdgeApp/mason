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

describe('The app’s routes', () => {
  it('draws every page itself: Projects & apps, Artifacts, Search, the run page, the project pages, administration, Install apps and Devices', () => {
    assert.deepEqual(
      PAGE_ROUTES.map((route) => route.path),
      [
        '/projects',
        '/artifacts',
        '/search',
        '/runs/:id',
        '/projects/new',
        '/projects/:slug',
        '/projects/:slug/runs',
        '/projects/:slug/masonfile',
        '/projects/:slug/secrets',
        '/projects/:slug/apps/:appId',
        '/projects/:slug/apps/:appId/build-numbers',
        '/nodes',
        '/cloud',
        '/settings',
        '/people',
        '/groups',
        '/groups/:id',
        '/backups',
        '/account',
        '/apps',
        '/apps/:appId',
        '/apps/:appId/branches/:branchKey',
        '/devices',
        '/devices/complete/:token',
      ],
    )
  })

  it('opens Install apps from `/` for a tester on either node, naming the platform in the address', async () => {
    const apps = { apps: [], platforms: [] }
    for (const node of ['host', 'master'] as const) {
      renderApp({
        node: nodeInfo(node),
        path: '/',
        replies: shellReplies('tester', node, { '/api/v2/catalog/apps': apps }),
      })
      await screen.findByRole('heading', { level: 1, name: 'Install apps' })
      await screen.findByText('No apps have been configured yet.')
      await until(
        () => /^\/apps\?platform=\w+$/.test(where.path),
        'the platform',
      )
      cleanup()
    }
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
