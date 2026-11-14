// Your account, on the master and the host (screen-13-account): the
// viewer's name and addresses, edited and saved through the same confirm as
// People; their username and role, read-only; Appearance; their password,
// hashed in the worker (on a host only a tester's changes there); and Sign
// out. While a host cannot reach its master the page is read-only.
import { asUnknown } from 'cleaners'
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { useHref } from 'react-router'
import {
  ACCOUNT_PATH,
  asAccountInfo,
  type AccountInfo,
} from '../../../shared/api/account.js'
import { personPath } from '../../../shared/api/people.js'
import { useApi } from '../../api/context.js'
import {
  APPEARANCE_LABELS,
  useAppearance,
  type Appearance,
} from '../../hooks/useAppearance.js'
import { useResource, type Resource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { useProfile } from '../../profile/NodeProfile.js'
import { Alert } from '../../ui/Alert.js'
import { Banner } from '../../ui/Banner.js'
import { Button } from '../../ui/Button.js'
import { FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { SkeletonText } from '../../ui/Skeleton.js'
import { useToast } from '../../ui/Toast.js'
import {
  AddEmailSheet,
  ChangeLines,
  EmailLines,
  PasswordSheet,
  SELF_EMAIL_HINT,
} from '../admin/people/editing.js'
import {
  changesOf,
  draftOf,
  NAME_MAX,
  nameProblem,
  ROLE_WORDS,
  type Draft,
  type PersonState,
} from '../admin/people/personDraft.js'
import { Failed } from '../projects/project.js'

/** Why nothing can be changed while a host's master is away. */
export const READ_ONLY =
  'The host cannot reach the master right now, so your account cannot be changed. Try again shortly.'

const APPEARANCES: Appearance[] = ['dark', 'light', 'system']

/** The account as its form starts from. */
const stateOf = (account: AccountInfo): PersonState => ({
  name: account.name,
  username: account.username ?? '',
  role: account.role,
  emails: account.emails,
})

/** A card's header: its glyph and title. */
function CardHeader({
  id,
  icon,
  title,
}: {
  id: string
  icon: 'person' | 'tune' | 'lock'
  title: string
}): JSX.Element {
  return (
    <header className="m-card__header">
      <div className="m-card__title">
        <Icon name={icon} />
        <h2 className="m-t-title3" id={id}>
          {title}
        </h2>
      </div>
    </header>
  )
}

/** Profile: the name and addresses to change, the username and role to read. */
function ProfileForm({
  account,
  changed,
}: {
  account: AccountInfo
  changed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const original = stateOf(account)
  const [draft, setDraft] = useState<Draft>(() => draftOf(original))
  const [nameError, setNameError] = useState<string | undefined>()
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const failed = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failed.current?.focus()
  }, [failure])
  const editable = account.editable
  const { lines, body } = changesOf(original, draft)
  const ask = (event: FormEvent): void => {
    event.preventDefault()
    const problem = nameProblem(draft.name)
    setNameError(problem)
    if (problem == null && lines.length > 0) setConfirming(true)
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await client.put(personPath(account.id), asUnknown, { body })
      toast({ text: 'Your account is saved', icon: 'check_circle' })
      setConfirming(false)
      changed()
    } catch (reason) {
      setConfirming(false)
      setFailure((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <form className="m-form" name="account" noValidate onSubmit={ask}>
        <TextInput
          label="Full name"
          name="name"
          value={draft.name}
          onChange={(name) => setDraft({ ...draft, name })}
          error={nameError}
          maxLength={NAME_MAX}
          autoComplete="name"
          readOnly={!editable}
          required
        />
        <TextInput
          label="Username"
          name="username"
          value={account.username ?? '—'}
          onChange={() => undefined}
          help="Only an administrator changes it."
          readOnly
          mono
        />
        <div className="m-field" role="group" aria-labelledby="account-emails">
          <span className="m-field__label" id="account-emails">
            Email addresses
          </span>
          <EmailLines
            draft={draft}
            mode={editable ? 'self' : 'none'}
            onChange={setDraft}
          />
          <Button
            variant="tinted"
            size="sm"
            icon="add"
            aria-haspopup="dialog"
            aria-label="Add an email address"
            className="m-people__addemail"
            disabled={!editable}
            title={editable ? undefined : READ_ONLY}
            onClick={() => setAdding(true)}
          >
            Add an address
          </Button>
          <p className="m-field__help">{SELF_EMAIL_HINT}</p>
        </div>
        <dl className="m-kv">
          <dt>Role</dt>
          <dd>{ROLE_WORDS[account.role]}</dd>
        </dl>
        {failure != null && <FormError ref={failed}>{failure}</FormError>}
        <div className="m-form__actions">
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={!editable || lines.length === 0}
            title={editable ? undefined : READ_ONLY}
          >
            Save
          </Button>
          <span className="m-t-subhead m-tertiary">
            {!editable
              ? 'Read-only while the master is unreachable'
              : lines.length === 0
                ? 'Nothing changed yet'
                : `${lines.length} ${lines.length === 1 ? 'change' : 'changes'} to save`}
          </span>
        </div>
      </form>
      <AddEmailSheet
        open={adding}
        draft={draft}
        admin={false}
        onClose={() => setAdding(false)}
        onAdd={setDraft}
      />
      <Alert
        open={confirming}
        title={`Save changes to ${account.name}?`}
        message={<ChangeLines lines={lines} />}
        confirm="Save"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </>
  )
}

/** Appearance: Dark, Light or Match system, saved in this browser. */
function AppearanceCard(): JSX.Element {
  const [appearance, setAppearance] = useAppearance()
  return (
    <section className="m-card" aria-labelledby="account-look">
      <CardHeader id="account-look" icon="tune" title="Appearance" />
      <div className="m-card__body m-stack">
        <div className="m-seg" role="group" aria-label="Appearance">
          {APPEARANCES.map((value) => (
            <button
              key={value}
              type="button"
              className="m-seg__opt"
              aria-pressed={appearance === value}
              onClick={() => setAppearance(value)}
            >
              {APPEARANCE_LABELS[value]}
            </button>
          ))}
        </div>
        <p className="m-field__help">
          Dark is Mason’s default. Saved in this browser.
        </p>
      </div>
    </section>
  )
}

/** Sign-in: the password (where it changes here) and Sign out. */
function SignInCard({ read }: { read: Resource<AccountInfo> }): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const profile = useProfile()
  const here = useHref('/account')
  const [setting, setSetting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const account = read.data
  const signOut = (): void => {
    setLeaving(true)
    void client
      .signOut()
      .catch(() => undefined)
      .then(() => client.leave(profile.signedOut))
  }
  return (
    <section className="m-card" aria-labelledby="account-signin">
      <CardHeader id="account-signin" icon="lock" title="Sign-in" />
      <div className="m-card__body m-stack">
        {account == null ? (
          read.error == null && (
            <SkeletonText lines={1} label="Loading your sign-in" />
          )
        ) : (
          <>
            <span className="m-t-callout">
              {account.password
                ? 'Password set. Changing it ends your other sessions.'
                : 'No password set.'}
            </span>
            {!account.passwordHere && (
              <p className="m-field__help">
                Change your password on the master.
              </p>
            )}
          </>
        )}
        <div className="m-row">
          {account?.passwordHere === true && (
            <Button
              variant="secondary"
              icon="key"
              aria-haspopup="dialog"
              disabled={!account.editable}
              title={account.editable ? undefined : READ_ONLY}
              onClick={() => setSetting(true)}
            >
              {account.password ? 'Change password' : 'Set password'}
            </Button>
          )}
          <Button
            variant="secondary"
            icon="logout"
            busy={leaving}
            onClick={signOut}
          >
            Sign out
          </Button>
        </div>
      </div>
      {account != null && (
        <PasswordSheet
          open={setting}
          title="Your password"
          intro="You sign in with it and your username or a confirmed email, on the host and the master. Your other sessions end, and you sign in again."
          path={personPath(account.id)}
          onClose={() => setSetting(false)}
          onSet={() => {
            setSetting(false)
            toast({ text: 'Your password is set', icon: 'key' })
            // Sessions end with a new password: a full load signs in again.
            client.leave(here)
          }}
        />
      )}
    </section>
  )
}

/** `/account`, on both nodes, for everyone signed in. */
export function AccountPage(): JSX.Element {
  const read = useResource(ACCOUNT_PATH, asAccountInfo)
  const account = read.data
  return (
    <Page
      crumbs={[{ label: 'Your account' }]}
      title="Your account"
      description="Your name and email addresses, how you sign in, and how Mason looks."
    >
      {account?.editable === false && (
        <Banner tone="warning" title="Your account is read-only here" announce>
          {READ_ONLY}
        </Banner>
      )}
      <div className="m-grid-2 m-account">
        {read.error != null && account == null ? (
          <Failed
            what="Your account"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <section className="m-card" aria-labelledby="account-profile">
            <CardHeader id="account-profile" icon="person" title="Profile" />
            <div className="m-card__body">
              {account == null ? (
                <SkeletonText lines={5} label="Loading your account" />
              ) : (
                <ProfileForm
                  key={JSON.stringify(account)}
                  account={account}
                  changed={read.reload}
                />
              )}
            </div>
          </section>
        )}
        <div className="m-stack">
          <AppearanceCard />
          <SignInCard read={read} />
        </div>
      </div>
    </Page>
  )
}
