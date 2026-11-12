import assert from 'node:assert/strict'
import { act, cleanup, render, screen } from '@testing-library/react'
import { asNumber, asObject } from 'cleaners'
import { afterEach, describe, it } from 'mocha'
import type { JSX } from 'react'
import { ApiClient } from '../api/client.js'
import { ApiProvider, useApi } from '../api/context.js'
import { Invalidations, LiveProvider } from '../live/LiveProvider.js'
import { fakeNode, matchMedia, narrow, until, wide } from '../test/render.js'
import { APPEARANCE_KEY } from '../theme/theme-boot.js'
import {
  resetAppearance,
  saveAppearance,
  useAppearance,
} from './useAppearance.js'
import { NARROW, useMedia, useTier, WIDE } from './useMedia.js'
import { useResource } from './useResource.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetAppearance()
  delete document.documentElement.dataset.theme
})

describe('Media queries', () => {
  it('tells the shell its tier and follows changes', async () => {
    function Tier(): JSX.Element {
      return (
        <p>
          {useTier()} {String(useMedia(NARROW))}
        </p>
      )
    }
    let restore = matchMedia(narrow)
    render(<Tier />)
    screen.getByText('narrow true')
    cleanup()
    restore()
    restore = matchMedia(wide)
    render(<Tier />)
    screen.getByText('wide false')
    cleanup()
    restore()
    render(<Tier />)
    screen.getByText('medium false')
    assert.equal(WIDE, '(min-width: 80em)')
  })

  it('re-renders when a query starts to match', async () => {
    let matches = false
    const listeners: Array<() => void> = []
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      addEventListener: (_: string, listener: () => void): number =>
        listeners.push(listener),
      removeEventListener: (): undefined => undefined,
    })) as unknown as typeof window.matchMedia
    try {
      function Probe(): JSX.Element {
        return <p>{String(useMedia('(x)'))}</p>
      }
      render(<Probe />)
      screen.getByText('false')
      matches = true
      await act(async () => {
        for (const listener of listeners) listener()
      })
      screen.getByText('true')
    } finally {
      window.matchMedia = original
    }
  })
})

