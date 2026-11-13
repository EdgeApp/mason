// Settings → Apple ID for Xcode downloads (screen-10-settings,
// screen-10b-settings-more): the Apple ID session in its three states —
// signed out (Apple ID and password), waiting for Apple's two-factor code,
// signed in (Sign in again reveals the form with the Apple ID filled in) —
// with Apple's notice, and each team's signing: being set up, failed, not
// set up (Set up) or set up with its key and certificate, and Check signing
// again for a chosen team. Forms need apple.change.
import { useState, type FormEvent, type JSX } from 'react'
import {
  APPLE_SIGNING_PATH,
  asAppleSigning,
  type AppleSigning,
} from '../../../../shared/api/admin.js'
import {
  APPLE_SESSION_CODE_PATH,
  APPLE_SESSION_PATH,
  APPLE_SETUP_PATH,
  asAppleSession,
  asAppleSetupResult,
  type AppleSession,
} from '../../../../shared/api/settings.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Button } from '../../../ui/Button.js'
import {
  FormError,
  PasswordInput,
  SelectInput,
  TextInput,
} from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import {
  day,
  Failure,
  Read,
  SettingsCard,
  useActions,
  type Actions,
} from './parts.js'

/** Why a session answer is not a success, if it is not. */
const refusal = (session: AppleSession): string | undefined =>
  session.state === 'failed' || session.state === 'expired'
    ? (session.error ?? session.notice ?? 'Apple refused the sign-in.')
    : undefined

/** The Apple ID and password; signed in, the Apple ID is filled in. */
function SignInForm({
  appleId,
  actions,
  done,
}: {
  appleId: string | undefined
  actions: Actions
  done: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [id, setId] = useState(appleId ?? '')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ id?: string; password?: string }>({})
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(/^\S+@\S+$/.test(id.trim())
        ? {}
        : { id: 'Enter the Apple ID’s email address.' }),
      ...(password === '' ? { password: 'Enter the password.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    let answer: AppleSession | undefined
    const ok = await actions.run('signIn', async () => {
      answer = await client.post(APPLE_SESSION_PATH, asAppleSession, {
        body: { appleId: id.trim(), password },
      })
      const refused = refusal(answer)
      if (refused != null) throw new Error(refused)
    })
    if (!ok || answer == null) return
    setPassword('')
    toast({
      text:
        answer.state === 'needsCode'
          ? 'Apple sent a code'
          : `Signed in as ${answer.appleId ?? id.trim()}`,
      icon: 'lock',
    })
    done()
  }
  return (
    <form
      className="m-stack m-settings__narrowform"
      aria-label="Sign in to the Apple ID"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <TextInput
        label="Apple ID"
        type="email"
        value={id}
        onChange={setId}
        error={errors.id}
        autoComplete="username"
        mono
        verbatim
        required
      />
      <PasswordInput
        label="Password"
        value={password}
        onChange={setPassword}
        error={errors.password}
        autoComplete="current-password"
        required
      />
      <Failure actions={actions} name="signIn" />
      <div className="m-form__actions">
        <Button
          variant="primary"
          type="submit"
          icon="login"
          busy={actions.busy === 'signIn'}
        >
          Sign in
        </Button>
      </div>
    </form>
  )
}

/** Apple's six-digit code, sent to the devices of the Apple ID. */
function CodeForm({
  actions,
  done,
}: {
  actions: Actions
  done: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!/^[0-9]{6}$/.test(code.trim())) {
      setError('Enter the six-digit code.')
      return
    }
    setError(undefined)
    let answer: AppleSession | undefined
    const ok = await actions.run('code', async () => {
      answer = await client.post(APPLE_SESSION_CODE_PATH, asAppleSession, {
        body: { code: code.trim() },
      })
      const refused = refusal(answer)
      if (refused != null) throw new Error(refused)
    })
    if (!ok || answer == null) return
    toast({
      text: `Signed in as ${answer.appleId ?? 'the Apple ID'}`,
      icon: 'check_circle',
    })
    done()
  }
  return (
    <form
      className="m-row m-settings__codeform"
      aria-label="Send the two-factor code"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <TextInput
        label="Two-factor code"
        value={code}
        onChange={setCode}
        error={error}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        code
        required
      />
      <Button
        variant="primary"
        type="submit"
        icon="lock"
        busy={actions.busy === 'code'}
      >
        Send code to the master
      </Button>
      <Failure actions={actions} name="code" />
    </form>
  )
}

