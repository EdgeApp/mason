// A group, on the master (screen-14-groups): its name, its apps and its
// members. Managers rename it in an edit block (Enter saves, Escape
// cancels), add and remove apps and members with a picker per section, each
// toggle saved at once and queued in order (a member's or an app's row has
// its own Remove, tier 1, with Undo), and remove the group (tier 2). Without
// groups.change it is plain text. An unknown group is "No such group".
import { useRef, useState, type FormEvent, type JSX } from 'react'
import { useNavigate, useParams } from 'react-router'
import { asUnknown } from 'cleaners'
import {
  APPS_PATH,
  asAppItems,
  asGroupDetail,
  groupPath,
  type AppItem,
  type GroupDetail,
} from '../../../../shared/api/admin.js'
import { useApi } from '../../../api/context.js'
import { useResource, type Resource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Alert } from '../../../ui/Alert.js'
import { Avatar } from '../../../ui/Avatar.js'
import { Count } from '../../../ui/Badge.js'
import { Button, ButtonLink } from '../../../ui/Button.js'
import { Chip } from '../../../ui/Chip.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { FormError, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import type { IconName } from '../../../ui/icons.js'
import {
  Picker,
  usePicker,
  type PickerItem,
  type PickerState,
} from '../../../ui/Picker.js'
import { SkeletonText } from '../../../ui/Skeleton.js'
import { useToast } from '../../../ui/Toast.js'
import { Failed, Loading } from '../../projects/project.js'
import { GROUP_NAME_MAX } from './Groups.js'
import { asGroupPeople, PEOPLE_PATH, type GroupPerson } from './groupsApi.js'

const GROUPS = { label: 'Groups', to: '/groups' }
const DESCRIPTION = 'Its members see its apps in their catalog.'

/** The rename edit block: the name, Cancel and Save; Enter saves, Escape cancels. */
function RenameBlock({
  group,
  onSaved,
  onCancel,
}: {
  group: GroupDetail
  onSaved: (group: GroupDetail) => void
  onCancel: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [name, setName] = useState(group.name)
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState<string | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const next = name.trim()
    if (next === group.name) {
      onCancel()
      return
    }
    if (next === '') {
      setWrong('Enter a name.')
      return
    }
    setWrong(undefined)
    setFailed(undefined)
    setBusy(true)
    try {
      const saved = await client.put(groupPath(group.id), asGroupDetail, {
        body: { name: next },
      })
      toast({ text: `Renamed to ${saved.name}`, icon: 'edit' })
      onSaved(saved)
    } catch (reason) {
      setFailed((reason as Error).message)
      setBusy(false)
      setTimeout(() => error.current?.focus(), 0)
    }
  }
  return (
    <section className="m-card" aria-label="Rename the group">
      <form
        className="m-editblock"
        aria-label={`Rename ${group.name}`}
        noValidate
        onSubmit={(event) => void save(event)}
        onKeyDown={(event) => {
          // Escape waits for a save on its way, so no answer lands on newer text.
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onCancel()
          }
        }}
      >
        <div className="m-editblock__fields">
          <TextInput
            label="Name"
            name="name"
            value={name}
            onChange={setName}
            error={wrong}
            maxLength={GROUP_NAME_MAX}
            readOnly={busy}
            autoComplete="off"
            autoFocus
            required
          />
        </div>
        {failed != null && <FormError ref={error}>{failed}</FormError>}
        <div className="m-editblock__foot">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </section>
  )
}

/** What a section lists, and how its picker and rows name an entry. */
interface SectionKind<Id> {
  key: 'apps' | 'members'
  title: string
  icon: IconName
  add: string
  find: string
  placeholder: string
  empty: string
  items: Array<PickerItem<Id>>
  /** A saved id the catalog does not list (an app removed since). */
  unknown: (id: Id) => PickerItem<Id>
}

