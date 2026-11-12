import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { dom } from './setup.js'

describe('The web tests’ DOM', () => {
  it('puts a jsdom window on globalThis', () => {
    assert.equal(window, dom.window)
    assert.equal(document, dom.window.document)
    assert.equal(navigator, dom.window.navigator)
    assert.equal(location.origin, 'https://mason.test')
    assert.equal(typeof HTMLElement, 'function')
    localStorage.setItem('probe', '1')
    assert.equal(dom.window.localStorage.getItem('probe'), '1')
    localStorage.removeItem('probe')
  })

  it('answers every media query unmatched until a test says otherwise', () => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    assert.equal(media.matches, false)
    assert.equal(media.media, '(prefers-color-scheme: light)')
    media.addEventListener('change', () => undefined)
    media.removeEventListener('change', () => undefined)
    media.addListener(() => undefined)
    media.removeListener(() => undefined)
    assert.equal(media.dispatchEvent(new Event('change')), false)
  })
})
