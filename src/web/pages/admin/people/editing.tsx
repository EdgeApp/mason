// The editing pieces People and Your account share (screen-12-people,
// screen-12b-people-overlays, screen-13-account): a person's email lines with
// × and Confirm, the Add an email address sheet, the Set password sheet that
// hashes in the worker, and the change lines a confirm lists.
import { asUnknown } from 'cleaners'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react'
import { checkNewPassword } from '../../../../auth/passwordProtocol.js'
import type { PersonChange } from '../../../../shared/api/people.js'
import { useApi } from '../../../api/context.js'
import { Button } from '../../../ui/Button.js'
import { cx } from '../../../ui/cx.js'
import { FormError, PasswordInput, TextInput } from '../../../ui/Field.js'
import { Sheet } from '../../../ui/Sheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useHasher } from '../../../workers/hasher.js'
import { PASSWORD_RULE } from '../../auth/Invite.js'
import {
  confirmingEmail,
  emailProblem,
  withEmail,
  withoutEmail,
  type Draft,
  type EditMode,
} from './personDraft.js'

/** Under a new password: the rule, and that it never leaves the browser. */
export const PASSWORD_HINT = `${PASSWORD_RULE} The browser hashes it; Mason never sees it.`

/** Under Your account's addresses (and a person's own row). */
export const SELF_EMAIL_HINT =
  'An address you add signs you in once an administrator confirms it.'

/** A confirm's lines: what Save changes, or what Remove does. */
export function ChangeLines({ lines }: { lines: string[] }): JSX.Element {
  return (
    <span className="m-people__changes">
      {lines.map((line) => (
        <span key={line} className="m-people__change">
          {line}
        </span>
      ))}
    </span>
  )
}

/**
 * A person's addresses while they are edited: each with its Unconfirmed tag,
 * Confirm for an administrator, and × (a removed one is struck through until
 * Save, with Undo; an added one says so). `none` draws them read-only.
 */
export function EmailLines({
  draft,
  mode,
  onChange,
}: {
  draft: Draft
  mode: EditMode
  onChange: (draft: Draft) => void
}): JSX.Element {
  if (draft.emails.length === 0)
    return <p className="m-t-callout m-tertiary">No email addresses.</p>
  return (
    <ul className="m-list m-people__emails">
      {draft.emails.map((entry) => {
        const removed = entry.removed === true
        const added = entry.added === true
        return (
          <li
            key={entry.email}
            className={cx(
              'm-people__email',
              removed && 'm-people__email--removed',
              added && 'm-people__email--added',
            )}
            data-email={entry.email}
          >
            <span className="m-t-callout m-people__address">{entry.email}</span>
            {removed && (
              <span className="m-t-subhead m-tertiary">removed on Save</span>
            )}
            {added && (
              <span className="m-t-subhead m-tertiary">added on Save</span>
            )}
            {!removed &&
              !entry.confirmed &&
              (entry.confirm === true ? (
                <StatusPill status="ok" label="Confirmed on Save" />
              ) : (
                <StatusPill status="unconfirmed" />
              ))}
            {mode === 'all' && !removed && !added && !entry.confirmed && (
              <Button
                variant="plain"
                size="sm"
                aria-pressed={entry.confirm === true}
                aria-label={`Confirm ${entry.email}`}
                onClick={() => onChange(confirmingEmail(draft, entry.email))}
              >
                Confirm
              </Button>
            )}
            {mode !== 'none' &&
              (removed ? (
                <Button
                  variant="plain"
                  size="sm"
                  aria-label={`Keep ${entry.email}`}
                  onClick={() => onChange(withoutEmail(draft, entry.email))}
                >
                  Undo
                </Button>
              ) : (
                <Button
                  variant="plain"
                  size="sm"
                  iconOnly
                  icon="close"
                  label={`Remove ${entry.email}`}
                  onClick={() => onChange(withoutEmail(draft, entry.email))}
                />
              ))}
          </li>
        )
      })}
    </ul>
  )
}

/** Add an email address: one field, refused when it is not one or is already theirs. */
export function AddEmailSheet({
  open,
  draft,
  admin,
  onClose,
  onAdd,
}: {
  open: boolean
  draft: Draft
  /** An administrator's address is confirmed at once; the person's own waits. */
  admin: boolean
  onClose: () => void
  onAdd: (draft: Draft) => void
}): JSX.Element {
  const formId = useId()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | undefined>()
  const close = (): void => {
    setEmail('')
    setError(undefined)
    onClose()
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = emailProblem(email, draft)
    setError(problem)
    if (problem != null) return
    onAdd(withEmail(draft, email, admin))
    close()
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={email !== ''}
      title="Add an email address"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} icon="add">
            Add
          </Button>
        </>
      )}
    >
      <form id={formId} name="add-email" noValidate onSubmit={submit}>
        <TextInput
          label="Email address"
          name="email"
          type="email"
          value={email}
          onChange={setEmail}
          error={error}
          help={admin ? undefined : SELF_EMAIL_HINT}
          autoComplete="email"
          maxLength={320}
          verbatim
          required
        />
      </form>
    </Sheet>
  )
}

/** Why a new password and its confirmation cannot be used, by field. */
export function passwordProblems(
  password: string,
  confirm: string,
): { password?: string; confirm?: string } {
  const found: { password?: string; confirm?: string } = {}
  try {
    checkNewPassword(password)
  } catch (error) {
    found.password = (error as Error).message
  }
  if (confirm !== password) found.confirm = 'The passwords do not match.'
  return found
}

/**
 * Set or change a password: typed twice, hashed in the worker (a few
 * seconds), and only the client hash sent with `PUT path`.
 */
export function PasswordSheet({
  open,
  title,
  intro,
  path,
  onClose,
  onSet,
}: {
  open: boolean
  title: string
  intro: ReactNode
  /** The person's `PUT` path. */
  path: string
  onClose: () => void
  /** The password is set. */
  onSet: () => void
}): JSX.Element {
  const client = useApi()
  const hasher = useHasher()
  const formId = useId()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>(
    {},
  )
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<string | undefined>()
  const failed = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failed.current?.focus()
  }, [failure])
  const reset = (): void => {
    setPassword('')
    setConfirm('')
    setErrors({})
    setFailure(undefined)
    setProgress('')
  }
  const close = (): void => {
    reset()
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const found = passwordProblems(password, confirm)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    setFailure(undefined)
    try {
      setProgress('Preparing the password: this takes a few seconds.')
      const made = await hasher.create(password)
      setProgress('Setting the password…')
      const body: PersonChange = {
        password: {
          clientHash: made.clientHash,
          clientParameters: made.clientParameters,
        },
      }
      await client.put(path, asUnknown, { body })
      reset()
      onSet()
    } catch (reason) {
      setProgress('')
      setFailure((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={password !== '' || confirm !== ''}
      title={title}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="key"
            busy={busy}
          >
            Set password
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="password"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <p className="m-t-callout m-secondary">{intro}</p>
        <PasswordInput
          label="Password"
          name="password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          autoComplete="new-password"
          required
        />
        <PasswordInput
          label="Confirm the password"
          name="confirm"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
          help={PASSWORD_HINT}
          autoComplete="new-password"
          required
        />
        {progress !== '' && (
          <p className="m-t-subhead m-secondary" role="status">
            {progress}
          </p>
        )}
        {failure != null && <FormError ref={failed}>{failure}</FormError>}
      </form>
    </Sheet>
  )
}
