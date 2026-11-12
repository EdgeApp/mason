// The master's first run (`/` before its first account): create the first
// administrator with the six-digit setup code the master printed, or
// restore the master from its encrypted git backup (`/?restore`). A new
// password's Argon2id costs are calibrated in the worker, which takes a few
// seconds; only its hash goes to the master.
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type RefObject,
} from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  asRestoreReply,
  asSetupReply,
  SETUP_PATH,
  SETUP_RESTORE_PATH,
  type RestoreRequest,
  type SetupRequest,
} from '../../../shared/api/index.js'
import { useApi } from '../../api/context.js'
import { Button } from '../../ui/Button.js'
import {
  DateInput,
  FileInput,
  FormError,
  PasswordInput,
  TextInput,
} from '../../ui/Field.js'
import { PAGE_TITLE_ID } from '../../ui/PageHeader.js'
import { useHasher } from '../../workers/hasher.js'
import { focusFirstInvalid, refusal, SignedOut } from './SignedOut.js'

/** Why a setup code cannot be right, before the master is asked. */
export function codeProblem(code: string): string | undefined {
  return /^[0-9]{6}$/.test(code)
    ? undefined
    : 'Enter the six digits this master printed'
}

/** The first account's password: at least 12 characters. */
export const SETUP_PASSWORD_MIN = 12

type Errors = Partial<Record<string, string>>

/** A form's busy state, its refusal (focused when it appears) and its field errors. */
function useSubmission(): {
  busy: boolean
  setBusy: (busy: boolean) => void
  failure: string | undefined
  setFailure: (failure: string | undefined) => void
  errors: Errors
  setErrors: (errors: Errors) => void
  failureRef: RefObject<HTMLParagraphElement | null>
} {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const [errors, setErrors] = useState<Errors>({})
  const failureRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failureRef.current?.focus()
  }, [failure])
  return {
    busy,
    setBusy,
    failure,
    setFailure,
    errors,
    setErrors,
    failureRef,
  }
}

/** Drops the fields that are fine, so an empty object means a valid form. */
const only = (errors: Errors): Errors =>
  Object.fromEntries(
    Object.entries(errors).filter(([, value]) => value != null),
  )

function CreateAccount({ onRestore }: { onRestore: () => void }): JSX.Element {
  const client = useApi()
  const hasher = useHasher()
  const form = useSubmission()
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [progress, setProgress] = useState('')
  const check = (): Errors =>
    only({
      code: codeProblem(code),
      username: username.trim() === '' ? 'Choose a username' : undefined,
      password:
        Array.from(password).length < SETUP_PASSWORD_MIN
          ? `Use at least ${SETUP_PASSWORD_MIN} characters`
          : undefined,
    })
  /** Validates one field when it loses focus, once something is typed. */
  const blur = (field: string, value: string): void => {
    if (value === '') return
    form.setErrors({ ...form.errors, [field]: check()[field] })
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (form.busy) return
    const errors = check()
    form.setErrors(errors)
    if (
      focusFirstInvalid(errors, [
        ['code', 'setup-code'],
        ['username', 'setup-username'],
        ['password', 'setup-password'],
      ])
    )
      return
    form.setBusy(true)
    form.setFailure(undefined)
    try {
      setProgress('Preparing your password: this takes a few seconds.')
      const { clientHash, clientParameters } = await hasher.create(password)
      setProgress('Creating the account…')
      const body: SetupRequest = {
        code,
        username: username.trim(),
        clientHash,
        clientParameters,
      }
      await client.post(SETUP_PATH, asSetupReply, {
        body,
        csrf: false,
        redirect: false,
      })
      // The new administrator is signed in; Backups asks them to keep the key safe.
      client.leave('/backups')
    } catch (caught) {
      setProgress('')
      form.setBusy(false)
      form.setFailure(refusal(caught))
    }
  }
  return (
    <section className="m-card" aria-labelledby="setup-create">
      <div className="m-card__body m-stack">
        <h2 className="m-t-title3" id="setup-create">
          Create the first account
        </h2>
        <p className="m-signin__intro m-t-callout m-secondary">
          Enter the six-digit setup code this master printed in its terminal
          when it started. The first account is an administrator.
        </p>
        <form
          name="setup"
          className="m-stack"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <TextInput
            id="setup-code"
            name="code"
            label="Setup code"
            value={code}
            onChange={(value) => setCode(value.replace(/\s/g, ''))}
            onBlur={() => blur('code', code)}
            code
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            verbatim
            error={form.errors.code}
          />
          <TextInput
            id="setup-username"
            name="username"
            label="Username"
            value={username}
            onChange={setUsername}
            onBlur={() => blur('username', username)}
            autoComplete="username"
            required
            verbatim
            error={form.errors.username}
          />
          <PasswordInput
            id="setup-password"
            name="password"
            label="Password"
            value={password}
            onChange={setPassword}
            onBlur={() => blur('password', password)}
            autoComplete="new-password"
            required
            help={`At least ${SETUP_PASSWORD_MIN} characters.`}
            error={form.errors.password}
          />
          {form.failure != null && (
            <FormError ref={form.failureRef}>{form.failure}</FormError>
          )}
          <div className="m-form__actions">
            <Button type="submit" variant="primary" busy={form.busy}>
              Create account
            </Button>
            <Button type="button" variant="plain" onClick={onRestore}>
              Restore from a backup instead
            </Button>
          </div>
          <p className="m-formstatus m-t-subhead m-secondary" role="status">
            {progress}
          </p>
        </form>
      </div>
    </section>
  )
}

