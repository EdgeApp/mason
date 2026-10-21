import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  attachSearch,
  domPage,
  resultItems,
  type KeyEvent,
  type SearchPage,
  type SearchResult,
} from './shell.js'

const results: SearchResult[] = [
  {
    kind: 'project',
    label: 'Phones',
    detail: 'phones',
    href: '/?project=phones',
  },
  {
    kind: 'run',
    label: 'phones build #2',
    detail: 'main · failed',
    href: '/artifacts?run=2',
  },
]

/** A page whose dialog, timers and requests the test drives. */
function fakePage(answer: (query: string) => Promise<SearchResult[]>): {
  page: SearchPage
  key: (key: string, meta?: boolean) => boolean
  type: (text: string) => void
  click: () => void
  tick: () => Promise<void>
  shown: () => [string[], number]
  visits: string[]
  open: () => boolean
} {
  let open = false
  let value = ''
  let shown: [string[], number] = [[], 0]
  let onKey: (event: KeyEvent) => void = () => undefined
  let onInput: () => void = () => undefined
  let onButton: () => void = () => undefined
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const visits: string[] = []
  return {
    page: {
      open: (): void => {
        open = true
      },
      close: (): void => {
        open = false
      },
      isOpen: () => open,
      query: () => value,
      show: (list, selected): void => {
        shown = [list.map((item) => item.label), selected]
      },
      fetchResults: answer,
      go: (href) => visits.push(href),
      onKey: (handler): void => {
        onKey = handler
      },
      onInput: (handler): void => {
        onInput = handler
      },
      onButton: (handler): void => {
        onButton = handler
      },
      setTimer: (run): number => {
        timers.set(++nextTimer, run)
        return nextTimer
      },
      clearTimer: (timer): void => {
        timers.delete(timer as number)
      },
    },
    key: (key, meta = false): boolean => {
      let prevented = false
      onKey({
        key,
        metaKey: meta,
        ctrlKey: false,
        preventDefault: () => {
          prevented = true
        },
      })
      return prevented
    },
    type: (text): void => {
      value = text
      onInput()
    },
    click: () => onButton(),
    tick: async (): Promise<void> => {
      const due = [...timers.values()]
      timers.clear()
      for (const run of due) run()
      await new Promise((resolve) => setImmediate(resolve))
    },
    shown: () => shown,
    visits,
    open: () => open,
  }
}

