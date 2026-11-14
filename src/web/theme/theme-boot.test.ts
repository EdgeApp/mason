import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'mocha'
import {
  APPEARANCE_KEY,
  bootTheme,
  readAppearance,
  themeFor,
} from './theme-boot.js'

/** A media query list whose scheme the test switches. */
function scheme(light: boolean): {
  list: MediaQueryList
  set: (light: boolean) => void
  listeners: () => number
} {
  const listeners = new Set<() => void>()
  const state = {
    matches: light,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_type: string, listener: () => void): Set<() => void> =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void): boolean =>
      listeners.delete(listener),
  }
  return {
    list: state as unknown as MediaQueryList,
    set: (value): void => {
      state.matches = value
      for (const listener of listeners) listener()
    },
    listeners: () => listeners.size,
  }
}

/** The page's window with its storage and media queries replaced. */
function page(options: {
  stored?: string | null
  storage?: 'throws'
  media?: MediaQueryList | 'throws'
}): Window {
  return {
    document,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    localStorage: {
      getItem: (key: string): string | null => {
        if (options.storage === 'throws') throw new Error('SecurityError')
        return key === APPEARANCE_KEY ? (options.stored ?? null) : null
      },
    },
    matchMedia: (): MediaQueryList => {
      if (options.media === 'throws') throw new Error('No media queries')
      return options.media ?? scheme(false).list
    },
  } as unknown as Window
}

const theme = (): string | undefined => document.documentElement.dataset.theme

describe('theme-boot', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme
    localStorage.clear()
  })

  it('reads Dark, Light and Match system, and Dark for anything else', () => {
    assert.equal(readAppearance(page({})), 'dark')
    assert.equal(readAppearance(page({ stored: 'dark' })), 'dark')
    assert.equal(readAppearance(page({ stored: 'light' })), 'light')
    assert.equal(readAppearance(page({ stored: 'system' })), 'system')
    assert.equal(readAppearance(page({ stored: 'sepia' })), 'dark')
  })

  it('survives storage that throws', () => {
    assert.equal(readAppearance(page({ storage: 'throws' })), 'dark')
    const stop = bootTheme(page({ storage: 'throws' }))
    assert.equal(theme(), 'dark')
    stop()
  })

  it('follows the OS scheme for Match system, dark when it cannot be read', () => {
    assert.equal(
      themeFor('system', page({ media: scheme(true).list })),
      'light',
    )
    assert.equal(
      themeFor('system', page({ media: scheme(false).list })),
      'dark',
    )
    assert.equal(themeFor('system', page({ media: 'throws' })), 'dark')
    assert.equal(
      themeFor('light', page({ media: scheme(false).list })),
      'light',
    )
    assert.equal(themeFor('dark', page({ media: scheme(true).list })), 'dark')
  })

  it('sets data-theme on <html> from storage, Dark by default', () => {
    for (const [stored, want] of [
      [null, 'dark'],
      ['dark', 'dark'],
      ['light', 'light'],
    ] as const) {
      const stop = bootTheme(page({ stored, media: scheme(true).list }))
      assert.equal(theme(), want, String(stored))
      stop()
    }
  })

  it('tracks the OS scheme while Match system is chosen, and stops on request', () => {
    const os = scheme(false)
    const stop = bootTheme(page({ stored: 'system', media: os.list }))
    assert.equal(theme(), 'dark')
    os.set(true)
    assert.equal(theme(), 'light')
    os.set(false)
    assert.equal(theme(), 'dark')
    stop()
    assert.equal(os.listeners(), 0)
    os.set(true)
    assert.equal(theme(), 'dark')
  })

  it('boots without media queries', () => {
    const stop = bootTheme(page({ stored: 'system', media: 'throws' }))
    assert.equal(theme(), 'dark')
    stop()
  })

  it('applies an Appearance another tab stores', () => {
    const stop = bootTheme()
    assert.equal(theme(), 'dark')
    localStorage.setItem(APPEARANCE_KEY, 'light')
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'unrelated', newValue: 'x' }),
    )
    assert.equal(theme(), 'dark')
    window.dispatchEvent(
      new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: 'light' }),
    )
    assert.equal(theme(), 'light')
    localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    assert.equal(theme(), 'dark')
    stop()
    localStorage.setItem(APPEARANCE_KEY, 'light')
    window.dispatchEvent(
      new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: 'light' }),
    )
    assert.equal(theme(), 'dark')
  })
})
