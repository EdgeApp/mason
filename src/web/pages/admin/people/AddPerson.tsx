// Add a person (screen-12b-people-overlays), administrators only: a large
// sheet with their name, role, addresses, an optional username, an optional
// password (hashed in the worker) and an invitation link to make at once,
// shown in a copy field. The draft is kept in session storage, never the
// password.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react'
import {
  asAddedPerson,
  PEOPLE_PATH,
  type PersonAdd,
} from '../../../../shared/api/people.js'
import type { Role } from '../../../../shared/permissions.js'
import { useApi } from '../../../api/context.js'
import { Button } from '../../../ui/Button.js'
import {
  CheckboxInput,
  FormError,
  PasswordInput,
  SelectInput,
  TextInput,
} from '../../../ui/Field.js'
import {
  FormDisclosure,
  FormSection,
  LargeSheet,
  useDraft,
} from '../../../ui/LargeSheet.js'
import { useToast } from '../../../ui/Toast.js'
import { useHasher } from '../../../workers/hasher.js'
import { PASSWORD_HINT, passwordProblems } from './editing.js'
import { LinkBox } from './InviteSheet.js'
import {
  isEmail,
  NAME_MAX,
  nameProblem,
  normalEmail,
  ROLE_OPTIONS,
  USERNAME_RULE,
  usernameProblem,
} from './personDraft.js'

/** The sheet's fields. */
export interface AddDraft {
  name: string
  role: Role
  emails: string[]
  username: string
  password: string
  confirm: string
  invite: boolean
}

const EMPTY: AddDraft = {
  name: '',
  role: 'tester',
  emails: [''],
  username: '',
  password: '',
  confirm: '',
  invite: false,
}

/** Where the draft is kept while the sheet is open. */
export const ADD_DRAFT = 'people-add'

/** Without an address or a username nobody can sign in. */
export const NEEDS_SIGN_IN = 'Give them an email address, a username, or both'

interface Problems {
  name?: string
  emails?: Record<number, string>
  username?: string
  password?: string
  confirm?: string
  summary?: string
}

/** What is wrong with the fields, by field; empty when they can be sent. */
export function addProblems(value: AddDraft): Problems {
  const found: Problems = {}
  const name = nameProblem(value.name)
  if (name != null) found.name = name
  const emails: Record<number, string> = {}
  const seen = new Set<string>()
  value.emails.forEach((email, n) => {
    if (email.trim() === '') return
    if (!isEmail(email)) emails[n] = 'Enter an email address'
    else if (seen.has(normalEmail(email)))
      emails[n] = 'They already have that address'
    seen.add(normalEmail(email))
  })
  if (Object.keys(emails).length > 0) found.emails = emails
  const username = usernameProblem(value.username)
  if (username != null) found.username = username
  if (value.username.trim() === '' && seen.size === 0)
    found.summary = NEEDS_SIGN_IN
  if (value.password !== '' || value.confirm !== '')
    Object.assign(found, passwordProblems(value.password, value.confirm))
  return found
}

