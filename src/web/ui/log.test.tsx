import assert from 'node:assert/strict'
import { act, cleanup, render, screen } from '@testing-library/react'
import { after, afterEach, before, describe, it } from 'mocha'
import type { RunLogPage } from '../../shared/api/index.js'
import {
  ansiLines,
  ansiPieces,
  stripAnsi,
  type AnsiPiece,
} from '../../shared/ansi.js'
import { BODY_HEIGHT, fakeLogLayout, scrollLog } from '../test/layout.js'
import { until } from '../test/render.js'
import { LINE_PX, LogViewer } from './LogViewer.js'
import { CHUNK, KEEP_LINES, LogStore, type FetchLog } from './logStore.js'

afterEach(() => cleanup())

/** A log of `lines` numbered lines, answered a chunk at a time; it records what it was asked. */
function fakeLog(lines: number): FetchLog & { asked: string[] } {
  const asked: string[] = []
  const fetch = (async (page) => {
    const first =
      'last' in page
        ? Math.max(1, lines - CHUNK + 1)
        : Math.max(1, Math.min(page.from, lines + 1))
    asked.push('last' in page ? 'last' : String(page.from))
    const answer: RunLogPage = {
      start: 1,
      total: lines,
      first,
      text: Array.from(
        { length: Math.max(0, Math.min(CHUNK, lines - first + 1)) },
        (_, index) => `line ${first + index}\n`,
      ).join(''),
      end: 0,
    }
    return answer
  }) as FetchLog & { asked: string[] }
  fetch.asked = asked
  return fetch
}

const drawn = (): number[] =>
  [...document.querySelectorAll<HTMLElement>('.m-log__line')].map((line) =>
    Number(line.dataset.line),
  )
const body = (): HTMLElement =>
  document.querySelector<HTMLElement>('.m-log__body')!
const button = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('.m-log__end')!

