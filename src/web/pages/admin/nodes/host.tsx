// The Host card (screen-09-nodes's aside, screen-09b-nodes-host): the one
// host in every state. No host yet: an administrator creates one on a
// DigitalOcean account (a large sheet) or installs one and pairs it; a
// manager reads who may. A cloud host: its state, where it is, its update,
// certificate, origin, Space and error; a Space for its builds (managers),
// Reconcile, and Remove (tier 3: its name typed, and what becomes of the
// Space). A host installed by hand: what it serves. With a host, managers
// see where it stores builds (the compact Storage card).
import { useId, useState, type FormEvent, type JSX } from 'react'
import { Link } from 'react-router'
import { asUnknown } from 'cleaners'
import {
  NODES_PATH,
  asCloudDomains,
  cloudDomainsPath,
} from '../../../../shared/api/admin.js'
import type { CloudAccountView } from '../../../../shared/api/cloud.js'
import {
  asCloudMachine,
  asNamed,
  CLOUD_HOSTS_PATH,
  cloudHostPath,
  SPACES_REGIONS,
  type CloudHostRequest,
  type CloudMachine,
  type HostRemoval,
  type NodeCard,
  type SpaceRequest,
} from '../../../../shared/api/nodes.js'
import { useApi } from '../../../api/context.js'
import { useResource, type Resource } from '../../../hooks/useResource.js'
import { Button } from '../../../ui/Button.js'
import { Dialog } from '../../../ui/Dialog.js'
import { SelectInput, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { FormSection, LargeSheet, useDraft } from '../../../ui/LargeSheet.js'
import { Sheet } from '../../../ui/Sheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import { StorageCard } from '../storage.js'
import {
  CardError,
  CardLoading,
  dnsName,
  InstallStep,
  machineLine,
  MachineError,
  MachineFields,
  SLUG,
  SubmitError,
  UpdatingNotice,
  useCatalog,
  useSubmit,
  type Allowed,
  type MachineChoice,
  type Release,
} from './parts.js'

/** A Space's name: 3–63 lowercase letters, digits and dashes. */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** A DNS record in a domain, or `@` for the domain itself. */
const RECORD = /^(@|[a-z0-9.-]{1,200})$/

/** Hosts are made on DigitalOcean; a NoMac account makes only pool Macs. */
export const digitalOcean = (
  accounts: CloudAccountView[],
): CloudAccountView[] =>
  accounts.filter((account) => account.provider === 'digitalocean')

interface HostForm extends MachineChoice {
  name: string
  domain: string
  record: string
  bucket: string
  spaceRegion: string
}

const HOST_START: HostForm = {
  name: '',
  region: 'sfo3',
  size: 's-1vcpu-1gb',
  image: 'ubuntu-24-04-x64',
  domain: '',
  record: '',
  bucket: '',
  spaceRegion: 'sfo3',
}

/** Create a host on one DigitalOcean account: the machine, its DNS name and its Space. */
export function CreateHostSheet({
  account,
  open,
  onClose,
  onCreated,
}: {
  account: CloudAccountView
  open: boolean
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const submit = useSubmit()
  const formId = useId()
  const draft = useDraft<HostForm>(
    open ? `host:${account.id}` : null,
    HOST_START,
  )
  const catalog = useCatalog(account, open && account.adminKeyed)
  const domains = useResource(
    open && account.adminKeyed ? cloudDomainsPath(account.id) : null,
    asCloudDomains,
  )
  const [errors, setErrors] = useState<Partial<Record<keyof HostForm, string>>>(
    {},
  )
  const form = draft.value
  const set = (fields: Partial<HostForm>): void =>
    draft.set((was) => ({ ...was, ...fields }))
  const close = (): void => {
    draft.clear()
    setErrors({})
    submit.clear()
    onClose()
  }
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong: Partial<Record<keyof HostForm, string>> = {
      ...(SLUG.test(form.name)
        ? {}
        : { name: 'Lowercase letters, digits and dashes, up to 40.' }),
      ...(form.domain !== '' && !RECORD.test(form.record)
        ? { record: 'A name in the domain, or @ for the domain itself.' }
        : {}),
      ...(form.bucket !== '' && !BUCKET.test(form.bucket)
        ? { bucket: '3 to 63 lowercase letters, digits and dashes.' }
        : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const body: CloudHostRequest = {
      account: account.id,
      name: form.name,
      region: form.region,
      size: form.size,
      image: form.image,
      ...(form.domain === ''
        ? {}
        : { dns: { domain: form.domain, name: form.record } }),
      ...(form.bucket === ''
        ? {}
        : { space: { bucket: form.bucket, region: form.spaceRegion } }),
    }
    if (
      await submit.run(async () => {
        await client.post(CLOUD_HOSTS_PATH, asNamed, { body })
      })
    ) {
      toast({ text: `Making the host ${form.name}`, icon: 'cloud' })
      close()
      onCreated()
    }
  }
  return (
    <LargeSheet
      open={open}
      onClose={close}
      title={`Create a host on ${account.name}`}
      dirty={draft.dirty}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          {account.adminKeyed && (
            <Button
              variant="primary"
              type="submit"
              form={formId}
              icon="add"
              busy={submit.busy}
            >
              Create host
            </Button>
          )}
        </>
      )}
    >
      {!account.adminKeyed ? (
        <div className="m-callout">
          <Icon name="lock" />
          <span>
            An administrator must replace this account’s key (
            <Link to={`/cloud#account-${encodeURIComponent(account.id)}`}>
              Replace key
            </Link>{' '}
            on the Cloud page) before a host is made in it: whoever holds the
            account holds the host.
          </span>
        </div>
      ) : (
        <form
          noValidate
          id={formId}
          className="m-stack"
          onSubmit={(event) => void create(event)}
        >
          <FormSection legend="Machine">
            <TextInput
              label="Name"
              value={form.name}
              onChange={(name) => set({ name })}
              required
              mono
              verbatim
              autoComplete="off"
              placeholder="builds"
              help="Its name on this master and its droplet’s."
              error={errors.name}
            />
            <MachineFields
              account={account}
              catalog={catalog}
              value={form}
              onChange={(choice) => set(choice)}
            />
          </FormSection>
          <FormSection legend="Address">
            <SelectInput
              label="DNS domain"
              value={form.domain}
              onChange={(domain) => set({ domain })}
              options={[
                { value: '', label: 'No DNS: serve the droplet’s address' },
                ...(domains.data ?? []),
              ]}
              help={
                domains.error != null
                  ? `The domains could not be read: ${domains.error.message}`
                  : 'A domain the account’s DNS holds; the host then gets a Let’s Encrypt certificate.'
              }
            />
            <TextInput
              label="Record name in the domain"
              optional={form.domain === ''}
              value={form.record}
              onChange={(record) => set({ record })}
              mono
              verbatim
              autoComplete="off"
              placeholder="builds"
              help="Or @ for the domain itself."
              error={errors.record}
            />
          </FormSection>
          <FormSection legend="Builds">
            <TextInput
              label="Space name"
              optional
              value={form.bucket}
              onChange={(bucket) => set({ bucket })}
              mono
              verbatim
              autoComplete="off"
              placeholder="mason-builds"
              help="A new DigitalOcean Space for its builds. Empty: the host’s disk."
              error={errors.bucket}
            />
            <SelectInput
              label="Space region"
              value={form.spaceRegion}
              onChange={(spaceRegion) => set({ spaceRegion })}
              options={SPACES_REGIONS}
              mono
            />
          </FormSection>
          <SubmitError submit={submit} />
        </form>
      )}
    </LargeSheet>
  )
}

/** Install a host by hand: the command, then its address and pairing key. */
export function InstallHostSheet({
  open,
  release,
  onClose,
  onPaired,
}: {
  open: boolean
  release: Release
  onClose: () => void
  onPaired: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const submit = useSubmit()
  const formId = useId()
  const [address, setAddress] = useState('')
  const [key, setKey] = useState('')
  const [errors, setErrors] = useState<{ address?: string; key?: string }>({})
  const close = (): void => {
    setAddress('')
    setKey('')
    setErrors({})
    submit.clear()
    onClose()
  }
  const pair = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(address.trim() === ''
        ? { address: 'Enter the host’s address and port.' }
        : {}),
      ...(key.trim() === '' ? { key: 'Enter the pairing key.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    if (
      await submit.run(async () => {
        await client.post(NODES_PATH, asNamed, {
          body: { address: address.trim(), key: key.trim() },
        })
      })
    ) {
      toast({ text: 'The host is paired', icon: 'lan' })
      close()
      onPaired()
    }
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Install a host yourself"
      dirty={address !== '' || key !== ''}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="lan"
            busy={submit.busy}
          >
            Pair host
          </Button>
        </>
      )}
    >
      <form noValidate id={formId} onSubmit={(event) => void pair(event)}>
        <ol className="m-howto">
          <InstallStep
            release={release}
            role="host"
            where="On a computer the internet can reach."
          />
          <li>
            <div>
              <span className="m-t-headline">Pair it here</span>
              <span className="m-t-subhead m-secondary">
                To put the host behind TLS on port 443, see the README’s
                public-server command.
              </span>
              <TextInput
                label="Address and port"
                value={address}
                onChange={setAddress}
                required
                mono
                verbatim
                autoComplete="off"
                placeholder="builds.example.com:9310"
                error={errors.address}
              />
              <TextInput
                label="Pairing key"
                value={key}
                onChange={setKey}
                required
                mono
                verbatim
                autoComplete="off"
                placeholder="mason1:…"
                error={errors.key}
              />
              <SubmitError submit={submit} />
            </div>
          </li>
        </ol>
      </form>
    </Sheet>
  )
}