/** The large sheet; `onAdded` reads the list again. */
export function AddPersonSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: () => void
}): JSX.Element {
  const client = useApi()
  const hasher = useHasher()
  const toast = useToast()
  const formId = useId()
  const draft = useDraft<AddDraft>(open ? ADD_DRAFT : null, EMPTY, [
    'password',
    'confirm',
  ])
  const value = draft.value
  const [problems, setProblems] = useState<Problems>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<string | undefined>()
  const [link, setLink] = useState<string | undefined>()
  const summary = useRef<HTMLDivElement>(null)
  const failed = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failed.current?.focus()
  }, [failure])
  const set = <K extends keyof AddDraft>(key: K, next: AddDraft[K]): void =>
    draft.set((was) => ({ ...was, [key]: next }))
  const close = (): void => {
    setProblems({})
    setFailure(undefined)
    setProgress('')
    setLink(undefined)
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const found = addProblems(value)
    setProblems(found)
    if (Object.keys(found).length > 0) {
      if (found.summary != null) setTimeout(() => summary.current?.focus(), 0)
      return
    }
    setBusy(true)
    setFailure(undefined)
    try {
      let password: PersonAdd['password']
      if (value.password !== '') {
        setProgress('Preparing the password: this takes a few seconds.')
        password = await hasher.create(value.password)
      }
      setProgress('Adding…')
      const username = value.username.trim()
      const body: PersonAdd = {
        name: value.name.trim(),
        role: value.role,
        emails: [
          ...new Set(
            value.emails
              .filter((email) => email.trim() !== '')
              .map(normalEmail),
          ),
        ],
        invite: value.invite,
        ...(username === '' ? {} : { username }),
        ...(password == null ? {} : { password }),
      }
      const added = await client.post(PEOPLE_PATH, asAddedPerson, { body })
      toast({ text: `${added.name} added`, icon: 'person' })
      draft.clear()
      setProgress('')
      onAdded()
      if (added.invitation?.url != null) setLink(added.invitation.url)
      else close()
    } catch (reason) {
      setProgress('')
      setFailure((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <LargeSheet
      open={open}
      onClose={() => {
        draft.clear()
        close()
      }}
      dirty={link == null && draft.dirty}
      title="Add a person"
      footer={(requestClose) =>
        link != null ? (
          <Button variant="primary" onClick={requestClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              icon="add"
              busy={busy}
            >
              Add
            </Button>
          </>
        )
      }
    >
      {link != null ? (
        <LinkBox url={link} />
      ) : (
        <form
          id={formId}
          name="person-add"
          className="m-stack"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          {problems.summary != null && (
            <div
              className="m-errsummary"
              role="alert"
              tabIndex={-1}
              ref={summary}
            >
              <strong className="m-t-headline">{problems.summary}</strong>
            </div>
          )}
          <FormSection legend="Who">
            <TextInput
              label="Full name"
              name="name"
              value={value.name}
              onChange={(next) => set('name', next)}
              error={problems.name}
              maxLength={NAME_MAX}
              autoComplete="off"
              required
            />
            <SelectInput
              label="Role"
              name="role"
              value={value.role}
              options={ROLE_OPTIONS}
              onChange={(next) => set('role', next as Role)}
              help="What their role lets them do; Tester installs builds only."
            />
          </FormSection>
          <FormSection legend="How they sign in" grid={false}>
            <div className="m-stack">
              {value.emails.map((email, n) => (
                <TextInput
                  key={n}
                  label={n === 0 ? 'Email addresses' : 'Another email address'}
                  name={`email-${n}`}
                  type="email"
                  value={email}
                  onChange={(next) =>
                    set(
                      'emails',
                      value.emails.map((was, k) => (k === n ? next : was)),
                    )
                  }
                  error={problems.emails?.[n]}
                  maxLength={320}
                  autoComplete="off"
                  optional={n === 0}
                  verbatim
                />
              ))}
              <Button
                variant="tinted"
                size="sm"
                icon="add"
                className="m-people__addemail"
                onClick={() => set('emails', [...value.emails, ''])}
              >
                Another address
              </Button>
              <p className="m-t-callout m-secondary">
                They sign in with any enabled sign-in method that confirms one
                of these addresses, or with an address or their username and a
                password you set here or they choose from an invitation link.
                Give them an email, a username, or both.
              </p>
              <TextInput
                label="Username"
                name="username"
                value={value.username}
                onChange={(next) => set('username', next)}
                error={problems.username}
                help={`${USERNAME_RULE}.`}
                maxLength={64}
                autoComplete="off"
                optional
                mono
                verbatim
              />
            </div>
          </FormSection>
          <FormDisclosure
            summary="Set a password now"
            note="(optional)"
            open={
              value.password !== '' ||
              problems.password != null ||
              problems.confirm != null
            }
          >
            <PasswordInput
              label="Password"
              name="password"
              value={value.password}
              onChange={(next) => set('password', next)}
              error={problems.password}
              autoComplete="new-password"
            />
            <PasswordInput
              label="Confirm the password"
              name="confirm"
              value={value.confirm}
              onChange={(next) => set('confirm', next)}
              error={problems.confirm}
              help={PASSWORD_HINT}
              autoComplete="new-password"
            />
          </FormDisclosure>
          <CheckboxInput
            label="Make an invitation link"
            name="invite"
            checked={value.invite}
            onChange={(next) => set('invite', next)}
            help="A link, valid for a week, where they choose a password. Mason sends no email: copy it to them."
          />
          {progress !== '' && (
            <p className="m-t-subhead m-secondary" role="status">
              {progress}
            </p>
          )}
          {failure != null && <FormError ref={failed}>{failure}</FormError>}
        </form>
      )}
    </LargeSheet>
  )
}
