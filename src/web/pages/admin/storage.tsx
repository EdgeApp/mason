// The Storage card (screen-10-settings, screen-10b-settings-more): every
// place the host keeps builds — its disk and each DigitalOcean Space Mason
// knows — with the files and bytes the host holds in each. One takes new
// builds; each keeps serving the builds already in it. Managers switch where
// new builds go, make a new Space in a DigitalOcean account or add an
// existing one (form sheets), and delete or forget a Space with a
// type-to-confirm (tier 3). Settings shows it as a card; the Nodes page's
// host panel shows it `compact`, as a titled part of that panel.
import { useId, useState, type FormEvent, type JSX } from 'react'
import { asUnknown } from 'cleaners'
import {
  asCloudAccountViews,
  CLOUD_ACCOUNTS_PATH,
} from '../../../shared/api/cloud.js'
import {
  asStorageRemoved,
  asStorageView,
  SPACES_REGION_CHOICES,
  STORAGE_DISK_PATH,
  STORAGE_NEW_SPACE_PATH,
  STORAGE_PATH,
  STORAGE_SPACE_PATH,
  storageLocationPath,
  storageUsePath,
  type StorageLocation,
} from '../../../shared/api/settings.js'
import { bytes, count } from '../../../shared/format.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import { useShell } from '../../layout/ShellContext.js'
import { Alert } from '../../ui/Alert.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import {
  CheckboxInput,
  FormError,
  SelectInput,
  TextInput,
} from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { Sheet } from '../../ui/Sheet.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { useToast } from '../../ui/Toast.js'
import { Failure, Read, SettingsCard, useActions } from './settings/parts.js'

/** A Space's name, 3 to 63 lowercase letters, digits and dashes. */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** Where a Space came from, in words. */
export function originText(location: StorageLocation): string {
  if (location.origin === 'made') return 'made by Mason'
  if (location.origin === 'host')
    return location.host == null
      ? 'made for a host'
      : `made for host ${location.host}`
  return 'added'
}

/** A location's name: the host's disk, or its Space's bucket. */
export const locationName = (location: StorageLocation): string =>
  location.kind === 'disk' ? 'Host’s disk' : (location.bucket ?? location.id)

/** Make a new Space: a DigitalOcean account, its name and region, and whether new builds go there. */
function NewSpaceSheet({
  open,
  accounts,
  onClose,
  onDone,
}: {
  open: boolean
  accounts: Array<{ id: string; name: string }>
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const id = useId()
  const client = useApi()
  const toast = useToast()
  const submit = useActions()
  const [account, setAccount] = useState(accounts[0]?.id ?? '')
  const [bucket, setBucket] = useState('mason-builds')
  const [region, setRegion] = useState('sfo3')
  const [use, setUse] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const chosen = accounts.some((entry) => entry.id === account)
    ? account
    : (accounts[0]?.id ?? '')
  const dirty = bucket !== 'mason-builds' || region !== 'sfo3' || !use
  const close = (): void => {
    setBucket('mason-builds')
    setRegion('sfo3')
    setUse(true)
    setError(undefined)
    submit.clear()
    onClose()
  }
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = bucket.trim()
    if (!BUCKET.test(name)) {
      setError('Use 3 to 63 lowercase letters, digits and dashes.')
      return
    }
    setError(undefined)
    const done = await submit.run('new', async () => {
      await client.post(STORAGE_NEW_SPACE_PATH, asUnknown, {
        body: { account: chosen, bucket: name, region, use },
      })
    })
    if (!done) return
    toast({ text: `Space ${name} made`, icon: 'storage' })
    onDone()
    close()
  }
  const formId = `${id}-form`
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title="Make a new Space"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="storage"
            busy={submit.busy === 'new'}
          >
            Make the Space
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className="m-stack"
        noValidate
        onSubmit={(event) => void send(event)}
      >
        <div className="m-callout">
          <Icon name="info" />
          <span>
            A Space is DigitalOcean’s storage, billed by use from $5 a month for
            250 GB, so there is no machine size to choose. Mason makes it and a
            key that can use only it; it becomes a row of this list, beside the
            others.
          </span>
        </div>
        <SelectInput
          label="DigitalOcean account"
          value={chosen}
          onChange={setAccount}
          options={accounts.map((entry) => ({
            value: entry.id,
            label: entry.name,
          }))}
        />
        <TextInput
          label="Space name"
          value={bucket}
          onChange={setBucket}
          error={error}
          help="3 to 63 lowercase letters, digits and dashes; unique across DigitalOcean."
          autoComplete="off"
          mono
          verbatim
          required
        />
        <SelectInput
          label="Region"
          value={region}
          onChange={setRegion}
          options={SPACES_REGION_CHOICES}
        />
        <CheckboxInput
          label="Use it for new builds"
          checked={use}
          onChange={setUse}
        />
        <Failure actions={submit} name="new" />
      </form>
    </Sheet>
  )
}