/** Give the host a new Space for its builds. */
export function SpaceSheet({
  host,
  admin,
  onClose,
  onSaved,
}: {
  host: CloudMachine | undefined
  /** An administrator's request makes the Space at once. */
  admin: boolean
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const submit = useSubmit()
  const formId = useId()
  const [form, setForm] = useState<{
    for: string | undefined
    bucket: string
    region: string
  }>({ for: undefined, bucket: '', region: 'sfo3' })
  const [error, setError] = useState<string | undefined>()
  // Where the sheet starts for this host: a Space named for it, in its region.
  const bucket = `mason-${host?.name ?? ''}`
  const region =
    host != null && (SPACES_REGIONS as readonly string[]).includes(host.region)
      ? host.region
      : 'sfo3'
  if (host != null && form.for !== host.name) {
    setForm({ for: host.name, bucket, region })
    setError(undefined)
    submit.clear()
  }
  const close = (): void => {
    setForm((was) => ({ ...was, for: undefined }))
    onClose()
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (host == null) return
    if (!BUCKET.test(form.bucket)) {
      setError('3 to 63 lowercase letters, digits and dashes.')
      return
    }
    setError(undefined)
    const body: SpaceRequest = { bucket: form.bucket, region: form.region }
    let saved: CloudMachine | undefined
    if (
      await submit.run(async () => {
        saved = await client.post(
          cloudHostPath(host.name, 'space'),
          asCloudMachine,
          { body },
        )
      })
    ) {
      toast({
        text:
          saved?.space_pending === 1
            ? `The Space ${form.bucket} is made at the host’s next check`
            : `${host.name} stores new builds in ${form.bucket}`,
        icon: 'storage',
      })
      close()
      onSaved()
    }
  }
  return (
    <Sheet
      open={host != null}
      onClose={close}
      title="Store builds in a new DigitalOcean Space"
      dirty={form.bucket !== bucket || form.region !== region}
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
            busy={submit.busy}
          >
            Make the Space
          </Button>
        </>
      )}
    >
      <form
        noValidate
        id={formId}
        className="m-stack"
        onSubmit={(event) => void save(event)}
      >
        <p className="m-t-subhead m-secondary m-nodes__flush">
          The host keeps builds on its own disk until it has a Space. Mason
          makes the Space and a key that can use only it. New builds are stored
          there; earlier ones stay where they are.
          {!admin &&
            ' Yours is made at the host’s next check, within ten minutes.'}
        </p>
        <TextInput
          label="Space name"
          value={form.bucket}
          onChange={(bucket) => setForm({ ...form, bucket })}
          required
          mono
          verbatim
          autoComplete="off"
          help="3 to 63 lowercase letters, digits and dashes; unique across DigitalOcean."
          error={error}
        />
        <SelectInput
          label="Space region"
          value={form.region}
          onChange={(region) => setForm({ ...form, region })}
          options={SPACES_REGIONS}
          mono
        />
        <SubmitError submit={submit} />
      </form>
    </Sheet>
  )
}

