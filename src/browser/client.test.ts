import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'mocha'

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
}
function browser(
  options: {
    url?: string
    cookie?: string
    ipad?: boolean
    install?: boolean
    chosen?: string
    historyBlocked?: boolean
  } = {},
): {
  events: Map<string, (event: Record<string, unknown>) => void>
  target: (href: string) => object
  location: URL
  visits: string[]
  state: () => unknown
  position: () => [number, number]
  fetch: (handler: (url: URL) => Promise<unknown>) => void
  broken: () => void
  cookie: () => string
  historyWrites: () => number
  advance: (ms: number) => void
  denyHistory: () => void
} {
  const events = new Map<string, (event: Record<string, unknown>) => void>(),
    visits: string[] = []
  const location = new URL(
    options.url ?? 'https://builds.example.test/apps/1?platform=ios',
  )
  Object.assign(location, {
    assign: (url: string | URL): void => {
      visits.push(String(url))
    },
  })
  let state: unknown,
    position: [number, number] = [15, 300],
    broken = false,
    writes = 0,
    clock = 0,
    historyBlocked = options.historyBlocked ?? false
  let fetcher = async (url: URL): Promise<unknown> => ({
    ok: true,
    url: url.href,
    text: async (): Promise<string> => '<html></html>',
  })
  class Element {
    readonly dataset = { platform: options.chosen ?? 'ios' }
    constructor(readonly href: string) {}
    closest(): Element | null {
      return this.href === '' ? null : this
    }
    replaceWith(): void {}
  }
  const document = {
    title: 'Before',
    cookie: options.cookie ?? '',
    addEventListener: (
      name: string,
      handler: (event: Record<string, unknown>) => void,
    ): void => {
      events.set(name, handler)
    },
    querySelectorAll: (): Array<{
      dateTime: string
      textContent: string
    }> => [
      { dateTime: '2026-01-01T00:00:00Z', textContent: '' },
      { dateTime: 'invalid', textContent: '' },
    ],
    querySelector: (selector: string): Element | null =>
      selector === 'a[data-install]'
        ? options.install
          ? new Element('itms-services://?action=download-manifest')
          : null
        : new Element(''),
  }
  const history = {
    replaceState: (
      value: unknown,
      _unused: string,
      url: string | URL,
    ): void => {
      writes++
      if (historyBlocked) throw new Error('History quota exceeded')
      state = value
      location.href = String(url)
    },
    pushState: (value: unknown, _unused: string, url: string | URL): void => {
      if (historyBlocked) throw new Error('History quota exceeded')
      state = value
      location.href = String(url)
    },
  }
  const globals = {
    document,
    location,
    history,
    navigator: {
      platform: options.ipad ? 'MacIntel' : 'Linux',
      maxTouchPoints: options.ipad ? 5 : 0,
    },
    URL,
    Element,
    Date: class extends Date {
      static now(): number {
        return clock
      }
    },
    scrollX: 15,
    scrollY: 300,
    window: {
      addEventListener: (
        name: string,
        handler: (event: Record<string, unknown>) => void,
      ): void => {
        events.set(name, handler)
      },
    },
    requestAnimationFrame: (fn: () => void): void => fn(),
    scrollTo: (x: number, y: number): void => {
      position = [x, y]
    },
    fetch: async (url: URL): Promise<unknown> => await fetcher(url),
    DOMParser: class {
      parseFromString(): object {
        return {
          title: 'After',
          querySelector: (): Element | null =>
            broken ? null : new Element(''),
        }
      }
    },
  }
  const file = path.resolve('lib/browser/client.js')
  runInNewContext(
    readFileSync(file, 'utf8').replace('export {};', '          '),
    globals,
    { filename: file },
  )
  return {
    events,
    target: (href): object => new Element(href),
    location,
    visits,
    state: (): unknown => state,
    position: (): [number, number] => position,
    fetch: (handler): void => {
      fetcher = handler
    },
    broken: (): void => {
      broken = true
    },
    cookie: (): string => document.cookie,
    historyWrites: (): number => writes,
    advance: (ms): void => {
      clock += ms
    },
    denyHistory: (): void => {
      historyBlocked = true
    },
  }
}
function click(
  env: ReturnType<typeof browser>,
  url: string,
  extra: Record<string, unknown> = {},
): void {
  env.events.get('click')!({
    target: env.target(url),
    button: 0,
    preventDefault: (): void => {},
    ...extra,
  })
}
describe('Browser platform navigation', () => {
  it('bounds scroll history writes and survives browser history quotas', async () => {
    const env = browser()
    for (let i = 0; i < 1000; ++i) {
      env.events.get('scroll')!({})
      env.advance(16)
    }
    assert(env.historyWrites() <= 16)
    env.denyHistory()
    const target = 'https://builds.example.test/apps/1?platform=android'
    click(env, target)
    await settle()
    assert.deepEqual(env.visits, [target])
    browser({ url: 'https://builds.example.test/apps/1', historyBlocked: true })
  })
  it('keeps the installer page and canonicalizes detected catalog history', async () => {
    const installer = browser({
      url: 'https://builds.example.test/builds/1/install',
      ipad: true,
      install: true,
    })
    let requests = 0
    installer.fetch(async () => {
      requests++
      throw new Error('Unexpected installer request')
    })
    await settle()
    assert.equal(requests, 0)
    assert.equal(installer.location.pathname, '/builds/1/install')
    assert.equal(installer.visits.length, 0)
    const catalog = browser({
      url: 'https://builds.example.test/apps/1',
      chosen: 'ios',
    })
    assert.equal(catalog.location.search, '?platform=ios')
    click(catalog, 'https://builds.example.test/apps/1?platform=android')
    await settle()
    catalog.location.search = '?platform=ios'
    catalog.events.get('popstate')!({ state: { x: 0, y: 20 } })
    await settle()
    assert.equal(catalog.location.search, '?platform=ios')
  })
  it('cancels a pending switch when the displayed platform is selected again', async () => {
    const env = browser()
    let release: (value: unknown) => void = () => {}
    const android = 'https://builds.example.test/apps/1?platform=android'
    env.fetch(
      async () =>
        await new Promise((resolve) => {
          release = resolve
        }),
    )
    click(env, android)
    click(env, 'https://builds.example.test/apps/1?platform=ios')
    release({ ok: true, url: android, text: async () => '' })
    await settle()
    assert.equal(env.location.search, '?platform=ios')
  })
  it('preserves branch, position and history, saves preferences and honors modifier clicks', async () => {
    const env = browser(),
      base = 'https://builds.example.test/apps/1?platform='
    click(env, base + 'android')
    await settle()
    assert.equal(env.location.href, base + 'android')
    assert.deepEqual(env.position(), [15, 300])
    assert.match(env.cookie(), /mason-platform=android/)
    assert.equal(JSON.stringify(env.state()), '{"x":15,"y":300}')
    click(env, base + 'android')
    await settle()
    for (const extra of [
      { button: 2 },
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { target: {} },
    ])
      click(env, base + 'windows', extra)
    click(env, '')
    assert.equal(env.location.href, base + 'android')
    env.location.href = base + 'ios'
    env.events.get('popstate')!({ state: { x: 0, y: 120 } })
    await settle()
    assert.deepEqual(env.position(), [0, 120])
    env.events.get('popstate')!({ state: null })
    await settle()
    assert.deepEqual(env.position(), [0, 0])
    env.events.get('pagehide')!({})
    env.events.get('scroll')!({})
    assert.equal(env.visits.length, 0)
  })
  it('detects iPad desktop browsing only without an explicit or saved preference', async () => {
    const ipad = browser({
      url: 'https://builds.example.test/apps/1',
      ipad: true,
    })
    await settle()
    assert.equal(ipad.location.search, '?platform=ios')
    const preference = browser({
      url: 'https://builds.example.test/apps/1',
      ipad: true,
      cookie: 'mason-platform=macos',
      chosen: 'macos',
    })
    await settle()
    assert.equal(preference.location.search, '?platform=macos')
    const explicit = browser({
      url: 'https://builds.example.test/apps/1?platform=macos',
      ipad: true,
    })
    await settle()
    assert.equal(explicit.location.search, '?platform=macos')
    const installer = browser({ install: true })
    assert.equal(installer.visits.length, 0)
  })
  it('ignores stale responses and returns safely to document navigation after failures', async () => {
    const url = 'https://builds.example.test/apps/1?platform=android'
    for (const kind of ['redirect', 'http', 'network', 'markup']) {
      const env = browser()
      if (kind === 'markup') env.broken()
      else
        env.fetch(async (): Promise<unknown> => {
          if (kind === 'network') throw new Error('Offline')
          return {
            ok: kind !== 'http',
            url:
              kind === 'redirect'
                ? 'https://builds.example.test/auth/login'
                : url,
          }
        })
      click(env, url)
      await settle()
      assert.equal(env.visits.length, 1)
    }
    const env = browser()
    let release: (value: unknown) => void = (): void => {}
    env.fetch(
      async (request): Promise<unknown> =>
        request.search.includes('android')
          ? await new Promise((resolve) => {
              release = resolve
            })
          : {
              ok: true,
              url: request.href,
              text: async (): Promise<string> => '',
            },
    )
    click(env, url)
    click(env, url.replace('android', 'windows'))
    await settle()
    release({ ok: true, url })
    await settle()
    assert.equal(env.location.search, '?platform=windows')
    const body = browser()
    let releaseBody: (value: string) => void = (): void => {}
    body.fetch(
      async (request): Promise<unknown> => ({
        ok: true,
        url: request.href,
        text: async (): Promise<string> =>
          request.search.includes('android')
            ? await new Promise((resolve) => {
                releaseBody = resolve
              })
            : '',
      }),
    )
    click(body, url)
    await settle()
    click(body, url.replace('android', 'windows'))
    await settle()
    releaseBody('')
    await settle()
    assert.equal(body.location.search, '?platform=windows')
    env.fetch(async (): Promise<unknown> => {
      throw new Error('Offline')
    })
    click(env, url)
    await settle()
    assert.equal(env.visits.length, 1)
  })
})
