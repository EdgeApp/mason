// People, on the master (screen-12-people, screen-12b-people-overlays): who
// signs in, with which email addresses, and what their role lets them do.
// Managers read the table; administrators edit a row in place (the edit
// block: name, username, role and addresses, saved through a confirm that
// lists each change), invite, set passwords, remove (tier 2) and add people
// in a large sheet. Anyone may edit their own name and addresses.
import { asUnknown } from 'cleaners'
import { useEffect, useId, useRef, useState, type JSX } from 'react'
import {
  asPeople,
  personPath,
  PEOPLE_PATH,
  type Person,
} from '../../../../shared/api/people.js'
import { absoluteTime } from '../../../../shared/format.js'
import type { Role } from '../../../../shared/permissions.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Alert } from '../../../ui/Alert.js'
import { Avatar } from '../../../ui/Avatar.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { FilterPills } from '../../../ui/FilterPills.js'
import { FormError, SelectInput, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import { Failed, Loading } from '../../projects/project.js'
import { AddPersonSheet } from './AddPerson.js'
import {
  AddEmailSheet,
  ChangeLines,
  EmailLines,
  PasswordSheet,
  SELF_EMAIL_HINT,
} from './editing.js'
import { InviteSheet } from './InviteSheet.js'
import {
  changesOf,
  draftOf,
  NAME_MAX,
  nameProblem,
  removalLines,
  ROLE_OPTIONS,
  ROLE_WORDS,
  USERNAME_RULE,
  usernameProblem,
  type Draft,
  type EditMode,
  type PersonState,
} from './personDraft.js'

/** The role filter's pills, in order: everyone, then highest first. */
const FILTERS: Array<{ key: 'all' | Role; label: string }> = [
  { key: 'all', label: 'Everyone' },
  { key: 'admin', label: 'Admins' },
  { key: 'manager', label: 'Managers' },
  { key: 'developer', label: 'Developers' },
  { key: 'tester', label: 'Testers' },
]

/** Why other rows wait while one is edited. */
const EDITING_ELSEWHERE = 'Save or cancel the row you are editing first'

/** A person as their row's edit block starts from. */
export const stateOf = (person: Person): PersonState => ({
  name: person.name,
  username: person.username ?? '',
  role: person.role,
  emails: person.emails,
})

/** Whether a person matches the search: their name, username or an address. */
export function matches(person: Person, search: string): boolean {
  const term = search.trim().toLowerCase()
  if (term === '') return true
  return [
    person.name,
    person.username ?? '',
    ...person.emails.map((e) => e.email),
  ]
    .map((value) => value.toLowerCase())
    .some((value) => value.includes(term))
}

/** A row being edited: its draft, its field errors and the refusal. */
interface Editing {
  person: Person
  mode: EditMode
  draft: Draft
  errors: { name?: string; username?: string }
  failure?: string | undefined
}

/** The edit block a row becomes: its fields, its addresses, Cancel and Save. */
function EditBlock({
  editing,
  busy,
  onChange,
  onAddEmail,
  onCancel,
  onSave,
}: {
  editing: Editing
  busy: boolean
  onChange: (draft: Draft) => void
  onAddEmail: () => void
  onCancel: () => void
  onSave: () => void
}): JSX.Element {
  const { person, mode, draft, errors, failure } = editing
  const labelId = useId()
  const failed = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failed.current?.focus()
  }, [failure])
  const changed = changesOf(stateOf(person), draft).lines.length > 0
  return (
    <tr aria-selected="true" className="m-people__editrow">
      <td colSpan={7} data-wide className="m-people__editcell">
        <form
          name="person-edit"
          className="m-editblock"
          aria-label={`Editing ${person.name}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
        >
          <div className="m-editblock__fields">
            <TextInput
              label="Full name"
              name="name"
              value={draft.name}
              onChange={(name) => onChange({ ...draft, name })}
              error={errors.name}
              maxLength={NAME_MAX}
              autoComplete="off"
              autoFocus
              required
            />
            {mode === 'all' && (
              <>
                <TextInput
                  label="Username"
                  name="username"
                  value={draft.username}
                  onChange={(username) => onChange({ ...draft, username })}
                  error={errors.username}
                  help={`${USERNAME_RULE}. Empty for none.`}
                  maxLength={64}
                  autoComplete="off"
                  optional
                  mono
                  verbatim
                />
                <SelectInput
                  label="Role"
                  name="role"
                  value={draft.role}
                  options={ROLE_OPTIONS}
                  onChange={(role) =>
                    onChange({ ...draft, role: role as Role })
                  }
                />
              </>
            )}
          </div>
          <div className="m-field" role="group" aria-labelledby={labelId}>
            <span className="m-field__label" id={labelId}>
              Email addresses
            </span>
            <EmailLines draft={draft} mode={mode} onChange={onChange} />
            <Button
              variant="tinted"
              size="sm"
              icon="add"
              aria-haspopup="dialog"
              aria-label="Add an email address"
              className="m-people__addemail"
              onClick={onAddEmail}
            >
              Add an address
            </Button>
            {mode === 'self' && (
              <p className="m-field__help">{SELF_EMAIL_HINT}</p>
            )}
          </div>
          {failure != null && <FormError ref={failed}>{failure}</FormError>}
          <div className="m-editblock__foot">
            {!changed && (
              <span className="m-t-subhead m-tertiary m-people__nochange">
                Nothing changed yet
              </span>
            )}
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              busy={busy}
              disabled={!changed}
            >
              Save changes
            </Button>
          </div>
        </form>
      </td>
    </tr>
  )
}

/** A person's row: who, their addresses, role, invitation, password and actions. */
function PersonRow({
  person,
  mode,
  admin,
  waiting,
  now,
  onEdit,
  onInvite,
  onPassword,
  onRemove,
}: {
  person: Person
  mode: EditMode
  admin: boolean
  /** Another row is being edited. */
  waiting: boolean
  now: number
  onEdit: () => void
  onInvite: () => void
  onPassword: () => void
  onRemove: () => void
}): JSX.Element {
  /** Invite and passwords are for people who may still sign in. */
  const live = admin && !person.disabled
  const off = waiting ? EDITING_ELSEWHERE : undefined
  return (
    <tr data-person={person.id}>
      <td data-primary data-label="Name">
        <span className="m-row m-people__who">
          <Avatar name={person.name} />
          <span className="m-t-headline">{person.name}</span>
          {person.disabled && <StatusPill status="disabled" quiet />}
        </span>
      </td>
      <td data-label="Username" className="m-t-mono-sm">
        {person.username ?? <span className="m-tertiary">—</span>}
      </td>
      <td data-label="Email addresses" data-wide>
        {person.emails.length === 0 ? (
          <span className="m-tertiary">—</span>
        ) : (
          <ul className="m-list m-people__emails">
            {person.emails.map((entry) => (
              <li key={entry.email} className="m-people__email">
                <span className="m-t-callout m-truncate">{entry.email}</span>
                {!entry.confirmed && <StatusPill status="unconfirmed" />}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td data-label="Role">{ROLE_WORDS[person.role]}</td>
      <td data-label="Invitation">
        <span className="m-stack m-people__invite">
          {person.invitation == null ? (
            !live && <span className="m-tertiary">—</span>
          ) : (
            <StatusPill status="invited" quiet />
          )}
          {live && (
            <Button
              variant="tinted"
              size="sm"
              icon="link"
              aria-haspopup="dialog"
              aria-label={
                person.invitation == null
                  ? `Invite ${person.name}`
                  : `Invite ${person.name} again`
              }
              disabled={waiting}
              title={off}
              onClick={onInvite}
            >
              {person.invitation == null ? 'Invite' : 'Invite again'}
            </Button>
          )}
          {person.invitation != null && (
            <span className="m-t-subhead m-secondary">
              Expires {absoluteTime(person.invitation.expiresAt, now)}
            </span>
          )}
        </span>
      </td>
      <td data-label="Password">
        <span className="m-stack m-people__invite">
          <span className="m-t-subhead m-secondary">
            {person.password ? 'Password set' : 'No password'}
          </span>
          {live && (
            <Button
              variant="tinted"
              size="sm"
              icon="key"
              aria-haspopup="dialog"
              aria-label={`${person.password ? 'Change' : 'Set'} ${person.name}’s password`}
              disabled={waiting}
              title={off}
              onClick={onPassword}
            >
              {person.password ? 'Change password' : 'Set password'}
            </Button>
          )}
        </span>
      </td>
      <td data-actions>
        {mode !== 'none' && (
          <div className="m-table__actions">
            <Button
              variant="plain"
              size="sm"
              icon="edit"
              aria-label={`Edit ${person.name}`}
              disabled={waiting}
              title={off}
              onClick={onEdit}
            >
              Edit
            </Button>
            {admin && (
              <Button
                variant="danger"
                size="sm"
                icon="delete"
                aria-haspopup="dialog"
                aria-label={`Remove ${person.name}`}
                disabled={waiting}
                title={off}
                onClick={onRemove}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

/** The table with its filter, search, edit block, sheets and confirms. */
function PeopleTable({
  people,
  viewerId,
  admin,
  changed,
}: {
  people: Person[]
  viewerId: number
  /** `people.change`: edits anyone, invites, sets passwords, removes. */
  admin: boolean
  changed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [filter, setFilter] = useState<'all' | Role>('all')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Editing | undefined>()
  const [addingEmail, setAddingEmail] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<Person | undefined>()
  const [removingBusy, setRemovingBusy] = useState(false)
  const [inviting, setInviting] = useState<Person | undefined>()
  const [password, setPassword] = useState<Person | undefined>()
  const [errors, setErrors] = useState<Record<number, string>>({})
  const now = Date.now()

  const modeOf = (person: Person): EditMode =>
    admin ? 'all' : person.id === viewerId ? 'self' : 'none'
  const options = FILTERS.map((option) => ({
    ...option,
    count:
      option.key === 'all'
        ? people.length
        : people.filter((person) => person.role === option.key).length,
  }))
  const shown = people.filter(
    (person) =>
      (filter === 'all' || person.role === filter) && matches(person, search),
  )
  const clearError = (id: number): void =>
    setErrors((was) =>
      Object.fromEntries(
        Object.entries(was).filter(([key]) => Number(key) !== id),
      ),
    )

  const edit = (person: Person): void => {
    clearError(person.id)
    setEditing({
      person,
      mode: modeOf(person),
      draft: draftOf(stateOf(person)),
      errors: {},
    })
  }
  const setDraft = (draft: Draft): void =>
    setEditing((was) => (was == null ? was : { ...was, draft }))
  const ask = (): void => {
    if (editing == null) return
    const found = {
      ...(nameProblem(editing.draft.name) == null
        ? {}
        : { name: nameProblem(editing.draft.name) }),
      ...(usernameProblem(editing.draft.username) == null
        ? {}
        : { username: usernameProblem(editing.draft.username) }),
    }
    setEditing({ ...editing, errors: found, failure: undefined })
    if (Object.keys(found).length > 0) return
    setConfirming(true)
  }
  const save = async (): Promise<void> => {
    if (editing == null) return
    const { person, draft } = editing
    setSaving(true)
    try {
      await client.put(personPath(person.id), asUnknown, {
        body: changesOf(stateOf(person), draft).body,
      })
      toast({ text: `${draft.name.trim()} saved`, icon: 'check_circle' })
      setConfirming(false)
      setEditing(undefined)
      changed()
    } catch (reason) {
      setConfirming(false)
      setEditing({ ...editing, failure: (reason as Error).message })
    } finally {
      setSaving(false)
    }
  }
  const remove = async (person: Person): Promise<void> => {
    setRemovingBusy(true)
    clearError(person.id)
    try {
      await client.delete(personPath(person.id), asUnknown)
      toast({ text: `${person.name} removed`, icon: 'delete' })
      changed()
    } catch (reason) {
      setErrors((was) => ({ ...was, [person.id]: (reason as Error).message }))
    } finally {
      setRemoving(undefined)
      setRemovingBusy(false)
    }
  }

  const lines =
    editing == null
      ? []
      : changesOf(stateOf(editing.person), editing.draft).lines
  return (
    <>
      <div className="m-row m-row--between m-people__toolbar">
        <FilterPills
          label="Role"
          options={options}
          value={filter}
          onChange={(key) => setFilter(key as 'all' | Role)}
        />
        <div className="m-affix m-people__search">
          <Icon name="search" />
          <input
            className="m-input"
            type="search"
            placeholder="Name or email"
            aria-label="Find a person"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      <section className="m-card" aria-label="People">
        {people.length === 0 ? (
          <EmptyState icon="person" title="Nobody yet." />
        ) : shown.length === 0 ? (
          <EmptyState
            icon="search"
            title="Nothing matches."
            actions={
              <Button
                variant="secondary"
                onClick={() => {
                  setFilter('all')
                  setSearch('')
                }}
              >
                Show everyone
              </Button>
            }
          />
        ) : (
          <div className="m-table-wrap">
            <table className="m-table m-table--stack-52 m-people">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Username</th>
                  <th scope="col">Email addresses</th>
                  <th scope="col">Role</th>
                  <th scope="col">Invitation</th>
                  <th scope="col">Password</th>
                  <th scope="col">
                    <span className="m-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.flatMap((person) => {
                  if (editing?.person.id === person.id)
                    return [
                      <EditBlock
                        key={person.id}
                        editing={editing}
                        busy={saving}
                        onChange={setDraft}
                        onAddEmail={() => setAddingEmail(true)}
                        onCancel={() => setEditing(undefined)}
                        onSave={ask}
                      />,
                    ]
                  const row = (
                    <PersonRow
                      key={person.id}
                      person={person}
                      mode={modeOf(person)}
                      admin={admin}
                      waiting={editing != null}
                      now={now}
                      onEdit={() => edit(person)}
                      onInvite={() => setInviting(person)}
                      onPassword={() => setPassword(person)}
                      onRemove={() => setRemoving(person)}
                    />
                  )
                  const error = errors[person.id]
                  return error == null
                    ? [row]
                    : [
                        row,
                        <tr
                          key={`${person.id}-error`}
                          className="m-people__errorrow"
                        >
                          <td colSpan={7} data-wide>
                            <FormError>{error}</FormError>
                          </td>
                        </tr>,
                      ]
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing != null && (
        <AddEmailSheet
          open={addingEmail}
          draft={editing.draft}
          admin={editing.mode === 'all'}
          onClose={() => setAddingEmail(false)}
          onAdd={setDraft}
        />
      )}
      <Alert
        open={confirming && editing != null}
        title={`Save changes to ${editing?.person.name ?? ''}?`}
        message={<ChangeLines lines={lines} />}
        confirm="Save"
        busy={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
      {admin && (
        <>
          <Alert
            open={removing != null}
            title={`Remove ${removing?.name ?? ''}?`}
            message={<ChangeLines lines={removalLines} />}
            confirm="Remove"
            tone="danger"
            busy={removingBusy}
            onCancel={() => setRemoving(undefined)}
            onConfirm={() => {
              if (removing != null) void remove(removing)
            }}
          />
          {inviting != null && (
            <InviteSheet
              key={inviting.id}
              person={inviting}
              onClose={() => setInviting(undefined)}
              changed={changed}
            />
          )}
          <PasswordSheet
            open={password != null}
            title={`${password?.password === true ? 'Change' : 'Set'} ${password?.name ?? ''}’s password`}
            intro={`${password?.name ?? ''} signs in with it and their username or a confirmed email, on the host and the master. Their sessions end.`}
            path={personPath(password?.id ?? 0)}
            onClose={() => setPassword(undefined)}
            onSet={() => {
              toast({
                text: `${password?.name ?? ''}’s password is set`,
                icon: 'key',
              })
              setPassword(undefined)
              changed()
            }}
          />
        </>
      )}
    </>
  )
}

/** `/people`, the master only: `people.read` reads, `people.change` edits. */
export function PeoplePage(): JSX.Element {
  const { session } = useShell()
  const admin = session.permissions.includes('people.change')
  const list = useResource(PEOPLE_PATH, asPeople)
  const [adding, setAdding] = useState(false)
  return (
    <Page
      crumbs={[{ label: 'People' }]}
      title="People"
      description="Who signs in, with which email addresses, and what their role lets them do."
      actions={
        admin && (
          <Button
            variant="primary"
            icon="add"
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            Add a person
          </Button>
        )
      }
    >
      {list.data != null ? (
        <PeopleTable
          people={list.data}
          viewerId={session.accountId}
          admin={admin}
          changed={list.reload}
        />
      ) : list.error != null ? (
        <Failed
          what="People"
          message={list.error.message}
          retry={list.reload}
        />
      ) : (
        <Loading label="Loading people" />
      )}
      {admin && (
        <AddPersonSheet
          open={adding}
          onClose={() => setAdding(false)}
          onAdded={list.reload}
        />
      )}
    </Page>
  )
}
