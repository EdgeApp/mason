import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { useState, type JSX } from 'react'
import { FilterPills } from '../ui/FilterPills.js'
import { SliderTrack } from '../ui/SliderTrack.js'

afterEach(() => {
  cleanup()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

/** Lays the options out in a row, 100 px each, in a 400 px track, as jsdom does not lay out. */
function layOut(track: HTMLElement): void {
  Object.defineProperty(track, 'clientWidth', {
    configurable: true,
    value: 400,
  })
  ;[...track.children].forEach((option, n) => {
    for (const [key, value] of Object.entries({
      offsetLeft: 4 + n * 100,
      offsetTop: 4,
      offsetWidth: 96,
      offsetHeight: 30,
    }))
      Object.defineProperty(option, key, { configurable: true, value })
    option.getBoundingClientRect = (): DOMRect =>
      ({
        left: n * 100,
        right: n * 100 + 96,
        top: 0,
        bottom: 30,
        width: 96,
        height: 30,
        x: n * 100,
        y: 0,
      }) as DOMRect
  })
}

const options = [
  { key: 'all', label: 'All', count: 6 },
  { key: 'ios', label: 'iOS', count: 3 },
  { key: 'android', label: 'Android', count: 2 },
]

/** Filter pills whose choice is state, with every change recorded. */
function Pills({ changes }: { changes: string[] }): JSX.Element {
  const [value, setValue] = useState('all')
  return (
    <FilterPills
      label="Platform"
      options={options}
      value={value}
      onChange={(key) => {
        changes.push(key)
        setValue(key)
      }}
    />
  )
}

const track = (): HTMLElement => screen.getByRole('group', { name: 'Platform' })
const option = (name: RegExp): HTMLElement =>
  screen.getByRole('button', { name })
const pointer = (
  target: Element,
  type: string,
  x: number,
  fields: PointerEventInit = {},
): void => {
  fireEvent(
    target,
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      // The main button is down from the press until its release.
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: x,
      clientY: 15,
      ...fields,
    }),
  )
}

/** Renders the pills, lays them out and lets the thumb settle on the choice. */
function renderPills(changes: string[] = []): HTMLElement {
  const { rerender } = render(<Pills changes={changes} />)
  layOut(track())
  // Render again so the thumb measures the laid-out options.
  rerender(<Pills changes={changes} />)
  return track()
}

