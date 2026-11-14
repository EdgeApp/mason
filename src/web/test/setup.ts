// Loaded with `mocha --require ./lib/web/test/setup.js` (the source file
// under tsx) by the web tests' own mocha process only, before any spec imports React: installs a jsdom
// window's `window`, `document`, `navigator`, `localStorage` and the rest on
// globalThis. The server suites run in a separate process and never see it.
import { JSDOM } from 'jsdom'

/** The page every web test renders into, at the master's origin. */
export const dom = new JSDOM(
  '<!doctype html><html><head></head><body></body></html>',
  {
    url: 'https://mason.test/',
    pretendToBeVisual: true,
  },
)

const window = dom.window as unknown as Window & typeof globalThis

/**
 * jsdom has no media queries; this answers every query unmatched, and a test
 * replaces `window.matchMedia` to match one.
 */
window.matchMedia = (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList

/**
 * jsdom has no modal dialogs: showModal() and close() here only open and
 * close it (and close() fires `close`), which is what the app's overlays
 * rely on; the inert page behind is the browser's, proven end to end.
 */
const dialog = window.HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void
}
if (typeof dialog.showModal !== 'function') {
  dialog.showModal = function (this: HTMLDialogElement): void {
    this.setAttribute('open', '')
  }
  dialog.close = function (this: HTMLDialogElement): void {
    if (!this.hasAttribute('open')) return
    this.removeAttribute('open')
    this.dispatchEvent(new window.Event('close'))
  }
}

// jsdom does not lay out or scroll; scrolling to the top is a no-op here.
window.scrollTo = (() => undefined) as typeof window.scrollTo

const install = (key: string, get: () => unknown): void => {
  Object.defineProperty(globalThis, key, { configurable: true, get })
}
// What Node already defines (navigator, Event, fetch …) is replaced only
// where the page needs jsdom's own: React builds a FormData of a jsdom form
// when a submit starts a navigation.
for (const key of ['window', 'self', 'document', 'navigator', 'FormData'])
  install(key, () =>
    key === 'window' || key === 'self' ? window : window[key as keyof Window],
  )
for (const key of Object.getOwnPropertyNames(window))
  if (!(key in globalThis)) install(key, () => window[key as keyof Window])
// React's act() warns unless the environment says it is a test.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
