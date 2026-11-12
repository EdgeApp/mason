import assert from 'node:assert/strict'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { ApiClient } from './api/client.js'
import { App, basenameFor, Root, start, WEB_BASENAME } from './main.js'
import { fakeNode, nodeInfo, shellReplies, until } from './test/render.js'

describe('The web app entry', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    history.replaceState(null, '', '/')
  })

  it('uses the /_web basename only inside that mount', () => {
    assert.equal(WEB_BASENAME, '/_web')
    assert.equal(basenameFor('/_web'), '/_web')
    assert.equal(basenameFor('/_web/'), '/_web')
    assert.equal(basenameFor('/_web/runs/12'), '/_web')
    assert.equal(basenameFor('/'), undefined)
    assert.equal(basenameFor('/_webby'), undefined)
    assert.equal(basenameFor('/runs/12'), undefined)
  })

  it('mounts nothing on a page without #root', () => {
    assert.equal(start(document), undefined)
  })

  it('mounts on #root under /_web, reads the node and leaves for sign-in on a 401', async () => {
    history.replaceState(null, '', '/_web/projects')
    const element = document.createElement('div')
    element.id = 'root'
    document.body.append(element)
    const sent: string[] = []
    const original = globalThis.fetch
    const assigned: string[] = []
    globalThis.fetch = (async (url: string) => {
      sent.push(String(url))
      if (url === '/api/v2/node')
        return new Response(JSON.stringify(nodeInfo('host')), { status: 200 })
      return new Response('{"error":"Sign in"}', { status: 401 })
    }) as typeof fetch
    let root: ReturnType<typeof start>
    try {
      await act(async () => {
        root = start(document, (url) => assigned.push(url))
      })
      await until(() => assigned.length > 0, 'the sign-in redirect')
      assert.equal(assigned[0], '/auth/login?return=%2F_web%2Fprojects')
      assert(sent.includes('/api/v2/node'))
    } finally {
      globalThis.fetch = original
      await act(async () => root?.unmount())
    }
  })

  it('shows the node’s waiting and maintenance states before anything else', () => {
    const client = new ApiClient({
      signIn: '/sign-in',
      fetch: fakeNode({}).fetch,
    })
    render(
      <App
        node={nodeInfo('host', { state: 'waitingForMaster' })}
        client={client}
      />,
    )
    screen.getByRole('heading', {
      level: 1,
      name: 'This host is waiting for its master',
    })
    cleanup()
    render(
      <App node={nodeInfo('host', { state: 'maintenance' })} client={client} />,
    )
    screen.getByRole('heading', { level: 1, name: 'Maintenance' })
    assert.equal(document.title, 'Maintenance · Mason')
  })

  it('renders the signed-in shell under the basename once the node and session answer', async () => {
    history.replaceState(null, '', '/_web/artifacts')
    const node = fakeNode({
      '/api/v2/node': nodeInfo(),
      ...shellReplies('developer'),
    })
    const client = new ApiClient({ signIn: '/sign-in', fetch: node.fetch })
    const told: string[] = []
    render(
      <Root
        client={client}
        basename="/_web"
        onNode={(info) => told.push(info.role)}
      />,
    )
    await screen.findByRole('heading', { level: 1, name: 'Artifacts' })
    assert.deepEqual(told, ['master'])
    assert.equal(screen.getByRole('main').id, 'main')
  })

  it('says the node could not be reached, and tries again', async () => {
    let up = false
    const node = fakeNode({
      '/api/v2/node': () =>
        up
          ? new Response(
              JSON.stringify(nodeInfo('master', { setupNeeded: true })),
            )
          : Promise.reject(new TypeError('fetch failed')),
    })
    const client = new ApiClient({ signIn: '/sign-in', fetch: node.fetch })
    render(<Root client={client} />)
    await screen.findByRole('heading', { name: 'Mason could not be reached' })
    up = true
    await act(async () =>
      screen.getByRole('button', { name: 'Try again' }).click(),
    )
    await screen.findByRole('heading', { level: 1, name: 'Set up Mason' })
  })
})
