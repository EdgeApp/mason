import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react'

/** The options of a slider pill that can carry its thumb. */
const OPTION = ':scope > a, :scope > button'
/** The option the page has chosen. */
const CHOSEN =
  "[aria-pressed='true'], [aria-selected='true'], [aria-current='true'], [aria-current='page']"
/** How far a press moves before it is a drag rather than a tap, in pixels. */
const SLOP = 4

/** The option under a point, or the nearest one to it. */
function optionAt(
  options: HTMLElement[],
  x: number,
  y: number,
): HTMLElement | undefined {
  let best: HTMLElement | undefined
  let distance = Infinity
  for (const option of options) {
    const box = option.getBoundingClientRect()
    const dx = Math.max(box.left - x, 0, x - box.right)
    const dy = Math.max(box.top - y, 0, y - box.bottom)
    const d = dx * dx + dy * dy
    if (d < distance) {
      distance = d
      best = option
    }
  }
  return best
}

/**
 * A slider pill's thumb (segmented controls, filter pills, the tab bar): one
 * shape behind the chosen option that slides to the next one chosen, and
 * that a press on it can drag to another option, choosing it on release.
 *
 * The track (the returned ref) gets `data-thumb` and the thumb's box as
 * `--thumb-x`, `--thumb-y`, `--thumb-w` and `--thumb-h`; the option under the
 * thumb gets `data-thumb-on`, and the track `data-dragging` while it is
 * dragged. Without a chosen option the track has no thumb, and the CSS falls
 * back to colouring the chosen option itself.
 */
export function useSlidingThumb<T extends HTMLElement>(): RefObject<T | null> {
  const track = useRef<T>(null)

  /** Puts the thumb on an option (or, with none, takes it away). */
  const place = useCallback((on: HTMLElement | undefined): void => {
    const element = track.current
    if (element == null) return
    for (const option of element.querySelectorAll<HTMLElement>(OPTION))
      if (option !== on) delete option.dataset.thumbOn
    if (on == null) {
      delete element.dataset.thumb
      return
    }
    on.dataset.thumbOn = ''
    // Written only when they change: the owner renders often (a live queue
    // redraws the dashboard), and most renders move nothing.
    const box = {
      '--thumb-x': on.offsetLeft,
      '--thumb-y': on.offsetTop,
      '--thumb-w': on.offsetWidth,
      '--thumb-h': on.offsetHeight,
    }
    for (const [name, px] of Object.entries(box))
      if (element.style.getPropertyValue(name) !== `${px}px`)
        element.style.setProperty(name, `${px}px`)
    element.dataset.thumb = ''
    // A track wider than its box (a filter row on a phone) scrolls sideways.
    const scrolls = element.scrollWidth > element.clientWidth + 1
    if (scrolls !== (element.dataset.scrolls != null))
      if (scrolls) element.dataset.scrolls = ''
      else delete element.dataset.scrolls
  }, [])

  /** Puts the thumb back on the chosen option. */
  const settle = useCallback((): void => {
    const element = track.current
    if (element == null || element.dataset.dragging != null) return
    const options = [...element.querySelectorAll<HTMLElement>(OPTION)]
    place(options.find((option) => option.matches(CHOSEN)))
  }, [place])

  // Any render of the owner may have chosen another option, or changed an
  // option's label (and so its width) without resizing the track.
  useLayoutEffect(settle)

  useEffect(() => {
    const element = track.current
    if (element == null) return
    // Fonts arriving and the window narrowing move the options.
    const resized =
      typeof ResizeObserver === 'function' ? new ResizeObserver(settle) : null
    resized?.observe(element)

    let press: { id: number; x: number; y: number; dragging: boolean } | null =
      null
    /** Swallows the click the browser sends after a drag, once. */
    let swallow = false
    const options = (): HTMLElement[] => [
      ...element.querySelectorAll<HTMLElement>(OPTION),
    ]
    /** Ends the press without choosing: the thumb goes back to the choice. */
    const drop = (): void => {
      press = null
      delete element.dataset.dragging
      settle()
    }
    const down = (event: PointerEvent): void => {
      // Another finger while one drags the thumb is not a new press.
      if (press?.dragging === true && event.pointerId !== press.id) return
      // Any other press ends the last one, which ended unheard outside the track.
      if (press != null) drop()
      if (event.button !== 0) return
      const on = (event.target as Element).closest?.('[data-thumb-on]')
      // Only the thumb drags, as on iOS: elsewhere a press is a tap or a scroll.
      // A track that scrolls sideways keeps its swipes for scrolling.
      if (
        on == null ||
        !element.contains(on) ||
        element.dataset.scrolls != null
      )
        return
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      }
    }
    const move = (event: PointerEvent): void => {
      if (press == null || event.pointerId !== press.id) return
      // No button down: the press ended outside the track, unheard.
      if (event.buttons === 0) {
        drop()
        return
      }
      if (!press.dragging) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < SLOP)
          return
        press.dragging = true
        element.dataset.dragging = ''
        element.setPointerCapture?.(event.pointerId)
      }
      event.preventDefault()
      place(optionAt(options(), event.clientX, event.clientY))
    }
    const up = (event: PointerEvent): void => {
      if (press == null || event.pointerId !== press.id) return
      const dragged = press.dragging
      press = null
      delete element.dataset.dragging
      if (!dragged) return
      const target = element.querySelector<HTMLElement>('[data-thumb-on]')
      if (target != null && !target.matches(CHOSEN)) target.click()
      swallow = true
      setTimeout(() => {
        swallow = false
      }, 0)
      requestAnimationFrame(settle)
    }
    const cancel = (event: PointerEvent): void => {
      if (press == null || event.pointerId !== press.id) return
      drop()
    }
    const click = (event: MouseEvent): void => {
      if (!swallow) return
      swallow = false
      event.preventDefault()
      event.stopPropagation()
    }
    // A link would otherwise start the browser's own drag of its address.
    const drag = (event: DragEvent): void => {
      event.preventDefault()
    }
    element.addEventListener('pointerdown', down)
    element.addEventListener('dragstart', drag)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', cancel)
    element.addEventListener('click', click, true)
    return (): void => {
      resized?.disconnect()
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('dragstart', drag)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', cancel)
      element.removeEventListener('click', click, true)
    }
  }, [place, settle])

  return track
}
