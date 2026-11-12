import type { JSX, ReactNode } from 'react'
import { useProfile } from '../profile/NodeProfile.js'
import { Chip } from '../ui/Chip.js'
import { cx } from '../ui/cx.js'
import { SkipLink } from './SkipLink.js'

/**
 * The signed-out shell (sign-in, setup, invitations) and the node's
 * full-page states: the brand only, one centred column.
 */
export function BareShell({
  children,
  wide = false,
  centred = false,
}: {
  children: ReactNode
  wide?: boolean
  /** A full-page state, centred on the screen. */
  centred?: boolean
}): JSX.Element {
  const profile = useProfile()
  return (
    <div className="m-bare">
      <SkipLink />
      <header className="m-bare__top">
        <img
          src="/assets/logo/mason-logo-64.png"
          alt=""
          width="32"
          height="32"
        />
        <strong>Mason</strong>
        {profile.version !== '' && <Chip kind="mono">v{profile.version}</Chip>}
      </header>
      <main
        className={cx(
          'm-bare__main',
          wide && 'm-bare__main--wide',
          centred && 'm-bare__main--state',
        )}
        id="main"
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  )
}
