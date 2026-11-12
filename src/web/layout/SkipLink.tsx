import type { JSX } from 'react'

/** The first stop on every page: moves focus past the navigation to the content. */
export function SkipLink(): JSX.Element {
  return (
    <a
      className="m-skip"
      href="#main"
      onClick={(event) => {
        const main = document.getElementById('main')
        if (main == null) return
        event.preventDefault()
        main.focus()
        main.scrollIntoView?.()
      }}
    >
      Skip to content
    </a>
  )
}
