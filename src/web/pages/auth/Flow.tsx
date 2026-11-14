// A provider sign-in's pages. The node still answers the protocol routes
// (`/auth/start`, `/auth/switch`, `/auth/callback`) and their redirects;
// where one of them used to answer a page, it now answers the app's shell
// with the state in `<meta name="mason-flow">`, and this draws it.
import { useEffect, type JSX } from 'react'
import {
  asSignInFlow,
  FLOW_META,
  type SignInFlow,
} from '../../../shared/api/index.js'
import { Button, buttonClass } from '../../ui/Button.js'
import { SignedOut, StateCard } from './SignedOut.js'

/** The state the node put in the page, if any (an unreadable one is none). */
export function readFlow(doc: Document): SignInFlow | undefined {
  const content = doc
    .querySelector(`meta[name="${FLOW_META}"]`)
    ?.getAttribute('content')
  if (content == null) return undefined
  try {
    return asSignInFlow(JSON.parse(content))
  } catch {
    return undefined
  }
}

const TITLES: Record<SignInFlow['state'], string> = {
  signedIn: 'Signed in',
  failed: 'Sign-in failed',
  unavailable: 'Sign-in unavailable',
  invalid: 'Request could not be completed',
  switch: 'Switch account',
  switchUnavailable: 'Switch account unavailable',
  chooseAccount: 'Choose an account',
}

/** A link to a page the node serves, or a password page: a full load. */
function Go({
  href,
  primary = false,
  children,
}: {
  href: string
  primary?: boolean
  children: string
}): JSX.Element {
  return (
    <a
      className={buttonClass({ variant: primary ? 'primary' : 'secondary' })}
      href={href}
    >
      {children}
    </a>
  )
}

function State({
  flow,
  replace,
}: {
  flow: SignInFlow
  replace: (url: string) => void
}): JSX.Element {
  const next = flow.state === 'signedIn' ? flow.next : undefined
  // Signed in: move on at once from the master's own origin, so its
  // SameSite=Strict cookie goes with the request; this entry leaves history.
  useEffect(() => {
    if (next != null) replace(next)
  }, [next, replace])
  switch (flow.state) {
    case 'signedIn':
      return (
        <StateCard
          tone="success"
          icon="check_circle"
          title="You are signed in"
          actions={
            <Go href={flow.next} primary>
              Continue
            </Go>
          }
        >
          Continuing to Mason…
        </StateCard>
      )
    case 'failed':
      return (
        <StateCard
          tone="danger"
          icon="error"
          title="Sign-in failed"
          actions={<Go href="/sign-in">Sign in again</Go>}
        >
          {flow.message}
        </StateCard>
      )
    case 'unavailable':
      return (
        <StateCard
          icon="login"
          title="Sign-in unavailable"
          actions={<Go href="/sign-in">Sign in</Go>}
        >
          This master offers only its username and password sign-in.
        </StateCard>
      )
    case 'invalid':
      return (
        <StateCard
          tone="danger"
          icon="error"
          title="Request could not be completed"
          actions={<Go href="/auth/login">Sign in</Go>}
        >
          {flow.message}
        </StateCard>
      )
    case 'switch':
      return (
        <StateCard
          icon="person"
          title={`You are signed in as ${flow.name}`}
          actions={
            // A form post, as before: the node checks its proof and origin.
            <form
              method="post"
              action={`/auth/switch/${encodeURIComponent(flow.provider.id)}`}
            >
              <input type="hidden" name="csrf" value={flow.csrf} />
              <input type="hidden" name="return" value={flow.return} />
              <Button type="submit" variant="primary">
                Continue and switch account
              </Button>
            </form>
          }
        >
          Continue to choose an account with {flow.provider.name}.
        </StateCard>
      )
    case 'switchUnavailable':
      return (
        <StateCard
          tone="warning"
          icon="block"
          title="This provider cannot switch accounts"
          actions={<Go href="/">Back to Mason</Go>}
        >
          It does not have an account switching method configured. Ask this
          Mason server’s administrator to configure it.
        </StateCard>
      )
    case 'chooseAccount':
      return (
        <StateCard
          icon="login"
          title="Choose an account"
          actions={
            // A link, so the browser applies no form-action to the provider's address.
            <Go href={flow.target} primary>
              {`Continue to ${flow.provider}`}
            </Go>
          }
        >
          {flow.provider} asks which account to sign in with.
        </StateCard>
      )
  }
}

const browserReplace = (url: string): void => window.location.replace(url)

/** The page for a provider sign-in's state, in the bare shell. */
export function FlowPage({
  flow,
  replace = browserReplace,
}: {
  flow: SignInFlow
  /** How the signed-in state moves on; the browser's own, by default. */
  replace?: (url: string) => void
}): JSX.Element {
  return (
    <SignedOut title={TITLES[flow.state]}>
      <State flow={flow} replace={replace} />
    </SignedOut>
  )
}
