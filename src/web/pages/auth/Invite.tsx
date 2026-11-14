// An invitation link (`/auth/invite#token`, on the host or the master): the
// token is the fragment, so it never reaches a server log. The page reads
// it once, takes it out of the address bar and history, asks the node whom
// it is for, and sets the person's username and password with it (the host
// relays both to the master). Only the new password's hash leaves the page.
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { checkNewPassword } from '../../../auth/passwordProtocol.js'
import {
  asInvitationLookup,
  asSignedIn,
  INVITE_ACCEPT_PATH,
  INVITE_LOOKUP_PATH,
  type InvitationAcceptance,
  type InvitationLookup,
} from '../../../shared/api/index.js'
import { useApi } from '../../api/context.js'
import { useProfile } from '../../profile/NodeProfile.js'
import { Button, buttonClass } from '../../ui/Button.js'
import { FormError, PasswordInput, TextInput } from '../../ui/Field.js'
import { SkeletonText } from '../../ui/Skeleton.js'
import { useHasher } from '../../workers/hasher.js'
import { shortly } from './SignIn.js'
import {
  focusFirstInvalid,
  refusal,
  SignedOut,
  StateCard,
  unavailable,
} from './SignedOut.js'

/** The username rule the master applies. */
export const USERNAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
const username = new RegExp(`^${USERNAME_PATTERN}$`)

export const PASSWORD_RULE =
  'At least 8 characters with uppercase, lowercase and a number, or 17 characters or more.'

/** The welcome line for whom the invitation is for. */
export function welcome(person: InvitationLookup): string {
  // Someone with a confirmed email may sign in with it instead of a username.
  const optional = person.username == null && person.usernameRequired === false
  return `Welcome, ${person.name}. Choose a password${person.username != null ? '' : optional ? ' (and a username, if you want one)' : ' and a username'} to sign in to Mason.`
}

type Lookup =
  | { kind: 'reading' }
  | { kind: 'found'; person: InvitationLookup }
  | { kind: 'refused'; message: string; retry: boolean }