function Restore({ onCreate }: { onCreate: () => void }): JSX.Element {
  const client = useApi()
  const form = useSubmission()
  const [code, setCode] = useState('')
  const [repository, setRepository] = useState('')
  const [key, setKey] = useState<File | undefined>()
  const [date, setDate] = useState('')
  const [progress, setProgress] = useState('')
  const check = (): Errors =>
    only({
      code: codeProblem(code),
      repository:
        repository.trim() === ''
          ? 'Enter the backup’s git repository'
          : undefined,
      key: key == null ? 'Choose the backup key file' : undefined,
    })
  const blur = (field: string, value: string): void => {
    if (value === '') return
    form.setErrors({ ...form.errors, [field]: check()[field] })
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (form.busy) return
    const errors = check()
    form.setErrors(errors)
    if (
      focusFirstInvalid(errors, [
        ['code', 'restore-code'],
        ['repository', 'restore-repository'],
        ['key', 'restore-key'],
      ])
    )
      return
    form.setBusy(true)
    form.setFailure(undefined)
    setProgress('Restoring: the master starts again with the backup’s data.')
    try {
      const body: RestoreRequest = {
        code,
        repository: repository.trim(),
        key: (await key!.text()).trim(),
        ...(date === '' ? {} : { date }),
      }
      await client.post(SETUP_RESTORE_PATH, asRestoreReply, {
        body,
        csrf: false,
        redirect: false,
      })
      // Its people come back with it: they sign in as before.
      client.leave('/sign-in')
    } catch (caught) {
      setProgress('')
      form.setBusy(false)
      form.setFailure(refusal(caught))
    }
  }
  return (
    <section className="m-card" aria-labelledby="setup-restore">
      <div className="m-card__body m-stack">
        <h2 className="m-t-title3" id="setup-restore">
          Restore from a backup
        </h2>
        <p className="m-signin__intro m-t-callout m-secondary">
          Rebuild this master from its encrypted git backup instead. It comes
          back as the same master, so its nodes reconnect: stop the master the
          backup came from first.
        </p>
        <form
          name="restore"
          className="m-stack"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <TextInput
            id="restore-code"
            name="code"
            label="Setup code"
            value={code}
            onChange={(value) => setCode(value.replace(/\s/g, ''))}
            onBlur={() => blur('code', code)}
            code
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            verbatim
            error={form.errors.code}
          />
          <TextInput
            id="restore-repository"
            name="repository"
            label="Backup repository"
            value={repository}
            onChange={setRepository}
            onBlur={() => blur('repository', repository)}
            placeholder="git@github.com:owner/mason-backup.git"
            mono
            required
            verbatim
            error={form.errors.repository}
          />
          <FileInput
            id="restore-key"
            name="key"
            label="Backup key file"
            choose="Choose the key file"
            file={key}
            onChange={(file) => {
              setKey(file)
              form.setErrors({ ...form.errors, key: undefined })
            }}
            help="The key the master showed on its Backups page."
            error={form.errors.key}
          />
          <DateInput
            id="restore-date"
            name="date"
            label="Date"
            optional
            value={date}
            onChange={setDate}
            help="The daily backup from that day; without one, the latest backup."
          />
          {form.failure != null && (
            <FormError ref={form.failureRef}>{form.failure}</FormError>
          )}
          <div className="m-form__actions">
            <Button type="submit" variant="primary" busy={form.busy}>
              Restore
            </Button>
            <Button type="button" variant="plain" onClick={onCreate}>
              Create the first account instead
            </Button>
          </div>
          <p className="m-formstatus m-t-subhead m-secondary" role="status">
            {progress}
          </p>
        </form>
      </div>
    </section>
  )
}

/** The master's first run: create the first account, or restore (`?restore`). */
export function SetupPage(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const restoring = new URLSearchParams(location.search).has('restore')
  const go = (search: string): void => {
    void navigate({ pathname: location.pathname, search })
  }
  // Switching between creating and restoring swaps the card: focus moves to
  // the new heading, which announces it.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    document.getElementById(PAGE_TITLE_ID)?.focus()
  }, [restoring])
  return (
    <SignedOut
      title={restoring ? 'Restore this master' : 'Set up this master'}
      description={
        restoring
          ? 'From the encrypted backup of the master it replaces.'
          : 'This master has no account yet.'
      }
      mark
    >
      {restoring ? (
        <Restore onCreate={() => go('')} />
      ) : (
        <CreateAccount onRestore={() => go('?restore')} />
      )}
    </SignedOut>
  )
}