describe('Shell search', () => {
  it('opens on ⌘K or the button, asks after a pause, and opens the chosen result', async () => {
    const asked: string[] = []
    const fake = fakePage(async (query) => {
      asked.push(query)
      return results
    })
    attachSearch(fake.page)
    assert.equal(fake.key('ArrowDown'), false)
    assert.equal(fake.key('k', true), true)
    assert(fake.open())
    fake.type('p')
    fake.type('ph')
    await fake.tick()
    // Only the last query is asked.
    assert.deepEqual(asked, ['ph'])
    assert.deepEqual(fake.shown(), [['Phones', 'phones build #2'], 0])
    fake.key('ArrowDown')
    assert.deepEqual(fake.shown()[1], 1)
    fake.key('ArrowDown')
    assert.deepEqual(fake.shown()[1], 0)
    fake.key('ArrowUp')
    assert.deepEqual(fake.shown()[1], 1)
    fake.key('Enter')
    assert.deepEqual(fake.visits, ['/artifacts?run=2'])
    fake.key('x')
    fake.key('K', true)
    assert(!fake.open())
    fake.click()
    assert(fake.open())
    fake.type('  ')
    await fake.tick()
    assert.deepEqual(fake.shown(), [[], 0])
    fake.key('ArrowDown')
    fake.key('Enter')
    assert.deepEqual(fake.visits, ['/artifacts?run=2'])
  })

  it('keeps a newer answer when an older one arrives late, and shows nothing on failure', async () => {
    const pending: Array<(list: SearchResult[]) => void> = []
    const fake = fakePage(
      async () =>
        await new Promise<SearchResult[]>((resolve) => pending.push(resolve)),
    )
    attachSearch(fake.page)
    fake.click()
    fake.type('old')
    await fake.tick()
    fake.type('new')
    await fake.tick()
    pending[1]!([results[0]!])
    await fake.tick()
    pending[0]!(results)
    await fake.tick()
    assert.deepEqual(fake.shown()[0], ['Phones'])
    const failing = fakePage(async () => {
      throw new Error('offline')
    })
    attachSearch(failing.page)
    failing.click()
    failing.type('x')
    await failing.tick()
    assert.deepEqual(failing.shown(), [[], 0])
  })

  it('renders results as options and wires the page’s own dialog', async () => {
    class Element {
      children: Element[] = []
      attributes = new Map<string, string>()
      listeners = new Map<string, () => void>()
      textContent = ''
      className = ''
      href = ''
      value = 'pho'
      open = false
      constructor(readonly tag: string) {}
      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value)
      }
      append(...nodes: Element[]): void {
        this.children.push(...nodes)
      }
      replaceChildren(...nodes: Element[]): void {
        this.children = nodes
      }
      addEventListener(type: string, handler: () => void): void {
        this.listeners.set(type, handler)
      }
      showModal(): void {
        this.open = true
      }
      close(): void {
        this.open = false
      }
      focus(): void {}
      querySelector(selector: string): Element | null {
        return selector === 'input' ? input : selector === 'ul' ? list : null
      }
    }
    const dialog = new Element('dialog')
    const input = new Element('input')
    const list = new Element('ul')
    const button = new Element('button')
    const docListeners = new Map<string, (event: unknown) => void>()
    const doc = {
      createElement: (tag: string) => new Element(tag),
      querySelector: (selector: string) =>
        selector === 'dialog.search-dialog' ? dialog : null,
      querySelectorAll: () => [button],
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        docListeners.set(type, handler),
    } as unknown as Document
    const items = resultItems(doc, results, 1) as unknown as Element[]
    const link = items[1]!.children[0]!
    assert.equal(link.href, '/artifacts?run=2')
    assert.equal(link.attributes.get('aria-selected'), 'true')
    assert.equal(
      link.children[0]!.children[1]!.textContent,
      'Run · main · failed',
    )
    assert.equal(
      (resultItems(doc, [], 0) as unknown as Element[])[0]!.className,
      'empty',
    )
    const fetched: string[] = []
    const assigned: string[] = []
    let ok = true
    const win = {
      fetch: async (url: string) => {
        fetched.push(url)
        return { ok, json: async (): Promise<SearchResult[]> => results }
      },
      location: { assign: (href: string) => assigned.push(href) },
      setTimeout: (run: () => void) => {
        run()
        return 1
      },
      clearTimeout: () => undefined,
    } as unknown as Window
    const page = domPage(doc, win)!
    page.open()
    assert(page.isOpen())
    assert.equal(page.query(), 'pho')
    assert.deepEqual(await page.fetchResults('a b'), results)
    assert.deepEqual(fetched, ['/search?q=a%20b'])
    ok = false
    assert.deepEqual(await page.fetchResults('x'), [])
    page.show(results, 0)
    assert.equal(list.children.length, 2)
    page.go('/x')
    assert.deepEqual(assigned, ['/x'])
    let pressed = 0
    page.onKey(() => pressed++)
    docListeners.get('keydown')!({})
    page.onInput(() => pressed++)
    input.listeners.get('input')!()
    page.onButton(() => pressed++)
    button.listeners.get('click')!()
    assert.equal(pressed, 3)
    let ran = false
    assert.equal(
      page.setTimer(() => (ran = true), 5),
      1,
    )
    assert(ran)
    page.clearTimer(1)
    page.close()
    assert(!page.isOpen())
    assert.equal(
      domPage({ querySelector: () => null } as unknown as Document, win),
      undefined,
    )
  })
})