describe('Appearance', () => {
  function Choice(): JSX.Element {
    const [appearance, setAppearance] = useAppearance()
    return (
      <>
        <p>{appearance}</p>
        <button onClick={() => setAppearance('light')}>Light</button>
        <button onClick={() => setAppearance('system')}>System</button>
        <button onClick={() => setAppearance('dark')}>Dark</button>
      </>
    )
  }

  it('starts from what theme-boot read, saves each choice in this browser and applies it at once', async () => {
    localStorage.setItem(APPEARANCE_KEY, 'system')
    render(<Choice />)
    screen.getByText('system')
    await act(async () => screen.getByRole('button', { name: 'Light' }).click())
    screen.getByText('light')
    assert.equal(localStorage.getItem(APPEARANCE_KEY), 'light')
    assert.equal(document.documentElement.dataset.theme, 'light')
    const restore = matchMedia(
      (query) => query === '(prefers-color-scheme: light)',
    )
    try {
      await act(async () =>
        screen.getByRole('button', { name: 'System' }).click(),
      )
      assert.equal(document.documentElement.dataset.theme, 'light')
    } finally {
      restore()
    }
    await act(async () => screen.getByRole('button', { name: 'Dark' }).click())
    assert.equal(localStorage.getItem(APPEARANCE_KEY), 'dark')
    assert.equal(document.documentElement.dataset.theme, 'dark')
  })

  it('follows another tab’s choice', async () => {
    render(<Choice />)
    await act(async () => screen.getByRole('button', { name: 'Light' }).click())
    localStorage.setItem(APPEARANCE_KEY, 'system')
    await act(async () =>
      window.dispatchEvent(
        new window.StorageEvent('storage', { key: APPEARANCE_KEY }),
      ),
    )
    screen.getByText('system')
  })

  it('still applies a choice when storage throws, until the page reloads', () => {
    const win = {
      localStorage: {
        setItem: () => {
          throw new Error('blocked')
        },
      },
      document: { documentElement: { dataset: {} as Record<string, string> } },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window
    saveAppearance('light', win)
    assert.equal(win.document.documentElement.dataset.theme, 'light')
  })
})

describe('Reads through the typed client', () => {
  const asCount = asObject({ count: asNumber })

  function Count({
    path,
    topics,
  }: {
    path: string | null
    topics?: Array<'status' | 'queue'>
  }): JSX.Element {
    const { data, error, loading, reload } = useResource(
      path,
      asCount,
      topics == null ? {} : { invalidatedBy: topics },
    )
    return (
      <>
        <p data-testid="count">{data?.count ?? '-'}</p>
        <p data-testid="error">{error?.message ?? ''}</p>
        <p data-testid="loading">{String(loading)}</p>
        <button onClick={reload}>Reload</button>
      </>
    )
  }
  const text = (id: string): string => screen.getByTestId(id).textContent!

  const mount = (
    node: ReturnType<typeof fakeNode>,
    element: JSX.Element,
  ): {
    invalidations: Invalidations
    rerender: (element: JSX.Element) => Promise<void>
  } => {
    const client = new ApiClient({
      signIn: '/sign-in',
      fetch: node.fetch,
      navigate: (): undefined => undefined,
    })
    const invalidations = new Invalidations()
    const wrap = (inner: JSX.Element): JSX.Element => (
      <ApiProvider client={client}>
        <LiveProvider invalidations={invalidations}>{inner}</LiveProvider>
      </ApiProvider>
    )
    const { rerender } = render(wrap(element))
    // Each answer lands in act(), as React's test environment expects.
    return {
      invalidations,
      rerender: async (next): Promise<void> => {
        await act(async () => rerender(wrap(next)))
      },
    }
  }

  it('loads, keeps what it had while it reloads, and reloads on its topics’ invalidation only', async () => {
    let count = 0
    const node = fakeNode({
      '/api/v2/count': () => new Response(JSON.stringify({ count: ++count })),
    })
    const { invalidations } = mount(
      node,
      <Count path="/api/v2/count" topics={['status']} />,
    )
    assert.equal(text('loading'), 'true')
    await until(() => text('count') === '1', 'the first answer')
    assert.equal(text('loading'), 'false')
    await act(async () => invalidations.invalidate('queue'))
    await act(async () => invalidations.invalidate('status'))
    await until(() => text('count') === '2', 'the reload')
    await act(async () =>
      screen.getByRole('button', { name: 'Reload' }).click(),
    )
    await until(() => text('count') === '3', 'the manual reload')
    assert.deepEqual(node.requests, [
      'GET /api/v2/count',
      'GET /api/v2/count',
      'GET /api/v2/count',
    ])
  })

  it('forgets the old answer for a new path, waits without one, and says why a read failed', async () => {
    const node = fakeNode({
      '/api/v2/one': { count: 1 },
      '/api/v2/broken': {
        status: 500,
        body: { error: 'The database is locked' },
      },
      '/api/v2/odd': { nope: true },
      '/api/v2/thrown': () => {
        throw new Error('weird')
      },
    })
    const { rerender } = mount(node, <Count path="/api/v2/one" />)
    await until(() => text('count') === '1', 'one')
    await rerender(<Count path="/api/v2/broken" />)
    assert.equal(text('count'), '-')
    await until(() => text('error') === 'The database is locked', 'the error')
    await rerender(<Count path="/api/v2/odd" />)
    await until(
      () => /does not understand/.test(text('error')),
      'the contract error',
    )
    await rerender(<Count path={null} />)
    assert.equal(text('loading'), 'false')
    assert.equal(text('error'), '')
    await rerender(<Count path="/api/v2/thrown" />)
    await until(() => text('error') !== '', 'the unreachable error')
    assert.match(text('error'), /could not be reached/)
  })

  it('needs an ApiProvider', () => {
    function Bare(): JSX.Element {
      useApi()
      return <p />
    }
    const original = console.error
    console.error = (): undefined => undefined
    try {
      assert.throws(() => render(<Bare />), /useApi needs an ApiProvider/)
    } finally {
      console.error = original
    }
  })
})