describe('Slider pills', () => {
  it('puts the thumb on the chosen option and slides it to the next', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    assert.equal(element.dataset.thumb, '')
    assert.equal(element.style.getPropertyValue('--thumb-x'), '4px')
    assert.equal(element.style.getPropertyValue('--thumb-y'), '4px')
    assert.equal(element.style.getPropertyValue('--thumb-w'), '96px')
    assert.equal(element.style.getPropertyValue('--thumb-h'), '30px')
    assert.equal(option(/^All/).dataset.thumbOn, '')
    fireEvent.click(option(/^Android/))
    assert.equal(element.style.getPropertyValue('--thumb-x'), '204px')
    assert.equal(option(/^Android/).dataset.thumbOn, '')
    assert.equal(option(/^All/).dataset.thumbOn, undefined)
    assert.deepEqual(changes, ['android'])
  })

  it('has no thumb while nothing is chosen', () => {
    render(
      <SliderTrack className="m-seg" role="group" aria-label="Platform">
        <button type="button" aria-pressed={false}>
          Graph
        </button>
        <button type="button" aria-pressed={false}>
          Timeline
        </button>
      </SliderTrack>,
    )
    assert.equal(track().dataset.thumb, undefined)
    assert.equal(track().querySelector('[data-thumb-on]'), null)
  })

  it('drags the thumb to another option and chooses it on release', async () => {
    const changes: string[] = []
    const element = renderPills(changes)
    pointer(option(/^All/), 'pointerdown', 48)
    // Within the slop it is still a tap.
    pointer(element, 'pointermove', 50)
    assert.equal(element.dataset.dragging, undefined)
    pointer(element, 'pointermove', 150)
    assert.equal(element.dataset.dragging, '')
    assert.equal(option(/^iOS/).dataset.thumbOn, '')
    // Past the last option the thumb stays on the nearest.
    pointer(element, 'pointermove', 400)
    assert.equal(option(/^Android/).dataset.thumbOn, '')
    // A move from another pointer does nothing.
    pointer(element, 'pointermove', 150, { pointerId: 2 })
    assert.equal(option(/^Android/).dataset.thumbOn, '')
    pointer(element, 'pointerup', 400)
    assert.equal(element.dataset.dragging, undefined)
    assert.deepEqual(changes, ['android'])
    // The browser's own click after the drag is swallowed.
    fireEvent.click(option(/^iOS/))
    assert.deepEqual(changes, ['android'])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    fireEvent.click(option(/^iOS/))
    assert.deepEqual(changes, ['android', 'ios'])
  })

  it('chooses nothing when a drag ends back on the chosen option', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    pointer(option(/^All/), 'pointerdown', 48)
    pointer(element, 'pointermove', 150)
    pointer(element, 'pointermove', 40)
    pointer(element, 'pointerup', 40)
    assert.deepEqual(changes, [])
  })

  it('drags only from the thumb, with the main button', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    pointer(option(/^iOS/), 'pointerdown', 148)
    pointer(element, 'pointermove', 250)
    assert.equal(element.dataset.dragging, undefined)
    pointer(element, 'pointerup', 250)
    pointer(option(/^All/), 'pointerdown', 48, { button: 2 })
    pointer(element, 'pointermove', 250)
    assert.equal(element.dataset.dragging, undefined)
    assert.equal(option(/^All/).dataset.thumbOn, '')
    assert.deepEqual(changes, [])
  })

  it('puts the thumb back when the drag is cancelled', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    pointer(option(/^All/), 'pointerdown', 48)
    pointer(element, 'pointermove', 250)
    assert.equal(option(/^Android/).dataset.thumbOn, '')
    pointer(element, 'pointercancel', 250, { pointerId: 2 })
    assert.equal(element.dataset.dragging, '')
    pointer(element, 'pointercancel', 250)
    assert.equal(element.dataset.dragging, undefined)
    assert.equal(option(/^All/).dataset.thumbOn, '')
    pointer(element, 'pointerup', 250)
    assert.deepEqual(changes, [])
  })

  it('forgets a press released outside the track, so a later hover neither drags nor chooses', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    // Pressed on the thumb, then released outside before any move the track heard.
    pointer(option(/^All/), 'pointerdown', 48)
    // Later the mouse hovers over the track with no button down.
    pointer(element, 'pointermove', 250, { buttons: 0 })
    assert.equal(element.dataset.dragging, undefined)
    assert.equal(option(/^All/).dataset.thumbOn, '')
    // A tap on another option is a plain tap: no drag's click, nothing swallowed.
    pointer(option(/^Android/), 'pointerdown', 248)
    pointer(option(/^Android/), 'pointerup', 248)
    assert.deepEqual(changes, [])
    fireEvent.click(option(/^Android/))
    assert.deepEqual(changes, ['android'])
  })

  it('lets a second finger neither stop nor strand a drag', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    pointer(option(/^All/), 'pointerdown', 48)
    pointer(element, 'pointermove', 150)
    assert.equal(element.dataset.dragging, '')
    // A second finger lands on the track mid-drag, and lifts.
    pointer(option(/^Android/), 'pointerdown', 248, { pointerId: 2 })
    pointer(option(/^Android/), 'pointerup', 248, { pointerId: 2 })
    assert.equal(element.dataset.dragging, '')
    // The first finger carries on and chooses where it lifts.
    pointer(element, 'pointermove', 250)
    pointer(element, 'pointerup', 250)
    assert.equal(element.dataset.dragging, undefined)
    assert.deepEqual(changes, ['android'])
  })

  it('ends a drag whose release was never heard, putting the thumb back', () => {
    const element = renderPills()
    pointer(option(/^All/), 'pointerdown', 48)
    pointer(element, 'pointermove', 250)
    assert.equal(option(/^Android/).dataset.thumbOn, '')
    pointer(element, 'pointermove', 250, { buttons: 0 })
    assert.equal(element.dataset.dragging, undefined)
    assert.equal(option(/^All/).dataset.thumbOn, '')
  })

  it('lets another pointer drag when the last press never dragged and ended unheard', () => {
    const changes: string[] = []
    const element = renderPills(changes)
    // A mouse presses the thumb, barely moves, and is released outside the track.
    pointer(option(/^All/), 'pointerdown', 48)
    pointer(element, 'pointermove', 49)
    // A finger then drags the thumb to Android.
    pointer(option(/^All/), 'pointerdown', 48, { pointerId: 2 })
    pointer(element, 'pointermove', 250, { pointerId: 2 })
    assert.equal(element.dataset.dragging, '')
    pointer(element, 'pointerup', 250, { pointerId: 2 })
    assert.deepEqual(changes, ['android'])
  })

  it('leaves a track that scrolls sideways to its swipes', () => {
    const changes: string[] = []
    const { rerender } = render(<Pills changes={changes} />)
    const element = track()
    layOut(element)
    // The options end at 300 px, past the 250 px box.
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: 250,
    })
    rerender(<Pills changes={changes} />)
    assert.equal(element.dataset.scrolls, '')
    pointer(option(/^All/), 'pointerdown', 48)
    pointer(element, 'pointermove', 250)
    assert.equal(element.dataset.dragging, undefined)
    pointer(element, 'pointerup', 250)
    assert.deepEqual(changes, [])
    // Wide enough again: the thumb drags.
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: 300,
    })
    rerender(<Pills changes={changes} />)
    assert.equal(element.dataset.scrolls, undefined)
  })

  it('reads whether a track scrolls from its options, not a thumb still sliding past its end', () => {
    const changes: string[] = []
    const { rerender } = render(<Pills changes={changes} />)
    const element = track()
    layOut(element)
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: 300,
    })
    // The thumb's old, wider box still overflows the track.
    Object.defineProperty(element, 'scrollWidth', {
      configurable: true,
      value: 344,
    })
    rerender(<Pills changes={changes} />)
    assert.equal(element.dataset.scrolls, undefined)
  })

  it('refuses the browser’s own drag of a link', () => {
    const element = renderPills()
    assert.equal(fireEvent.dragStart(option(/^All/)), false)
    assert.equal(fireEvent.dragStart(element), false)
  })

  it('measures again when the track resizes', () => {
    const observed: Array<() => void> = []
    let disconnected = 0
    Object.assign(globalThis, {
      ResizeObserver: class {
        constructor(changed: () => void) {
          observed.push(changed)
        }
        observe(): void {}
        disconnect(): void {
          disconnected++
        }
      },
    })
    const { unmount } = render(<Pills changes={[]} />)
    const element = track()
    assert.equal(observed.length, 1)
    layOut(element)
    assert.equal(element.style.getPropertyValue('--thumb-w'), '0px')
    observed[0]!()
    assert.equal(element.style.getPropertyValue('--thumb-w'), '96px')
    unmount()
    assert.equal(disconnected, 1)
  })
})

