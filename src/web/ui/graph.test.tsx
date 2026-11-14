import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { Bubble, Layout } from '../../shared/api/index.js'
import { clock } from '../../shared/format.js'
import {
  bubbleName,
  COLUMN_MAX,
  COLUMN_MIN,
  graphGeometry,
  LABEL_CHAR,
  labelLines,
  PipelineGraph,
  railPath,
  ROW,
  traced,
  ZOOM_MAX,
  ZOOM_MIN,
} from './PipelineGraph.js'
import { Timeline, timelineBars } from './Timeline.js'

afterEach(() => cleanup())

const bubble = (
  name: string,
  col: number,
  row: number,
  fields: Partial<Bubble> = {},
): Bubble => ({
  name,
  label: name.split('/').pop()!,
  kind: 'stage',
  col,
  row,
  status: 'succeeded',
  waitingFor: [],
  needs: [],
  dependents: [],
  ...fields,
})

/** checkout, then a parallel pair (one with a long name), then an approval. */
const layout: Layout = {
  bubbles: [
    bubble('@start', 0, 0, { label: 'Start', kind: 'start', status: 'start' }),
    bubble('checkout', 1, 0, { dependents: ['build/ios', 'build/android'] }),
    bubble('build/ios', 2, 0, {
      needs: ['checkout'],
      dependents: ['approve'],
      status: 'running',
      rowLabel: 'ios',
      node: 'bern',
      took: 252_000,
    }),
    bubble('build/android-with-a-much-longer-name-than-fits-a-column', 2, 1, {
      needs: ['checkout'],
      dependents: ['approve'],
      status: 'queued',
      waitingFor: ['checkout'],
    }),
    bubble('approve', 3, 0, {
      kind: 'approval',
      status: 'awaiting_approval',
      needs: [
        'build/ios',
        'build/android-with-a-much-longer-name-than-fits-a-column',
      ],
    }),
    bubble('@end', 4, 0, { label: 'End', kind: 'end', status: 'end' }),
  ],
  rails: [
    { from: '@start', to: 'checkout' },
    { from: 'checkout', to: 'build/ios' },
    {
      from: 'checkout',
      to: 'build/android-with-a-much-longer-name-than-fits-a-column',
    },
    { from: 'build/ios', to: 'approve' },
    {
      from: 'build/android-with-a-much-longer-name-than-fits-a-column',
      to: 'approve',
    },
    { from: 'approve', to: '@end' },
    { from: 'missing', to: '@end' },
  ],
  cols: 5,
  rows: 2,
}

