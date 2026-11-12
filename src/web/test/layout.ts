// jsdom lays nothing out: this gives the log viewer's scrolling body a size
// and a scroll position, so the virtualizer draws the lines in view and the
// viewer can follow, scroll up and go back to the end as in a browser.

/** The log body's height in the tests. */
export const BODY_HEIGHT = 400

const scrolled = new WeakMap<Element, number>()

const isBody = (element: Element): boolean =>
  element.classList.contains('m-log__body')

/** How tall the body's content is: its rows' height, as the virtualizer set it. */
function contentHeight(element: Element): number {
  const rows = element.querySelector<HTMLElement>('.m-log__rows')
  return rows == null ? 0 : parseFloat(rows.style.height) || 0
}

/** Installs the layout; returns the restore. */
export function fakeLogLayout(): () => void {
  const proto = window.HTMLElement.prototype
  // The virtualizer reads the box's size from its offset size.
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isBody(this) ? BODY_HEIGHT : 0
    },
  })
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return isBody(this) ? 800 : 0
    },
  })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isBody(this) ? BODY_HEIGHT : 0
    },
  })
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isBody(this) ? Math.max(BODY_HEIGHT, contentHeight(this)) : 0
    },
  })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement): number {
      return scrolled.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      const most = isBody(this)
        ? Math.max(0, contentHeight(this) - BODY_HEIGHT)
        : 0
      scrolled.set(this, Math.max(0, Math.min(most, value)))
    },
  })
  return () => {
    for (const name of [
      'offsetHeight',
      'offsetWidth',
      'clientHeight',
      'scrollHeight',
      'scrollTop',
    ] as const)
      delete (proto as unknown as Record<string, unknown>)[name]
  }
}

/** Scrolls the log body to `top` and tells it so, as a person scrolling does. */
export function scrollLog(body: HTMLElement, top: number): void {
  body.scrollTop = top
  body.dispatchEvent(new window.Event('scroll'))
}