/** Add an existing Space: its URL and a key, checked before it is saved. */
function ExistingSpaceSheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const id = useId()
  const client = useApi()
  const toast = useToast()
  const submit = useActions()
  const [url, setUrl] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [use, setUse] = useState(true)
  const [errors, setErrors] = useState<{
    url?: string
    key?: string
    secret?: string
  }>({})
  const dirty = url !== '' || accessKeyId !== '' || secret !== '' || !use
  const close = (): void => {
    setUrl('')
    setAccessKeyId('')
    setSecret('')
    setUse(true)
    setErrors({})
    submit.clear()
    onClose()
  }
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(/^https:\/\/\S+$/.test(url.trim())
        ? {}
        : { url: 'Enter the Space’s https address.' }),
      ...(accessKeyId.trim() === '' ? { key: 'Enter the access key.' } : {}),
      ...(secret === '' ? { secret: 'Enter the secret.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const done = await submit.run('add', async () => {
      await client.post(STORAGE_SPACE_PATH, asUnknown, {
        body: {
          url: url.trim(),
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secret,
          use,
        },
      })
    })
    if (!done) return
    toast({ text: 'Space added', icon: 'storage' })
    onDone()
    close()
  }
  const formId = `${id}-form`
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title="Add an existing Space"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="check"
            busy={submit.busy === 'add'}
          >
            Check and add
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className="m-stack"
        noValidate
        onSubmit={(event) => void send(event)}
      >
        <TextInput
          label="Space URL"
          value={url}
          onChange={setUrl}
          error={errors.url}
          placeholder="https://name.sfo3.digitaloceanspaces.com"
          inputMode="url"
          autoComplete="off"
          mono
          verbatim
          required
        />
        <TextInput
          label="Access key"
          value={accessKeyId}
          onChange={setAccessKeyId}
          error={errors.key}
          autoComplete="off"
          mono
          verbatim
          required
        />
        <TextInput
          label="Secret"
          type="password"
          value={secret}
          onChange={setSecret}
          error={errors.secret}
          autoComplete="off"
          verbatim
          required
        />
        <CheckboxInput
          label="Use it for new builds"
          checked={use}
          onChange={setUse}
        />
        <p className="m-field__help">
          Mason writes, reads and deletes a check object with the key before
          saving; a key that cannot is refused and nothing changes.
        </p>
        <Failure actions={submit} name="add" />
      </form>
    </Sheet>
  )
}

/** What removing a Space does, in words. */
function removeMessage(location: StorageLocation): string {
  const name = location.bucket ?? location.id
  const files =
    location.usage == null
      ? 'stored'
      : `${count(location.usage.files)} (${bytes(location.usage.bytes)})`
  return location.bucketOwned === true
    ? `DigitalOcean deletes the Space ${name} with its key, and its ${files} builds and artifacts leave Mason. Forget instead keeps the Space and only removes it from Mason.`
    : `Mason stops using ${name}; the Space and its files stay in DigitalOcean, and its ${files} builds and artifacts leave Mason.`
}

