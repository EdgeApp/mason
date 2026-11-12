import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, it } from 'mocha'
import { App, basenameFor, start, WEB_BASENAME } from './main.js'

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

  it('mounts the app shell on #root under /_web', async () => {
    history.replaceState(null, '', '/_web/runs/12')
    const element = document.createElement('div')
    element.id = 'root'
    document.body.append(element)
    let root: ReturnType<typeof start>
    await act(async () => {
      root = start()
    })
    assert(root! != null)
    const main = element.querySelector('main#main')
    assert(main != null)
    assert(element.firstElementChild?.classList.contains('m-app'))
    await act(async () => {
      root!.unmount()
    })
  })

  it('renders the shell at the root and under the basename', () => {
    render(<App />)
    assert.equal(screen.getByRole('main').id, 'main')
    cleanup()
    history.replaceState(null, '', '/_web/projects')
    render(<App basename="/_web" />)
    assert.equal(screen.getByRole('main').tabIndex, -1)
  })
})
