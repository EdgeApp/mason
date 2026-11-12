// Sign in, on the master (`/sign-in`) and the host (`/auth/login`): a
// button per provider the node offers, then the username-or-email and
// password form. The password is hashed with Argon2id in the worker; only
// the hash goes to the node (the host relays it to the master), and a
// signed-in browser leaves with a full load so the next page's own CSP
// applies.
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { useLocation } from 'react-router'
import type { NodeInfo } from '../../../shared/api/index.js'
import { safeReturn } from '../../../shared/routes.js'
import { useApi } from '../../api/context.js'
import { useProfile } from '../../profile/NodeProfile.js'
import { Button, buttonClass } from '../../ui/Button.js'
import { FormError, PasswordInput, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { useHasher } from '../../workers/hasher.js'
import {
  focusFirstInvalid,
  refusal,
  SignedOut,
  StateCard,
} from './SignedOut.js'

/** A refusal that asks to come back shortly ("…; try again shortly"): its headline and what to do. */
export function shortly(message: string): [string, string] | undefined {
  const found = /^(.+?);\s*try again shortly\.?$/i.exec(message)
  return found == null ? undefined : [found[1]!, 'Try again shortly.']
}

/** Where a provider's button starts its sign-in, and where it comes back to. */
export function providerHref(
  node: NodeInfo,
  id: string,
  destination: string,
): string {
  const start = `/auth/start/${encodeURIComponent(id)}?return=${encodeURIComponent(destination)}`
  // The master's providers call back to its public origin, so they start there.
  return node.role === 'master' ? `${node.masterOrigin ?? ''}${start}` : start
}

export function SignInPage({ node }: { node: NodeInfo }): JSX.Element {
  const client = useApi()
  const hasher = useHasher()
  const profile = useProfile()
  const query = new URLSearchParams(useLocation().search)
  // The host returns to the page that sent the browser here; the master opens at its home.
  const destination =
    profile.role === 'host' ? safeReturn(query.get('return')) : '/'
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [missing, setMissing] = useState<{
    identifier?: string
    password?: string
  }>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  // On failure, focus moves to what went wrong (DESIGN-LANGUAGE.md §12).
  useEffect(() => {
    if (failure != null) error.current?.focus()
  }, [failure])
  const providers = node.signIn.providers

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const required = {
      ...(identifier.trim() === ''
        ? { identifier: 'Enter your username or email' }
        : {}),
      ...(password === '' ? { password: 'Enter your password' } : {}),
    }
    setMissing(required)
    if (
      focusFirstInvalid(required, [
        ['identifier', 'sign-in-username'],
        ['password', 'sign-in-password'],
      ])
    )
      return
    setBusy(true)
    setFailure(undefined)
    try {
      const name = identifier.trim()
      const parameters = await client.parameters(name)
      await client.signIn(name, await hasher.hash(password, parameters))
      client.leave(destination)
    } catch (caught) {
      setBusy(false)
      setFailure(refusal(caught))
    }
  }

  const later = failure == null ? undefined : shortly(failure)
  return (
    <SignedOut
      title="Sign in"
      description="Sign in to app builds and run logs with your Mason account."
      mark
    >
      {query.get('signed_out') === '1' && (
        <p className="m-signin__note m-t-subhead m-secondary" role="status">
          You are signed out.
        </p>
      )}
      {later != null && (
        <StateCard tone="warning" icon="hourglass_top" title={later[0]}>
          {later[1]}
        </StateCard>
      )}
      <section className="m-card" aria-label="Sign in">
        <div className="m-card__body m-stack m-stack--lg">
          {providers.map((provider) => (
            <a
              key={provider.id}
              className={buttonClass({
                variant: 'secondary',
                size: 'lg',
                className: 'm-signin__wide',
              })}
              href={providerHref(node, provider.id, destination)}
            >
              <Icon name="login" />
              Sign in with {provider.name}
            </a>
          ))}
          {providers.length > 0 && node.signIn.password && (
            <div className="m-or">or with a username or email</div>
          )}
          {node.signIn.password && (
            <form
              name="sign-in"
              className="m-stack"
              noValidate
              onSubmit={(event) => void submit(event)}
            >
              <TextInput
                id="sign-in-username"
                name="username"
                label="Username or email"
                value={identifier}
                onChange={setIdentifier}
                autoComplete="username"
                required
                verbatim
                error={missing.identifier}
              />
              <PasswordInput
                id="sign-in-password"
                name="password"
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                required
                error={missing.password}
              />
              {failure != null && later == null && (
                <FormError ref={error}>{failure}</FormError>
              )}
              <Button
                type="submit"
                variant="primary"
                size="lg"
                busy={busy}
                className="m-signin__wide"
              >
                Sign in
              </Button>
            </form>
          )}
        </div>
      </section>
      {node.signIn.password && (
        <p className="m-signin__note m-t-subhead m-tertiary">
          Mason hashes your password in this browser before sending it.
        </p>
      )}
    </SignedOut>
  )
}