/** Each team's signing, and checking it again. */
function Signing({
  signing,
  change,
  done,
}: {
  signing: AppleSigning
  change: boolean
  done: () => void
}): JSX.Element | null {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const setup = signing.setup
  const [team, setTeam] = useState(setup?.teams[0]?.id ?? '')
  if (setup == null) return null
  const check = async (id: string): Promise<void> => {
    const ok = await actions.run(`setup-${id}`, async () => {
      const answer = await client.post(APPLE_SETUP_PATH, asAppleSetupResult, {
        body: { team: id },
      })
      toast({
        text: `Signing checked for ${answer.team.name}`,
        icon: 'check_circle',
      })
    })
    if (ok) done()
  }
  const configured = new Map(setup.configured.map((entry) => [entry.id, entry]))
  // The Apple ID's teams, then any set up before that it no longer lists.
  const teams = [
    ...setup.teams,
    ...setup.configured.filter(
      (entry) => !setup.teams.some((listed) => listed.id === entry.id),
    ),
  ]
  const listed = signing.failures['']
  const chosen = setup.teams.some((entry) => entry.id === team)
    ? team
    : (setup.teams[0]?.id ?? '')
  return (
    <div className="m-stack m-settings__signing">
      <h3 className="m-t-headline">
        <Icon name="key" /> Signing for a team
      </h3>
      {setup.error != null && <FormError>{setup.error}</FormError>}
      {listed != null && <FormError>{listed}</FormError>}
      {teams.length > 0 && (
        <ul className="m-list m-settings__teams">
          {teams.map((entry) => {
            const done = configured.get(entry.id)
            const failure = signing.failures[entry.id]
            const settingUp = signing.settingUp.includes(entry.id)
            const button = change &&
              !settingUp &&
              (failure != null || done == null) && (
                <span className="m-list__end">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="key"
                    busy={actions.busy === `setup-${entry.id}`}
                    onClick={() => void check(entry.id)}
                  >
                    Set up {entry.name}
                  </Button>
                </span>
              )
            const label = `${entry.name} (${entry.id})`
            return (
              <li
                key={entry.id}
                className="m-list__row m-settings__team"
                data-team={entry.id}
              >
                {settingUp ? (
                  <StatusPill status="setting_up" />
                ) : failure != null ? (
                  <StatusPill status="failed" />
                ) : done == null ? (
                  <StatusPill status="not_set_up" />
                ) : (
                  <StatusPill status="ready" label="Set up" />
                )}
                <span className="m-list__main">
                  <span className="m-t-headline">
                    {entry.name}{' '}
                    <span className="m-t-mono-sm m-secondary">{entry.id}</span>
                  </span>
                  <span className="m-list__sub">
                    {settingUp
                      ? `Setting signing up for ${label}…`
                      : failure != null
                        ? failure
                        : done == null
                          ? `Signing is not set up for ${label}.`
                          : `Signing is set up for ${label}: App Store Connect API key ${setup.keyName} (${done.keyId}), ${
                              done.certificate == null
                                ? 'no distribution certificate yet'
                                : `${done.certificate.name}, expires ${day(done.certificate.expiresAt)}`
                            }.`}
                  </span>
                </span>
                {button}
              </li>
            )
          })}
        </ul>
      )}
      <p className="m-t-subhead m-secondary">
        When the Apple ID signs in, Mason sets up its team by itself: it makes
        the team’s App Store Connect API key{' '}
        <span className="m-t-mono-sm">{setup.keyName}</span> and its
        distribution certificate, and keeps them. With several teams, it sets up
        by itself only those this master already uses, with a stored key or an
        app ID assigned to them; set up another here. Checking again asks Apple
        about a team’s key and certificate and replaces only one that is gone;
        nothing that still works is revoked.
      </p>
      {setup.teams.length === 0 ? (
        <p className="m-t-callout">
          This Apple ID belongs to no developer team.
        </p>
      ) : (
        change && (
          <form
            className="m-row m-settings__checkform"
            aria-label="Check signing again"
            onSubmit={(event) => {
              event.preventDefault()
              void check(chosen)
            }}
          >
            <SelectInput
              label="Team"
              value={chosen}
              onChange={setTeam}
              options={setup.teams.map((entry) => ({
                value: entry.id,
                label: `${entry.name} (${entry.id})`,
              }))}
            />
            <Button
              variant="secondary"
              type="submit"
              icon="refresh"
              busy={actions.busy === `setup-${chosen}`}
            >
              Check signing again
            </Button>
          </form>
        )
      )}
      {teams.map((entry) => (
        <Failure key={entry.id} actions={actions} name={`setup-${entry.id}`} />
      ))}
    </div>
  )
}