describe('Log viewer', () => {
  let restore: () => void
  before(() => {
    restore = fakeLogLayout()
  })
  after(() => restore())

  it('draws a 100,000-line log a window at a time, asking for the chunks in view as it scrolls', async () => {
    const fetch = fakeLog(100_000)
    const store = new LogStore(fetch)
    render(
      <LogViewer
        store={store}
        title="Log of stream"
        label="Log of stream"
        openAt="start"
        downloads={{ raw: '/raw', plain: '/plain' }}
      />,
    )
    screen.getByText('Loading the log…')
    await act(async () => store.open('start'))
    assert.deepEqual(fetch.asked, ['0'])
    await until(() => drawn().includes(1), 'the first lines')
    assert(drawn().length < 100, `${drawn().length} lines drawn`)
    // The box is as tall as every line, so its scrollbar is the log's.
    const height = parseFloat(
      document.querySelector<HTMLElement>('.m-log__rows')!.style.height,
    )
    assert(
      height >= 100_000 * LINE_PX && height < 100_000 * LINE_PX + 40,
      String(height),
    )
    // A finished log opens at its start, with the button to its end.
    assert.equal(button().hidden, false)
    // Halfway: that chunk is asked for, and drawn in place of the dots.
    await act(async () => scrollLog(body(), 50_000 * LINE_PX))
    await until(() => fetch.asked.includes(String(1 + 49_500)), 'the middle')
    await until(
      () =>
        drawn().some((n) => n > 49_990 && n < 50_100) &&
        [...document.querySelectorAll('.m-log__t')].some(
          (line) => line.textContent === 'line 50001',
        ),
      'the middle drawn',
    )
    assert(drawn().length < 200)
    // The end, by the button: it follows from there.
    await act(async () => button().click())
    await until(() => drawn().includes(100_000), 'the end')
    assert.equal(button().hidden, true)
    assert.equal(
      screen.getByRole('link', { name: /Raw/ }).getAttribute('href'),
      '/raw',
    )
  })

  it('follows a live log at its end, stops when the viewer scrolls up, and follows again near the bottom', async () => {
    const store = new LogStore(fakeLog(30))
    render(<LogViewer store={store} title="Log" label="Log" openAt="end" />)
    await act(async () => store.open('end'))
    await until(() => drawn().includes(30), 'the end')
    const atEnd = (): boolean =>
      body().scrollTop + BODY_HEIGHT >= body().scrollHeight - 1
    assert(atEnd())
    assert.equal(button().hidden, true)
    await act(async () => store.append('line 31\nline 32\n', 31))
    await until(() => drawn().includes(32), 'the new lines')
    assert(atEnd(), 'still at the end')
    // Up: it stops following, and new lines leave it where it is.
    await act(async () => scrollLog(body(), body().scrollTop - 200))
    assert.equal(button().hidden, false)
    const top = body().scrollTop
    await act(async () => store.append('line 33\n', 33))
    assert.equal(body().scrollTop, top)
    // Back within 80 px of the bottom: following again.
    await act(async () =>
      scrollLog(body(), body().scrollHeight - BODY_HEIGHT - 40),
    )
    assert.equal(button().hidden, true)
    await act(async () => store.append('line 34\n', 34))
    assert(atEnd())
  })

  it('wraps lines, measuring each, and keeps colours, bold and underline', async () => {
    const store = new LogStore(undefined)
    render(<LogViewer store={store} title="Log" label="Log" openAt="end" />)
    screen.getByText('No lines yet.')
    await act(async () =>
      store.append(
        '\x1b[31mred\x1b[0m and \x1b[1;4mbold\x1b[0m \x1b[37mwhite\x1b[0m\n',
        1,
      ),
    )
    const line = document.querySelector('.m-log__t')!
    assert.equal(line.querySelector('.a-red')!.textContent, 'red')
    assert.equal(line.querySelector('.a-bold.a-underline')!.textContent, 'bold')
    assert.equal(line.textContent, 'red and bold white')
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    assert.equal(wrap.getAttribute('aria-pressed'), 'false')
    await act(async () => wrap.click())
    assert.equal(wrap.getAttribute('aria-pressed'), 'true')
    assert(document.querySelector('.m-log--wrap') != null)
  })

  it('says why a log cannot be shown, and retries one that failed', async () => {
    let fail = true
    const store = new LogStore(async (page) => {
      if (fail)
        throw Object.assign(new Error('The link dropped'), { status: 502 })
      return await fakeLog(2)(page)
    })
    render(
      <LogViewer
        store={store}
        title="Log"
        label="Log"
        openAt="start"
        describeFailure={(failure) => `Failed: ${failure.message}`}
      />,
    )
    await act(async () => store.open('start'))
    screen.getByText('Failed: The link dropped')
    fail = false
    await act(async () => screen.getByRole('button', { name: /Retry/ }).click())
    await until(() => drawn().includes(2), 'the log')
    cleanup()
    render(
      <LogViewer
        store={new LogStore(undefined)}
        title="Log"
        label="Log"
        openAt="start"
        unavailable="Not here."
      />,
    )
    screen.getByText('Not here.')
  })

  it('keeps at most 20,000 lines, letting go of those furthest from view, and asks for each chunk once at a time', async () => {
    const fetch = fakeLog(60_000)
    const store = new LogStore(fetch)
    await store.open('start')
    let changes = 0
    const stop = store.subscribe(() => changes++)
    for (let first = 1; first <= 45_001; first += CHUNK)
      store.ensure(first, first)
    // Asking again while a chunk is under way asks nothing more.
    store.ensure(1, 2)
    await until(() => store.held >= KEEP_LINES - CHUNK, 'the chunks')
    await new Promise((resolve) => setTimeout(resolve, 20))
    store.ensure(45_000, 45_010)
    assert(store.held <= KEEP_LINES, `${store.held} held`)
    assert.equal(store.line(45_000)?.[0]?.text, 'line 45000')
    assert.equal(store.line(1), undefined)
    assert(changes > 0)
    stop()
    // Closed, it asks for nothing.
    store.close()
    const asked = fetch.asked.length
    store.ensure(1, 10)
    assert.equal(fetch.asked.length, asked)
    assert.equal(store.end, 60_000)
  })

  it('reads ANSI styles across lines and strips other escapes', () => {
    const [first, second] = ansiLines('\x1b[34mone\ntwo\x1b[0m\x1b]0;t\x07\r\n')
    assert.deepEqual(first, [
      { text: 'one', style: { bold: false, underline: false, colour: 'blue' } },
    ])
    assert.deepEqual(second, [
      { text: 'two', style: { bold: false, underline: false, colour: 'blue' } },
    ])
    assert.deepEqual(ansiLines(''), [])
    const parsed = ansiPieces(
      '\x1b[92mbright\x1b[39m \x1b[30mblack\x1b[22;24m\x1b[m',
    )
    assert.deepEqual(
      parsed.pieces.map((piece) => [piece.text, piece.style.colour ?? '']),
      [
        ['bright', 'green'],
        [' ', ''],
        ['black', 'gray'],
      ],
    )
    assert.deepEqual(parsed.style, { bold: false, underline: false })
    assert.equal(stripAnsi('\x1b[2Ka\x1b[1mb'), 'ab')
  })

  it('numbers lines by newlines only, as the server does, showing the text after a carriage return', async () => {
    const text = (piece: AnsiPiece[] | undefined): string =>
      (piece ?? []).map((part) => part.text).join('')
    assert.deepEqual(
      ansiLines('a\r\r\n\x1b[31m10%\r20%\rdone\nnext').map(text),
      ['a', 'done', 'next'],
    )
    assert.equal(ansiLines('\x1b[31mx\ry\n')[0]![0]!.style.colour, 'red')
    const store = new LogStore(async () => ({
      start: 1,
      total: 4,
      first: 1,
      text: 'start\n10%\r20%\r100%\nbuilt\nend\n',
      end: 0,
    }))
    await store.open('start')
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((number) => text(store.line(number))),
      ['start', '100%', 'built', 'end', ''],
    )
    assert.equal(store.line(5), undefined)
    // Live lines land on the numbers the server gives them.
    store.append('50%\r99%\rok\nlast\n', 5)
    assert.deepEqual(
      [5, 6].map((number) => text(store.line(number))),
      ['ok', 'last'],
    )
    assert.equal(store.end, 6)
  })
})