/** A section: its rows, its Add button and picker, and its refusal. */
function Section<Id extends number>({
  kind,
  group,
  picker,
  change,
  catalog,
}: {
  kind: SectionKind<Id>
  group: GroupDetail
  picker: PickerState<Id>
  change: boolean
  /** The catalog's read: its loading and error states are the section's. */
  catalog: Resource<unknown>
}): JSX.Element {
  const add = useRef<HTMLButtonElement>(null)
  const titleId = `group-${kind.key}`
  // In the catalog's order; ids it does not list (removed since) last.
  const saved = new Set(picker.saved)
  const listed = new Set(kind.items.map((item) => item.id))
  const rows = [
    ...kind.items.filter((item) => saved.has(item.id)),
    ...picker.saved.filter((id) => !listed.has(id)).map(kind.unknown),
  ]
  return (
    <section className="m-card" aria-labelledby={titleId}>
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name={kind.icon} />
          <h2 className="m-t-title3" id={titleId}>
            {kind.title}
          </h2>
          <Count count={picker.saved.length} />
        </div>
        {change && catalog.data != null && (
          <Button
            ref={add}
            variant="tinted"
            size="sm"
            icon="add"
            aria-expanded={picker.open}
            onClick={() => (picker.open ? picker.close() : picker.show())}
          >
            {kind.add}
          </Button>
        )}
      </header>
      {picker.open && (
        <div className="m-card__body m-group__picker">
          <Picker
            picker={picker}
            items={kind.items}
            label={kind.find}
            placeholder={kind.placeholder}
            choiceLabel={(item) => `${item.label} in ${group.name}`}
            onDone={() => setTimeout(() => add.current?.focus(), 0)}
          />
        </div>
      )}
      {picker.error != null && (
        <div className="m-card__body m-group__error">
          <FormError>{picker.error}</FormError>
        </div>
      )}
      {catalog.data == null ? (
        catalog.error != null ? (
          <EmptyState
            icon="error"
            tone="danger"
            title={`The ${kind.key} could not be read`}
            actions={
              <Button
                variant="secondary"
                icon="refresh"
                onClick={catalog.reload}
              >
                Retry
              </Button>
            }
          >
            {catalog.error.message}
          </EmptyState>
        ) : (
          <div className="m-card__body">
            <SkeletonText lines={3} label={`Loading the ${kind.key}`} />
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="m-card__body m-t-subhead m-secondary m-group__none">
          {kind.empty}
        </p>
      ) : (
        <ul className="m-list" data-group-rows={kind.key}>
          {rows.map((item) => (
            <li className="m-list__row" key={item.id} data-id={item.id}>
              {kind.key === 'members' && <Avatar name={item.label} />}
              <span className="m-list__main">
                <span className="m-t-headline">{item.label}</span>
                {item.detail != null && (
                  <span
                    className={
                      item.mono === true
                        ? 'm-list__sub m-t-mono-sm'
                        : 'm-list__sub'
                    }
                  >
                    {item.detail}
                  </span>
                )}
              </span>
              {change && (
                <Button
                  variant="plain"
                  size="sm"
                  iconOnly
                  icon="close"
                  label={`Remove ${item.label} from ${group.name}`}
                  onClick={() => picker.toggle(item.id, false)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A person's row and choice: name, first email; found by any address. */
const personItem = (person: GroupPerson): PickerItem<number> => ({
  id: person.id,
  label: person.name,
  ...(person.emails[0] == null ? {} : { detail: person.emails[0].email }),
  search: person.emails.map((entry) => entry.email),
})

/** An app's row and choice: name, slug; found by either; disabled apps not offered first. */
const appItem = (app: AppItem): PickerItem<number> => ({
  id: app.id,
  label: app.name,
  detail: app.slug,
  mono: true,
  search: [app.slug],
  offered: app.enabled,
})

/** The group's page once it is read. */
function GroupBody({
  initial,
  change,
}: {
  initial: GroupDetail
  change: boolean
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const apps = useResource(APPS_PATH, asAppItems)
  const people = useResource(PEOPLE_PATH, asGroupPeople)
  const [group, setGroup] = useState(initial)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const rename = useRef<HTMLButtonElement>(null)
  const appItems = (apps.data ?? []).map(appItem)
  const personItems = (people.data ?? []).map(personItem)
  const names = (items: Array<PickerItem<number>>, id: number): string =>
    items.find((item) => item.id === id)?.label ?? `#${id}`
  const put = async (body: object): Promise<GroupDetail> => {
    const saved = await client.put(groupPath(group.id), asGroupDetail, {
      body,
    })
    setGroup(saved)
    return saved
  }
  const appsPicker: PickerState<number> = usePicker({
    saved: group.apps.map((app) => app.id),
    save: async (ids) => (await put({ apps: ids })).apps.map((app) => app.id),
    onSaved: (id, checked) =>
      toast({
        text: `${names(appItems, id)} ${checked ? 'added to' : 'removed from'} ${group.name}`,
        icon: 'apps',
        ...(checked
          ? {}
          : {
              action: { label: 'Undo', run: () => appsPicker.toggle(id, true) },
            }),
      }),
  })
  const membersPicker: PickerState<number> = usePicker({
    saved: group.members,
    save: async (ids) => (await put({ members: ids })).members,
    onSaved: (id, checked) =>
      toast({
        text: `${names(personItems, id)} ${checked ? 'added to' : 'removed from'} ${group.name}`,
        icon: 'group',
        ...(checked
          ? {}
          : {
              action: {
                label: 'Undo',
                run: () => membersPicker.toggle(id, true),
              },
            }),
      }),
  })
  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await client.delete(groupPath(group.id), asUnknown)
      toast({ text: `${group.name} removed`, icon: 'delete' })
      void navigate('/groups')
    } catch (reason) {
      setRemoving(false)
      setBusy(false)
      setFailed((reason as Error).message)
    }
  }
  const slugOf = (id: number): string =>
    group.apps.find((app) => app.id === id)?.slug ?? `#${id}`
  return (
    <Page
      crumbs={[GROUPS, { label: group.name }]}
      title={group.name}
      pill={<Chip>Group</Chip>}
      description={DESCRIPTION}
      actions={
        change ? (
          <>
            <Button
              ref={rename}
              variant="secondary"
              icon="edit"
              aria-expanded={renaming}
              onClick={() => setRenaming(true)}
            >
              Rename
            </Button>
            <Button
              variant="danger"
              icon="delete"
              aria-haspopup="dialog"
              onClick={() => {
                setFailed(undefined)
                setRemoving(true)
              }}
            >
              Remove group
            </Button>
          </>
        ) : undefined
      }
    >
      {failed != null && <FormError>{failed}</FormError>}
      {renaming && (
        <RenameBlock
          group={group}
          onSaved={(saved) => {
            setGroup(saved)
            setRenaming(false)
            setTimeout(() => rename.current?.focus(), 0)
          }}
          onCancel={() => {
            setRenaming(false)
            setTimeout(() => rename.current?.focus(), 0)
          }}
        />
      )}
      <div className="m-grid-2 m-group">
        <Section
          kind={{
            key: 'apps',
            title: 'Apps',
            icon: 'apps',
            add: 'Add app',
            find: 'Find an app',
            placeholder: 'App name or ID',
            empty: 'No apps yet.',
            items: appItems,
            unknown: (id) => ({ id, label: slugOf(id) }),
          }}
          group={group}
          picker={appsPicker}
          change={change}
          catalog={apps}
        />
        <Section
          kind={{
            key: 'members',
            title: 'Members',
            icon: 'group',
            add: 'Add member',
            find: 'Find a person',
            placeholder: 'Name or email',
            empty: 'No members yet.',
            items: personItems,
            unknown: (id) => ({ id, label: `Person #${id}` }),
          }}
          group={group}
          picker={membersPicker}
          change={change}
          catalog={people}
        />
      </div>
      {change && (
        <Alert
          open={removing}
          title={`Remove ${group.name}?`}
          message="Its members no longer see its apps in their catalog. The apps and the people stay."
          cancel="Keep it"
          confirm="Remove group"
          tone="danger"
          busy={busy}
          onCancel={() => setRemoving(false)}
          onConfirm={() => void remove()}
        />
      )}
    </Page>
  )
}

/** `/groups/:id`, the master only. */
export function GroupPage(): JSX.Element {
  const { id = '' } = useParams()
  const { session } = useShell()
  const change = session.permissions.includes('groups.change')
  const valid = /^[1-9]\d{0,15}$/.test(id)
  const read = useResource(valid ? groupPath(Number(id)) : null, asGroupDetail)
  if (!valid || read.error?.status === 404)
    return (
      <Page crumbs={[GROUPS, { label: 'No such group' }]} title="No such group">
        <section className="m-card">
          <EmptyState
            icon="group"
            title="There is no such group."
            actions={
              <ButtonLink variant="secondary" icon="arrow_back" to="/groups">
                All groups
              </ButtonLink>
            }
          >
            It may have been removed.
          </EmptyState>
        </section>
      </Page>
    )
  if (read.data != null)
    return <GroupBody key={read.data.id} initial={read.data} change={change} />
  return (
    <Page
      crumbs={[GROUPS, { label: 'Group' }]}
      title="Group"
      description={DESCRIPTION}
    >
      {read.error != null ? (
        <Failed
          what="The group"
          message={read.error.message}
          retry={read.reload}
        />
      ) : (
        <Loading label="Loading the group" />
      )}
    </Page>
  )
}
