// The Nodes page's shared pieces: a card's loading and error states, a
// request with its busy flag and inline error, the install how-to, and the
// region, size and image fields every cloud sheet takes from its account's
// catalog (text fields when the catalog cannot be read).
import { useRef, useState, type JSX, type RefObject } from 'react'
import {
  asCloudCatalog,
  cloudCatalogPath,
  type CloudAccountView,
  type CloudCatalog,
} from '../../../../shared/api/cloud.js'
import type { CloudMachine } from '../../../../shared/api/nodes.js'
import { useResource, type Resource } from '../../../hooks/useResource.js'
import { Banner } from '../../../ui/Banner.js'
import { Button } from '../../../ui/Button.js'
import { CopyField } from '../../../ui/CopyField.js'
import { FormError, SelectInput, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { SkeletonText } from '../../../ui/Skeleton.js'

/** Who may do what on the page, from the session's permissions. */
export interface Allowed {
  /** Pair and edit nodes (`nodes.change`). */
  nodes: boolean
  /** Make, reconcile, pair and remove the host (`hosts.change`, administrators). */
  hosts: boolean
  /** Cloud nodes, pools and the host's Space (`settings.change`). */
  settings: boolean
}

/** The release the master runs, for the install commands. */
export type Release = { repository: string; version: string } | undefined

/** A card's body while its read is under way. */
export function CardLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="m-card__body">
      <SkeletonText lines={3} label={label} />
    </div>
  )
}

/** A card's body when its read failed: why, and Retry. */
export function CardError({
  what,
  message,
  retry,
}: {
  what: string
  message: string
  retry: () => void
}): JSX.Element {
  return (
    <div className="m-card__body m-stack">
      <FormError>
        {what} could not be read: {message}
      </FormError>
      <div>
        <Button variant="secondary" size="sm" icon="refresh" onClick={retry}>
          Retry
        </Button>
      </div>
    </div>
  )
}

export interface Submit {
  busy: boolean
  failed: string | undefined
  /** The inline error, focused when a request fails. */
  error: RefObject<HTMLParagraphElement | null>
  /** Runs a request: true when it succeeded; a failure stays inline. */
  run: (request: () => Promise<void>) => Promise<boolean>
  clear: () => void
}

/** A request from a sheet or a button: busy while it runs, its failure kept and focused. */
export function useSubmit(): Submit {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  return {
    busy,
    failed,
    error,
    clear: (): void => setFailed(undefined),
    run: async (request): Promise<boolean> => {
      setBusy(true)
      setFailed(undefined)
      try {
        await request()
        return true
      } catch (reason) {
        setFailed((reason as Error).message)
        setTimeout(() => error.current?.focus(), 0)
        return false
      } finally {
        setBusy(false)
      }
    },
  }
}

/** A submit's failure under the fields, if any. */
export function SubmitError({
  submit,
}: {
  submit: Submit
}): JSX.Element | null {
  return submit.failed == null ? null : (
    <FormError ref={submit.error}>{submit.failed}</FormError>
  )
}

/** Comma-separated labels as a list, repeats and blanks dropped. */
export const listOf = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  ),
]

/** A slug: a name, a type or a label as the cloud routes take it. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A node type as a paired node takes it. */
export const NODE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The one line that installs Mason and starts it as `role`, from the master's release. */
export const installCommand = (
  release: { repository: string; version: string },
  role: 'worker' | 'host',
): string =>
  `curl -fsSL https://github.com/${release.repository}/releases/download/v${release.version}/install.sh | bash -s -- --version ${release.version} ${role}`

/** The how-to's first step: install and start Mason as `role`. */
export function InstallStep({
  release,
  role,
  where,
}: {
  release: Release
  role: 'worker' | 'host'
  /** Where to run it: "On the new computer." */
  where: string
}): JSX.Element {
  return (
    <li>
      <div>
        <span className="m-t-headline">
          Install and start Mason as {role === 'host' ? 'the host' : 'a worker'}
        </span>
        {release == null ? (
          <p className="m-t-subhead m-secondary m-nodes__flush">
            This master runs no GitHub release of Mason, so there is no install
            command to give.
          </p>
        ) : (
          <>
            <span className="m-t-subhead m-secondary">
              {where} It installs Mason {release.version}, the master’s version,
              from GitHub, and starts it as a {role} service under your account;
              it asks for your password once.
            </span>
            <CopyField
              block
              value={installCommand(release, role)}
              name={`the ${role} install command`}
            />
            <span className="m-t-subhead m-secondary">
              It prints the pairing key.
            </span>
          </>
        )}
      </div>
    </li>
  )
}

