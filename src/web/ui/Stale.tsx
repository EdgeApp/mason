import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { PAGE_TITLE_ID } from './PageHeader.js'

/**
 * Content drawn from a stale answer (`Resource.stale`) while the new one
 * loads: dimmed, inert so nothing in it can be pressed, and busy for
 * assistive tech. It adds no box, so the page lays it out as before. A
 * choice made inside it (another platform's link) would leave focus on an
 * inert element and then on nothing, so focus moves to the page's title,
 * which announces the page.
 */
export function Stale({
  stale,
  children,
}: {
  stale: boolean
  children: ReactNode
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (stale && box.current?.contains(document.activeElement) === true)
      document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true })
  }, [stale])
  return (
    <div
      ref={box}
      className="m-stale"
      data-stale={stale ? '' : undefined}
      inert={stale}
      aria-busy={stale || undefined}
    >
      {children}
    </div>
  )
}