/**
 * Remove the host (tier 3): its name typed, and whether its Space and every
 * build in it go too. The confirming button waits for the name.
 */
export function RemoveHostAlert({
  host,
  busy,
  onCancel,
  onConfirm,
}: {
  host: CloudMachine | undefined
  busy: boolean
  onCancel: () => void
  onConfirm: (removal: HostRemoval) => void
}): JSX.Element {
  const titleId = useId()
  const fieldId = useId()
  const [typed, setTyped] = useState('')
  const [deleteSpace, setDeleteSpace] = useState(false)
  const name = host?.name ?? ''
  const reset = (): void => {
    setTyped('')
    setDeleteSpace(false)
  }
  const close = (): void => {
    reset()
    onCancel()
  }
  return (
    <Dialog
      open={host != null}
      onClose={close}
      role="alertdialog"
      labelledBy={titleId}
      dismissOnScrim={false}
    >
      <div className="m-alert">
        <h2
          className="m-t-title3"
          id={titleId}
          tabIndex={-1}
          data-dialog-title=""
        >
          Remove the host {name}?
        </h2>
        <p>
          Its droplet is destroyed and it is unpaired. Testers cannot install
          until a new host exists.
        </p>
        {host?.space_bucket != null && (
          <fieldset className="m-fieldset m-nodes__choice">
            <legend className="m-field__label">
              Its Space <span className="m-t-mono">{host.space_bucket}</span>
            </legend>
            <label className="m-check">
              <input
                type="radio"
                name={`${fieldId}-space`}
                checked={!deleteSpace}
                onChange={() => setDeleteSpace(false)}
              />
              <span>Keep the Space and its builds as a storage location</span>
            </label>
            <label className="m-check">
              <input
                type="radio"
                name={`${fieldId}-space`}
                checked={deleteSpace}
                onChange={() => setDeleteSpace(true)}
              />
              <span>Also delete the Space and every build in it</span>
            </label>
          </fieldset>
        )}
        <div className="m-field">
          <label className="m-field__label" htmlFor={fieldId}>
            Type <span className="m-t-mono">{name}</span> to destroy its droplet
            and unpair it
          </label>
          <input
            id={fieldId}
            className="m-input m-input--mono"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className="m-alert__actions">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger-filled"
            disabled={typed.trim() !== name}
            busy={busy}
            onClick={() => {
              const removal = { confirm: typed.trim(), deleteSpace }
              reset()
              onConfirm(removal)
            }}
          >
            Remove host
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** A cloud host's facts and actions. */
function CloudHost({
  host,
  allowed,
  onChanged,
}: {
  host: CloudMachine
  allowed: Allowed
  onChanged: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const reconcile = useSubmit()
  const remove = useSubmit()
  const [spacing, setSpacing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const dns = dnsName(host)
  const removeHost = async (removal: HostRemoval): Promise<void> => {
    if (
      await remove.run(async () => {
        await client.delete(cloudHostPath(host.name), asUnknown, {
          body: removal,
        })
      })
    ) {
      toast({ text: `${host.name} removed`, icon: 'delete' })
      onChanged()
    }
    setRemoving(false)
  }
  return (
    <div className="m-card__body m-stack" data-host={host.name}>
      <span className="m-t-mono m-nodes__name">{host.name}</span>
      <span className="m-t-mono-sm m-secondary">{machineLine(host)}</span>
      <UpdatingNotice machine={host} />
      {host.origin != null && (
        <span className="m-t-subhead">
          Serves <a href={host.origin}>{host.origin}</a>
        </span>
      )}
      {host.certificate === 'waiting' && (
        <div className="m-row">
          <StatusPill status="waiting_cert" />
          <span className="m-t-subhead m-secondary">
            Caddy asks Let’s Encrypt once {dns ?? 'the DNS name'} resolves.
          </span>
        </div>
      )}
      {host.certificate === 'trusted' && (
        <div>
          <StatusPill status="trusted" quiet />
        </div>
      )}
      {host.space_bucket != null && (
        <span className="m-t-subhead m-secondary">
          Builds Space <span className="m-t-mono-sm">{host.space_bucket}</span>
          {host.space_region == null ? '' : ` (${host.space_region})`}
          {host.space_pending === 1 ? ' · waiting to be made' : ''}
        </span>
      )}
      <MachineError machine={host} />
      {(allowed.settings || allowed.hosts) && (
        <div className="m-row">
          {allowed.settings && host.space_bucket == null && (
            <Button
              variant="secondary"
              size="sm"
              icon="storage"
              aria-haspopup="dialog"
              onClick={() => setSpacing(true)}
            >
              Store builds in a new DigitalOcean Space
            </Button>
          )}
          {allowed.hosts && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                busy={reconcile.busy}
                onClick={() =>
                  void reconcile
                    .run(async () => {
                      await client.post(
                        cloudHostPath(host.name, 'reconcile'),
                        asCloudMachine,
                      )
                    })
                    .then((done) => {
                      if (!done) return
                      toast({
                        text: `${host.name} checked again`,
                        icon: 'refresh',
                      })
                      onChanged()
                    })
                }
              >
                Reconcile
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon="delete"
                aria-haspopup="dialog"
                busy={remove.busy}
                onClick={() => setRemoving(true)}
              >
                Remove host
              </Button>
            </>
          )}
        </div>
      )}
      <SubmitError submit={reconcile} />
      <SubmitError submit={remove} />
      {allowed.settings && (
        <SpaceSheet
          host={spacing ? host : undefined}
          admin={allowed.hosts}
          onClose={() => setSpacing(false)}
          onSaved={onChanged}
        />
      )}
      {allowed.hosts && (
        <RemoveHostAlert
          host={removing ? host : undefined}
          busy={remove.busy}
          onCancel={() => setRemoving(false)}
          onConfirm={(removal) => void removeHost(removal)}
        />
      )}
    </div>
  )
}

/** No host yet: an administrator's ways to make one, or who may. */
function NoHost({
  accounts,
  allowed,
  release,
  onChanged,
}: {
  accounts: Resource<CloudAccountView[]>
  allowed: Allowed
  release: Release
  onChanged: () => void
}): JSX.Element {
  const [creating, setCreating] = useState<string | undefined>()
  const [installing, setInstalling] = useState(false)
  const ocean = digitalOcean(accounts.data ?? [])
  return (
    <div className="m-card__body m-stack">
      <p className="m-t-callout m-secondary m-nodes__flush">
        A Mason host holds the builds created by the Mason cluster and hosts a
        web interface for downloading iOS, Android, desktop, and other builds.
        If it is internet accessible, it is also the proxy to communicate events
        back to the Mason master, such as GitHub repository change events.
      </p>
      {!allowed.hosts ? (
        <p className="m-t-subhead m-tertiary m-nodes__flush">
          Only an administrator adds or removes the host.
        </p>
      ) : (
        <>
          {accounts.data == null ? (
            accounts.error != null ? (
              <CardError
                what="The cloud accounts"
                message={accounts.error.message}
                retry={accounts.reload}
              />
            ) : (
              <CardLoading label="Loading the cloud accounts" />
            )
          ) : ocean.length === 0 ? (
            <p className="m-t-subhead m-secondary m-nodes__flush">
              Add a DigitalOcean account on the <Link to="/cloud">Cloud</Link>{' '}
              page to create a host there.
            </p>
          ) : null}
          <div className="m-row">
            {ocean.map((account) => (
              <Button
                key={account.id}
                variant="primary"
                icon="add"
                aria-haspopup="dialog"
                onClick={() => setCreating(account.id)}
              >
                Create a host on {account.name}
              </Button>
            ))}
            <Button
              variant="secondary"
              icon="terminal"
              aria-haspopup="dialog"
              onClick={() => setInstalling(true)}
            >
              Install a host yourself
            </Button>
          </div>
          {ocean.map((account) => (
            <CreateHostSheet
              key={account.id}
              account={account}
              open={creating === account.id}
              onClose={() => setCreating(undefined)}
              onCreated={onChanged}
            />
          ))}
          <InstallHostSheet
            open={installing}
            release={release}
            onClose={() => setInstalling(false)}
            onPaired={onChanged}
          />
        </>
      )}
    </div>
  )
}

/** The Host card in every state. */
export function HostCard({
  hosts,
  origin,
  hostNode,
  accounts,
  allowed,
  release,
  onChanged,
}: {
  hosts: Resource<CloudMachine[]>
  /** The host's public origin, from the `host` settings. */
  origin: Resource<{ origin?: string }>
  /** A host paired by hand, if any. */
  hostNode: NodeCard | undefined
  accounts: Resource<CloudAccountView[]>
  allowed: Allowed
  release: Release
  /** The host changed: read it, the nodes and the storage again. */
  onChanged: () => void
}): JSX.Element {
  const cloud = hosts.data ?? []
  const served = origin.data?.origin
  const ready = hosts.data != null && origin.data != null
  const hasHost = cloud.length > 0 || served != null || hostNode != null
  const pill =
    cloud[0] != null ? (
      <StatusPill status={cloud[0].state} />
    ) : hostNode != null ? (
      <StatusPill status={hostNode.status} />
    ) : ready && served == null ? (
      <StatusPill status="no_host" label="No host yet" />
    ) : null
  return (
    <section className="m-card" aria-labelledby="nodes-host-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="cloud" />
          <h2 className="m-t-title3" id="nodes-host-title">
            Host
          </h2>
        </div>
        {pill}
      </header>
      {hosts.error != null || origin.error != null ? (
        <CardError
          what="The host"
          message={(hosts.error ?? origin.error)!.message}
          retry={() => {
            hosts.reload()
            origin.reload()
          }}
        />
      ) : !ready ? (
        <CardLoading label="Loading the host" />
      ) : cloud.length > 0 ? (
        cloud.map((host) => (
          <CloudHost
            key={host.name}
            host={host}
            allowed={allowed}
            onChanged={onChanged}
          />
        ))
      ) : served != null || hostNode != null ? (
        <div className="m-card__body m-stack">
          {hostNode != null && (
            <span className="m-t-mono m-nodes__name">{hostNode.name}</span>
          )}
          {served != null && (
            <span className="m-t-subhead">
              Serves <a href={served}>{served}</a>
            </span>
          )}
          <span className="m-t-subhead m-secondary">
            Installed and paired by hand.
          </span>
        </div>
      ) : (
        <NoHost
          accounts={accounts}
          allowed={allowed}
          release={release}
          onChanged={onChanged}
        />
      )}
      {ready && hasHost && allowed.settings && (
        <div className="m-card__body m-nodes__storage">
          <StorageCard compact />
        </div>
      )}
    </section>
  )
}