/** A host's DNS name, from its record and domain. */
export const dnsName = (machine: CloudMachine): string | undefined =>
  machine.dns_domain == null || machine.dns_name == null
    ? undefined
    : machine.dns_name === '@'
      ? machine.dns_domain
      : `${machine.dns_name}.${machine.dns_domain}`

/** A machine's place and size: `sfo3 · s-1vcpu-1gb · 203.0.113.5 · Mason 0.6.0`. */
export const machineLine = (
  machine: CloudMachine,
  extra: string[] = [],
): string =>
  [
    ...extra,
    machine.region,
    machine.size,
    machine.address ?? '',
    dnsName(machine) ?? '',
    machine.version == null || machine.state === 'updating'
      ? ''
      : `Mason ${machine.version}`,
  ]
    .filter((part) => part !== '')
    .join(' · ')

/** The notice while a machine updates to the release the master asked for. */
export function UpdatingNotice({
  machine,
}: {
  machine: CloudMachine
}): JSX.Element | null {
  if (machine.state !== 'updating' || machine.version == null) return null
  return (
    <div className="m-callout">
      <Icon name="sync" />
      <span>
        Updating to Mason {machine.version}, as the master asked over its link;
        it reconnects on its own.
      </span>
    </div>
  )
}

/** A machine's error, in the danger colour. */
export function MachineError({
  machine,
}: {
  machine: CloudMachine
}): JSX.Element | null {
  return machine.error == null ? null : (
    <p className="m-t-subhead m-nodes__error">{machine.error}</p>
  )
}

/** The region, size and image a cloud sheet starts with. */
export interface MachineChoice {
  region: string
  size: string
  image: string
}

/** An account's catalog, read while its sheet is open. */
export const useCatalog = (
  account: CloudAccountView,
  open: boolean,
): Resource<CloudCatalog> =>
  useResource(open ? cloudCatalogPath(account.id) : null, asCloudCatalog)

/** Options with a stored value the catalog no longer lists kept first. */
const keeping = (
  value: string,
  options: Array<{ value: string; label: string }>,
): Array<{ value: string; label: string }> =>
  value === '' || options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options]

/** Region, size and image: selects from the catalog, text fields without one. */
export function MachineFields({
  account,
  catalog,
  value,
  onChange,
  imageLabel = 'Image',
}: {
  account: CloudAccountView
  catalog: Resource<CloudCatalog>
  value: MachineChoice
  onChange: (value: MachineChoice) => void
  imageLabel?: string
}): JSX.Element {
  const set =
    (field: keyof MachineChoice) =>
    (next: string): void =>
      onChange({ ...value, [field]: next })
  const data = catalog.data
  if (data == null)
    return (
      <>
        {catalog.error != null && (
          <div className="m-nodes__wide">
            <Banner
              tone="warning"
              compact
              title={`Could not list ${account.name}’s regions and sizes: ${catalog.error.message}`}
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  icon="refresh"
                  onClick={catalog.reload}
                >
                  Retry
                </Button>
              }
            />
          </div>
        )}
        <TextInput
          label="Region"
          value={value.region}
          onChange={set('region')}
          required
          mono
          verbatim
          placeholder="sfo3"
          {...(catalog.loading ? { help: 'Reading the regions…' } : {})}
        />
        <TextInput
          label="Size"
          value={value.size}
          onChange={set('size')}
          required
          mono
          verbatim
          placeholder="s-2vcpu-4gb"
        />
        <TextInput
          label={imageLabel}
          value={value.image}
          onChange={set('image')}
          required
          mono
          verbatim
        />
      </>
    )
  // Sizes the region offers, and the one chosen.
  const sizes = data.sizes.filter(
    (size) =>
      size.slug === value.size ||
      size.regions.length === 0 ||
      size.regions.includes(value.region),
  )
  return (
    <>
      <SelectInput
        label="Region"
        value={value.region}
        onChange={set('region')}
        options={keeping(
          value.region,
          data.regions.map((region) => ({
            value: region.slug,
            label: `${region.name} (${region.slug})`,
          })),
        )}
      />
      <SelectInput
        label="Size"
        value={value.size}
        onChange={set('size')}
        options={keeping(
          value.size,
          sizes.map((size) => ({
            value: size.slug,
            label: `${size.slug} · ${size.description} · $${size.priceMonthly}/month`,
          })),
        )}
      />
      <SelectInput
        label={imageLabel}
        value={value.image}
        onChange={set('image')}
        options={keeping(
          value.image,
          data.images.map((image) => ({
            value: image.slug,
            label: image.name,
          })),
        )}
      />
    </>
  )
}