/** The form, for a person the token is for. */
function Choose({
  token,
  person,
}: {
  token: string
  person: InvitationLookup
}): JSX.Element {
  const client = useApi()
  const hasher = useHasher()
  const profile = useProfile()
  const optional = person.username == null && person.usernameRequired === false
  const [name, setName] = useState(person.username ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<string | undefined>()
  const [isSet, setIsSet] = useState(false)
  const failureRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failureRef.current?.focus()
  }, [failure])

  const problems = (): Partial<Record<string, string>> => {
    const found: Partial<Record<string, string>> = {}
    if (person.username == null) {
      if (name === '' && !optional) found.username = 'Choose a username'
      else if (name !== '' && !username.test(name))
        found.username =
          'Use up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit'
    }
    try {
      checkNewPassword(password)
    } catch (error) {
      found.password = (error as Error).message
    }
    if (confirm !== password) found.confirm = 'The passwords do not match'
    return found
  }
  const blur = (field: string, value: string): void => {
    if (value === '') return
    setErrors({ ...errors, [field]: problems()[field] })
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const found = problems()
    setErrors(found)
    if (
      focusFirstInvalid(found, [
        ['username', 'invite-username'],
        ['password', 'invite-password'],
        ['confirm', 'invite-confirm'],
      ])
    )
      return
    setBusy(true)
    setFailure(undefined)
    try {
      setProgress('Preparing your password: this takes a few seconds.')
      const { clientHash, clientParameters } = await hasher.create(password)
      setProgress('Setting your password…')
      const body: InvitationAcceptance = {
        token,
        username: name,
        clientHash,
        clientParameters,
      }
      await client.post(INVITE_ACCEPT_PATH, asSignedIn, {
        body,
        csrf: false,
        redirect: false,
      })
      client.leave('/')
    } catch (caught) {
      setProgress('')
      setBusy(false)
      const message = refusal(caught)
      // The host could not see the account yet: the password is set all the same.
      if (/^Your password is set/.test(message)) setIsSet(true)
      else setFailure(message)
    }
  }

  if (isSet)
    return (
      <StateCard
        tone="success"
        icon="check_circle"
        title="Your password is set"
        actions={
          <a
            className={buttonClass({ variant: 'primary' })}
            href={profile.signIn('/')}
          >
            Sign in
          </a>
        }
      >
        Sign in with it in a moment, once this node has your account.
      </StateCard>
    )
  const later = failure == null ? undefined : shortly(failure)
  return (
    <>
      {later != null && (
        <StateCard tone="warning" icon="hourglass_top" title={later[0]}>
          {later[1]}
        </StateCard>
      )}
      <section className="m-card" aria-label="Choose your password">
        <div className="m-card__body m-stack">
          <form
            name="invite"
            className="m-stack"
            noValidate
            onSubmit={(event) => void submit(event)}
          >
            <TextInput
              id="invite-username"
              name="username"
              label="Username"
              optional={optional}
              value={name}
              onChange={setName}
              onBlur={() => blur('username', name)}
              readOnly={person.username != null}
              required={!optional && person.username == null}
              autoComplete="username"
              pattern={USERNAME_PATTERN}
              maxLength={64}
              mono
              verbatim
              help={
                person.username != null
                  ? 'Your username stays as it is.'
                  : optional
                    ? 'Or sign in with your confirmed email. Letters, digits, dots, dashes and underscores.'
                    : 'Letters, digits, dots, dashes and underscores.'
              }
              error={errors.username}
            />
            <PasswordInput
              id="invite-password"
              name="password"
              label="Password"
              value={password}
              onChange={setPassword}
              onBlur={() => blur('password', password)}
              autoComplete="new-password"
              required
              help={PASSWORD_RULE}
              error={errors.password}
            />
            <PasswordInput
              id="invite-confirm"
              name="confirm"
              label="Confirm"
              value={confirm}
              onChange={setConfirm}
              onBlur={() => blur('confirm', confirm)}
              autoComplete="new-password"
              required
              error={errors.confirm}
            />
            {failure != null && later == null && (
              <FormError ref={failureRef}>{failure}</FormError>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              busy={busy}
              className="m-signin__wide"
            >
              Set password and sign in
            </Button>
            <p className="m-formstatus m-t-subhead m-secondary" role="status">
              {progress}
            </p>
          </form>
        </div>
      </section>
    </>
  )
}

export function InvitePage(): JSX.Element {
  const client = useApi()
  const location = useLocation()
  const navigate = useNavigate()
  // Read once: the address loses it below.
  const [token] = useState(() => location.hash.replace(/^#/, ''))
  const [lookup, setLookup] = useState<Lookup>({ kind: 'reading' })
  const [attempt, setAttempt] = useState(0)
  // The token leaves the address bar and this history entry.
  useEffect(() => {
    if (location.hash !== '')
      void navigate(
        { pathname: location.pathname, search: location.search },
        { replace: true },
      )
  }, [location.hash, location.pathname, location.search, navigate])
  useEffect(() => {
    if (token === '') return
    const controller = new AbortController()
    setLookup({ kind: 'reading' })
    client
      .post(INVITE_LOOKUP_PATH, asInvitationLookup, {
        body: { token },
        csrf: false,
        redirect: false,
        signal: controller.signal,
      })
      .then(
        (person) => setLookup({ kind: 'found', person }),
        (error: unknown) => {
          if (controller.signal.aborted) return
          setLookup({
            kind: 'refused',
            message: refusal(error),
            retry: unavailable(error),
          })
        },
      )
    return (): void => controller.abort()
  }, [client, token, attempt])

  const body = ((): JSX.Element => {
    if (token === '')
      return (
        <StateCard
          tone="warning"
          icon="link"
          title="This invitation link is incomplete"
        >
          Copy all of it from the message you were sent.
        </StateCard>
      )
    if (lookup.kind === 'reading')
      return (
        <section className="m-card" aria-label="Reading your invitation">
          <div className="m-card__body m-stack">
            <SkeletonText lines={4} label="Reading your invitation" />
          </div>
        </section>
      )
    if (lookup.kind === 'refused') {
      const later = shortly(lookup.message)
      return lookup.retry ? (
        <StateCard
          tone="warning"
          icon="hourglass_top"
          title={later?.[0] ?? lookup.message}
          actions={
            <Button
              variant="secondary"
              icon="refresh"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          }
        >
          {later?.[1] ?? 'Try again shortly.'}
        </StateCard>
      ) : (
        <StateCard
          tone="danger"
          icon="error"
          title="This invitation cannot be used"
        >
          {lookup.message}. Ask whoever invited you for a new link.
        </StateCard>
      )
    }
    return <Choose token={token} person={lookup.person} />
  })()
  return (
    <SignedOut
      title="Choose your password"
      description={
        lookup.kind === 'found'
          ? welcome(lookup.person)
          : 'Choose a username and a password to sign in to Mason.'
      }
    >
      {body}
    </SignedOut>
  )
}