describe('A slider track that scrolls sideways', () => {
  const restore: Array<() => void> = []
  afterEach(() => {
    for (const undo of restore.splice(0).reverse()) undo()
  })

  /**
   * Makes the pills' track a box this wide over its 304 px of options, with
   * 3 px padding and this scroll padding, and records every scroll it is given.
   */
  function scrolling(
    element: HTMLElement,
    clientWidth: number,
    padding: { left: string; right: string } = { left: 'auto', right: '32px' },
  ): number[] {
    let left = 0
    const writes: number[] = []
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: clientWidth,
    })
    Object.defineProperty(element, 'scrollWidth', {
      configurable: true,
      value: 304,
    })
    Object.defineProperty(element, 'scrollLeft', {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = value
        writes.push(value)
      },
    })
    const computed = window.getComputedStyle
    window.getComputedStyle = ((target: Element, pseudo?: string | null) =>
      target === element
        ? ({
            paddingLeft: '3px',
            paddingRight: '3px',
            scrollPaddingLeft: padding.left,
            scrollPaddingRight: padding.right,
          } as CSSStyleDeclaration)
        : computed.call(window, target, pseudo)) as typeof getComputedStyle
    restore.push(() => {
      window.getComputedStyle = computed
    })
    return writes
  }

  it('scrolls a newly chosen option beyond the right edge in, short of its scroll padding', () => {
    const element = renderPills()
    scrolling(element, 150)
    fireEvent.click(option(/^Android/))
    // Android ends at 300; with 32 px scroll padding the view ends at 268.
    assert.equal(element.scrollLeft, 300 + 32 - 150)
    assert.equal(element.dataset.scrolls, '')
  })

  it('scrolls a newly chosen option left of the view in, counting an auto scroll padding as 0', () => {
    const element = renderPills()
    scrolling(element, 150)
    element.scrollLeft = 250
    fireEvent.click(option(/^iOS/))
    // iOS starts at 104; the 3 px padding outweighs the auto scroll padding.
    assert.equal(element.scrollLeft, 101)
  })

  it('moves an option that ends under the edge fade, but not one inside both insets', () => {
    const element = renderPills()
    const writes = scrolling(element, 210)
    // iOS ends at 200, 10 px inside the 210 px box: within the 32 px fade.
    fireEvent.click(option(/^iOS/))
    assert.equal(element.scrollLeft, 200 + 32 - 210)
    // All, at 4–100, lies inside both insets at scroll 1: it stays.
    element.scrollLeft = 1
    writes.length = 0
    fireEvent.click(option(/^All/))
    assert.deepEqual(writes, [])
    assert.equal(element.scrollLeft, 1)
  })

  it('leaves the viewer’s scroll alone when a render keeps the choice', () => {
    const changes: string[] = []
    const { rerender } = render(<Pills changes={changes} />)
    const element = track()
    layOut(element)
    rerender(<Pills changes={changes} />)
    const writes = scrolling(element, 150)
    fireEvent.click(option(/^Android/))
    element.scrollLeft = 20
    writes.length = 0
    rerender(<Pills changes={changes} />)
    assert.equal(option(/^Android/).dataset.thumbOn, '')
    assert.deepEqual(writes, [])
    assert.equal(element.scrollLeft, 20)
  })

  it('never scrolls a track that fits', () => {
    const element = renderPills()
    const writes = scrolling(element, 400)
    fireEvent.click(option(/^Android/))
    assert.deepEqual(writes, [])
    assert.equal(element.dataset.scrolls, undefined)
  })

  it('shows the chosen option on the first placement after it mounts', () => {
    let left = 0
    const stubs: Record<string, PropertyDescriptor> = {
      offsetLeft: {
        get(this: HTMLElement) {
          return 4 + [...this.parentElement!.children].indexOf(this) * 100
        },
      },
      offsetWidth: { get: () => 96 },
      clientWidth: { get: () => 150 },
      scrollWidth: { get: () => 304 },
      scrollLeft: {
        get: () => left,
        set: (value: number) => {
          left = value
        },
      },
    }
    const proto = HTMLElement.prototype
    for (const [key, stub] of Object.entries(stubs)) {
      const own = Object.getOwnPropertyDescriptor(proto, key)
      Object.defineProperty(proto, key, { configurable: true, ...stub })
      restore.push(() => {
        if (own == null)
          delete (proto as unknown as Record<string, unknown>)[key]
        else Object.defineProperty(proto, key, own)
      })
    }
    render(
      <SliderTrack className="m-seg" role="group" aria-label="Platform">
        <button type="button" aria-pressed={false}>
          iOS
        </button>
        <button type="button" aria-pressed={false}>
          Android
        </button>
        <button type="button" aria-pressed>
          tvOS
        </button>
      </SliderTrack>,
    )
    // tvOS ends at 300 in a 150 px box with no padding.
    assert.equal(left, 150)
    assert.equal(track().dataset.scrolls, '')
  })
})