/** What the card shows of the session, and its forms. */
function AppleBody({
  signing,
  change,
  done,
}: {
  signing: AppleSigning
  change: boolean
  done: () => void
}): JSX.Element {
  const actions = useActions()
  const [again, setAgain] = useState(false)
  const failures = Object.values(signing.failures)
  return (
    <div className="m-card__body m-stack">
      <p className="m-t-callout m-settings__status">
        {signing.signedIn ? (
          <>
            Signed in as <strong>{signing.appleId ?? 'the Apple ID'}</strong>.
          </>
        ) : signing.needsCode ? (
          <>
            Not signed in. Apple sent a six-digit code to the devices of{' '}
            <strong>{signing.appleId ?? 'the Apple ID'}</strong>.
          </>
        ) : (
          'Not signed in.'
        )}
      </p>
      {signing.notice != null && (
        <div className="m-callout m-settings__notice">
          <Icon name="warning" />
          <span>{signing.notice}</span>
        </div>
      )}
      {change &&
        (signing.needsCode ? (
          <CodeForm actions={actions} done={done} />
        ) : signing.signedIn ? (
          <>
            <div>
              <Button
                variant="secondary"
                icon="login"
                aria-expanded={again}
                onClick={() => setAgain((was) => !was)}
              >
                Sign in again
              </Button>
            </div>
            {again && (
              <SignInForm
                appleId={signing.appleId}
                actions={actions}
                done={() => {
                  setAgain(false)
                  done()
                }}
              />
            )}
          </>
        ) : (
          <SignInForm appleId={signing.appleId} actions={actions} done={done} />
        ))}
      {signing.signedIn && signing.setup != null ? (
        <Signing signing={signing} change={change} done={done} />
      ) : (
        // Signed out, a team whose setup failed is still shown.
        failures.map((failure) => (
          <div key={failure} className="m-callout m-settings__notice">
            <Icon name="error" />
            <span>{failure}</span>
          </div>
        ))
      )}
    </div>
  )
}

/** The card: its state in the header, then the session and signing. */
export function AppleCard({ change }: { change: boolean }): JSX.Element {
  const read = useResource(APPLE_SIGNING_PATH, asAppleSigning)
  const data = read.data
  return (
    <SettingsCard
      id="apple-session"
      icon="key"
      title="Apple ID for Xcode downloads"
      actions={
        data == null ? undefined : (
          <StatusPill
            status={
              data.needsCode
                ? 'needs_code'
                : data.signedIn
                  ? 'signed_in'
                  : 'signed_out'
            }
          />
        )
      }
    >
      <Read read={read} what="The Apple ID">
        {(signing) => (
          <AppleBody signing={signing} change={change} done={read.reload} />
        )}
      </Read>
    </SettingsCard>
  )
}