/** The locations table: where new builds go, files, size, and removing a Space. */
function Locations({
  locations,
  change,
  changed,
}: {
  locations: StorageLocation[]
  change: boolean
  changed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const [removing, setRemoving] = useState<StorageLocation | undefined>()
  const use = async (location: StorageLocation): Promise<void> => {
    const done = await actions.run(`use-${location.id}`, async () => {
      await client.post(
        location.kind === 'disk'
          ? STORAGE_DISK_PATH
          : storageUsePath(location.id),
        asUnknown,
      )
    })
    if (!done) return
    toast({
      text: `New builds go to ${locationName(location)}`,
      icon: 'check_circle',
    })
    changed()
  }
  const remove = async (location: StorageLocation): Promise<void> => {
    const deletes = location.bucketOwned === true
    const done = await actions.run(`remove-${location.id}`, async () => {
      await client.delete(storageLocationPath(location.id), asStorageRemoved, {
        body: { confirm: location.bucket },
      })
    })
    setRemoving(undefined)
    if (!done) return
    toast({
      text: `${locationName(location)} ${deletes ? 'deleted' : 'forgotten'}`,
      icon: 'delete',
    })
    changed()
  }
  if (locations.length === 0)
    return <EmptyState icon="storage" title="No storage locations." />
  const failed = locations.find(
    (location) =>
      actions.failed(`use-${location.id}`) != null ||
      actions.failed(`remove-${location.id}`) != null,
  )
  const deletes = removing?.bucketOwned === true
  return (
    <>
      <div className="m-table-wrap">
        <table className="m-table m-table--stack m-storage__table">
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col">New builds</th>
              <th scope="col" className="m-right">
                Files
              </th>
              <th scope="col" className="m-right">
                Size
              </th>
              {change && (
                <th scope="col">
                  <span className="m-sr">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {locations.map((location) => {
              const removable =
                change && location.kind === 'space' && !location.active
              const owned = location.bucketOwned === true
              return (
                <tr key={location.id} data-location={location.id}>
                  <td data-primary data-label="Location">
                    {location.kind === 'disk' ? (
                      <span className="m-t-headline">Host’s disk</span>
                    ) : (
                      <span className="m-list__main">
                        <span className="m-t-mono m-storage__bucket">
                          {location.bucket ?? location.id}
                        </span>
                        <span className="m-t-subhead m-secondary">
                          {[location.region, originText(location)]
                            .filter((part) => part != null)
                            .join(' · ')}
                        </span>
                      </span>
                    )}
                  </td>
                  <td data-label="New builds">
                    {location.active ? (
                      <StatusPill
                        quiet
                        status="active"
                        label="New builds go here"
                      />
                    ) : change ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        busy={actions.busy === `use-${location.id}`}
                        aria-label={`Use ${locationName(location)} for new builds`}
                        onClick={() => void use(location)}
                      >
                        Use for new builds
                      </Button>
                    ) : (
                      <span className="m-tertiary">—</span>
                    )}
                  </td>
                  <td data-label="Files" className="m-right m-num">
                    {location.usage == null ? '—' : count(location.usage.files)}
                  </td>
                  <td data-label="Size" className="m-right m-num">
                    {location.usage == null ? '—' : bytes(location.usage.bytes)}
                  </td>
                  {change && (
                    <td data-actions>
                      {removable && (
                        <div className="m-table__actions">
                          <Button
                            variant="danger"
                            size="sm"
                            icon="delete"
                            aria-haspopup="dialog"
                            aria-label={`${owned ? 'Delete' : 'Forget'} the Space ${location.bucket ?? location.id}`}
                            onClick={() => {
                              actions.clear()
                              setRemoving(location)
                            }}
                          >
                            {owned ? 'Delete' : 'Forget'}
                          </Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {failed != null && (
        <div className="m-card__body">
          <FormError ref={actions.error}>
            {actions.failed(`use-${failed.id}`) ??
              actions.failed(`remove-${failed.id}`)}
          </FormError>
        </div>
      )}
      <Alert
        open={removing != null}
        title={`${deletes ? 'Delete' : 'Forget'} the Space ${removing?.bucket ?? ''}?`}
        message={removing == null ? undefined : removeMessage(removing)}
        cancel="Keep it"
        confirm={deletes ? 'Delete the Space' : 'Forget the Space'}
        tone="danger"
        typeToConfirm={removing?.bucket ?? ''}
        busy={removing != null && actions.busy === `remove-${removing.id}`}
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          if (removing != null) void remove(removing)
        }}
      />
    </>
  )
}

/** Settings → Storage, or (`compact`) the Nodes page's host panel's part. */
export function StorageCard(props: { compact?: boolean }): JSX.Element {
  const compact = props.compact === true
  const { session } = useShell()
  const change = session.permissions.includes('settings.change')
  const read = useResource(STORAGE_PATH, asStorageView)
  const accounts = useResource(
    change ? CLOUD_ACCOUNTS_PATH : null,
    asCloudAccountViews,
  )
  const [adding, setAdding] = useState<'new' | 'existing' | undefined>()
  const spaceAccounts = (accounts.data ?? [])
    .filter((account) => account.provider === 'digitalocean')
    .map((account) => ({ id: account.id, name: account.name }))
  const actions = change && (
    <div className="m-btngroup">
      {spaceAccounts.length > 0 && (
        <Button
          variant="tinted"
          size="sm"
          icon="add"
          aria-haspopup="dialog"
          onClick={() => setAdding('new')}
        >
          Make a new Space
        </Button>
      )}
      <Button
        variant="tinted"
        size="sm"
        icon="add"
        aria-haspopup="dialog"
        onClick={() => setAdding('existing')}
      >
        Add an existing Space
      </Button>
    </div>
  )
  const body = (
    <>
      {!compact && (
        <div className="m-card__body m-storage__intro">
          <p className="m-t-callout m-secondary">
            Every place builds are stored. New builds go to one of them; each
            keeps serving the builds already in it.
          </p>
        </div>
      )}
      <Read read={read} what="Storage">
        {(data) => (
          <Locations
            locations={data.locations}
            change={change}
            changed={read.reload}
          />
        )}
      </Read>
      {change && (
        <>
          <NewSpaceSheet
            open={adding === 'new'}
            accounts={spaceAccounts}
            onClose={() => setAdding(undefined)}
            onDone={read.reload}
          />
          <ExistingSpaceSheet
            open={adding === 'existing'}
            onClose={() => setAdding(undefined)}
            onDone={read.reload}
          />
        </>
      )}
    </>
  )
  if (compact)
    return (
      <section
        className="m-storage m-storage--compact"
        aria-labelledby="storage-compact-title"
      >
        <header className="m-row m-row--between m-storage__head">
          <h3 className="m-t-headline" id="storage-compact-title">
            <Icon name="storage" /> Storage
          </h3>
          {actions}
        </header>
        {body}
      </section>
    )
  return (
    <SettingsCard id="storage" icon="storage" title="Storage" actions={actions}>
      {body}
    </SettingsCard>
  )
}