describe('Pipeline graph and timeline', () => {
  it('lays columns out in rem: at least 8.25rem, widened to the widest label up to 16rem; labels wrap to two lines', () => {
    const geometry = graphGeometry(layout)
    assert.equal(geometry.columns[1], COLUMN_MIN)
    // The long label widens its column to the most it may, then wraps.
    assert.equal(geometry.columns[2], COLUMN_MAX)
    assert.equal(geometry.columns[0], geometry.columns[4])
    assert(geometry.columns[0]! < COLUMN_MIN)
    const ios = geometry.at.get('build/ios')!
    const android = geometry.at.get(
      'build/android-with-a-much-longer-name-than-fits-a-column',
    )!
    assert.equal(android.x, ios.x)
    assert.equal(android.y - ios.y, ROW)
    assert.equal(
      geometry.width,
      geometry.columns.reduce((sum, width) => sum + width, 32),
    )
    assert.equal(labelLines('checkout', COLUMN_MIN), 1)
    assert.equal(labelLines('x'.repeat(40), COLUMN_MAX), 2)
    assert.equal(Math.ceil('checkout'.length * LABEL_CHAR), 56)
    // A column wide enough for a mid-length label, no more.
    const medium = graphGeometry({
      ...layout,
      bubbles: [bubble('a-twenty-char-label!', 0, 0)],
      cols: 1,
    })
    assert.equal(medium.columns[0], 20 * LABEL_CHAR + 16)
  })

  it('draws rails along a row straight and between rows as curves, and names each bubble fully', () => {
    assert.equal(
      railPath({ x: 10, y: 20, r: 7 }, { x: 100, y: 20, r: 14 }),
      'M17 20H86',
    )
    assert.equal(
      railPath({ x: 10, y: 20, r: 7 }, { x: 100, y: 96, r: 14 }),
      'M17 20C51.5 20 51.5 96 86 96',
    )
    assert.equal(
      bubbleName(layout.bubbles[2]!),
      'build/ios · running · on bern · 4m 12s',
    )
    assert.equal(
      bubbleName(layout.bubbles[3]!),
      'build/android-with-a-much-longer-name-than-fits-a-column · queued · waiting for checkout',
    )
    assert.equal(
      bubbleName(layout.bubbles[4]!),
      'approve · waiting for approval',
    )
    assert.equal(bubbleName(layout.bubbles[0]!), 'Start')
    assert.deepEqual([...traced(layout, 'build/ios')].sort(), [
      'approve',
      'build/ios',
      'checkout',
    ])
    assert.equal(traced(layout, undefined).size, 0)
    assert.equal(traced(layout, 'nowhere').size, 0)
  })

  it('selects a stage, traces what it waits for and what waits for it on hover, and zooms, fits and goes full screen', async () => {
    const chosen: string[] = []
    render(
      <PipelineGraph
        layout={layout}
        selected="checkout"
        href={(stage) => `?stage=${stage}`}
        onSelect={(stage) => chosen.push(stage)}
        label="Pipeline of Run 182"
      />,
    )
    const svg = screen.getByRole('group', { name: 'Pipeline of Run 182' })
    const ios = svg.querySelector<SVGElement>('[data-stage="build/ios"]')!
    assert.equal(ios.getAttribute('href'), '?stage=build/ios')
    // The selected stage is traced at rest.
    assert.equal(
      svg
        .querySelector('[data-stage="checkout"]')!
        .getAttribute('aria-current'),
      'true',
    )
    assert(svg.querySelector('.m-gbubble__selected') != null)
    assert.equal(
      svg.querySelector('[data-stage="approve"]')!.hasAttribute('data-dim'),
      true,
    )
    // Hovering build/ios lights checkout and approve and dims the rest.
    fireEvent.mouseEnter(ios)
    const dim = (name: string): boolean =>
      svg.querySelector(`[data-stage="${name}"]`)!.hasAttribute('data-dim')
    assert.equal(dim('approve'), false)
    assert.equal(dim('checkout'), false)
    assert.equal(
      dim('build/android-with-a-much-longer-name-than-fits-a-column'),
      true,
    )
    const related = [...svg.querySelectorAll<SVGPathElement>('.m-grail')]
      .filter((rail) => rail.hasAttribute('data-related'))
      .map((rail) => `${rail.dataset.from}>${rail.dataset.to}`)
    assert.deepEqual(related, ['checkout>build/ios', 'build/ios>approve'])
    fireEvent.mouseLeave(ios)
    assert.equal(dim('approve'), true)
    fireEvent.focus(ios)
    assert.equal(dim('approve'), false)
    fireEvent.blur(ios)
    // A running stage spins its ring; an approval carries the hand; a label
    // too long for two lines says so.
    assert(ios.querySelector('.m-gbubble__ring') != null)
    assert.equal(
      svg.querySelector('[data-stage="approve"] .m-gbubble__glyph')!
        .textContent,
      String.fromCodePoint(0xe925),
    )
    assert.equal(
      svg
        .querySelector(
          '[data-stage="build/android-with-a-much-longer-name-than-fits-a-column"] .m-glabel-box',
        )!
        .getAttribute('data-lines'),
      '2',
    )
    svg.querySelector('text.m-gsub')
    await act(async () => fireEvent.click(ios))
    assert.deepEqual(chosen, ['build/ios'])
    // Zoom: 1.25 a step, between 0.4 and 3.
    const scroll = document.querySelector<HTMLElement>('.m-graph__scroll')!
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    for (let n = 0; n < 8; n++) await act(async () => zoomIn.click())
    assert.equal(Number(scroll.dataset.scale), ZOOM_MAX)
    assert.equal(zoomIn.hasAttribute('disabled'), true)
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
    for (let n = 0; n < 12; n++) await act(async () => zoomOut.click())
    assert.equal(Number(scroll.dataset.scale), ZOOM_MIN)
    // Fit: to the width it has (none here, so its own size).
    await act(async () => screen.getByRole('button', { name: 'Fit' }).click())
    assert.equal(Number(scroll.dataset.scale), 1)
    Object.defineProperty(scroll, 'clientWidth', {
      configurable: true,
      value: 300,
    })
    await act(async () => screen.getByRole('button', { name: 'Fit' }).click())
    assert(Number(scroll.dataset.scale) < 1)
    // Full screen, where the browser has it.
    const panel = document.querySelector<HTMLElement>('.m-graph')!
    let asked = 0
    panel.requestFullscreen = async (): Promise<void> => {
      asked++
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: panel,
      })
      document.dispatchEvent(new window.Event('fullscreenchange'))
    }
    await act(async () =>
      screen.getByRole('button', { name: 'Full screen' }).click(),
    )
    assert.equal(asked, 1)
    assert.equal(panel.hasAttribute('data-full'), true)
    let exited = 0
    document.exitFullscreen = async (): Promise<void> => {
      exited++
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: null,
      })
    }
    await act(async () =>
      screen.getByRole('button', { name: 'Exit full screen' }).click(),
    )
    assert.equal(exited, 1)
    assert.equal(panel.hasAttribute('data-full'), false)
    delete (document as unknown as Record<string, unknown>).fullscreenElement
  })

  it('places timeline bars by real time with the critical path, and says when nothing started', () => {
    const stages = [
      {
        name: 'setup',
        status: 'succeeded',
        started: 0,
        finished: 10,
        needs: [],
      },
      {
        name: 'fast',
        status: 'succeeded',
        started: 10,
        finished: 20,
        needs: ['setup'],
      },
      {
        name: 'slow',
        status: 'succeeded',
        started: 10,
        finished: 60,
        needs: ['setup'],
      },
      {
        name: 'ship',
        status: 'running',
        started: 60,
        finished: null,
        needs: ['fast', 'slow'],
      },
      {
        name: 'later',
        status: 'queued',
        started: null,
        finished: null,
        needs: [],
      },
    ]
    const data = timelineBars(stages, 100)
    assert.deepEqual(
      data.bars.map((bar) => [bar.name, bar.critical]),
      [
        ['setup', true],
        ['fast', false],
        ['slow', true],
        ['ship', true],
      ],
    )
    assert.deepEqual([data.from, data.to], [0, 100])
    render(<Timeline stages={stages} now={100} />)
    const slow = document.querySelector<HTMLElement>(
      '.m-timeline__row[data-stage="slow"] .m-timeline__bar > span',
    )!
    assert.equal(slow.style.left, '10%')
    assert.equal(slow.style.width, '50%')
    assert(slow.classList.contains('m-timeline__critical'))
    cleanup()
    render(<Timeline stages={[stages[4]!]} now={5} />)
    screen.getByRole('heading', { name: 'No stage has started yet' })
    screen.getByText('The timeline fills in as stages start.')
    assert.deepEqual(
      [clock(21_000), clock(252_000), clock(3_909_000), clock(-5)],
      ['0:21', '4:12', '1:05:09', '0:00'],
    )
  })
})
