import { bytes, platformChip, statusDot } from './dashboard.js'
import { ago, escape, localTime } from './html.js'
import {
  projectRunsTable,
  type BranchItem,
  type ProjectRunRow,
} from './artifacts.js'
import { icon } from './icons.js'
import {
  appRow,
  memberRow,
  sectionRows,
  type GroupApp,
  type GroupPerson,
} from './groups.js'
import { spacesRegions } from '../master/cloud/regions.js'
import { SETUP_LABEL } from '../pipeline/graph.js'

const statusLine =
  '<p class="notice" role="status" data-field="status" hidden></p>'

/** A shell command with a button that copies it. */
const command = (text: string): string =>
  `<div class="command"><pre class="mono">${escape(text)}</pre><button type="button" class="secondary copy" data-copy="${escape(text)}">${icon('content_copy')}<span data-copy-label>Copy</span></button></div>`

/**
 * A disclosure that is a full button: red for adding or using something,
 * `secondary` for Edit and Remove. Open, the button stays as the form's heading.
 */
export function action(
  label: string,
  body: string,
  options: {
    id?: string
    kind?: 'primary' | 'secondary' | 'danger'
    open?: boolean
    className?: string
  } = {},
): string {
  return `<details class="action${options.className == null ? '' : ` ${options.className}`}"${options.id == null ? '' : ` id="${escape(options.id)}"`}${options.open === true ? ' open' : ''}><summary class="button${options.kind === 'secondary' ? ' secondary' : options.kind === 'danger' ? ' danger-fill' : ''}">${label}</summary><div class="action-body">${body}</div></details>`
}

/** A form field: its title, an optional description in smaller text, then the control. */
export function field(
  id: string,
  title: string,
  control: string,
  description?: string,
): string {
  return `<div class="field"><label for="${escape(id)}">${escape(title)}</label>${description == null ? '' : `<small class="hint">${escape(description)}</small>`}${control}</div>`
}

/**
 * A form the shell's script sends to the API as JSON: `fields` names the
 * inputs, dotted names nest (`addresses.google`), and a field named in
 * `json` is parsed as JSON and becomes the whole body.
 */
export function apiForm(
  path: string,
  body: string,
  button: string,
  options: {
    method?: string
    fields?: string[]
    json?: string
    then?: string
    className?: string
  } = {},
): string {
  return `<form data-mason="api" data-path="${escape(path)}"${options.method == null ? '' : ` data-method="${options.method}"`} data-fields="${escape((options.fields ?? []).join(','))}"${options.json == null ? '' : ` data-json="${escape(options.json)}"`}${options.then == null ? '' : ` data-then="${escape(options.then)}"`}>${body}<button${options.className == null ? '' : ` class="${options.className}"`}>${button}</button>${statusLine}</form>`
}

function head(title: string, intro: string, crumbs: string[] = []): string {
  return `<div class="page-head"><div><div class="breadcrumbs">${['Mason', 'Master', ...crumbs].map((part) => `<span>${escape(part)}</span>`).join('<span>/</span>')}</div><h1>${escape(title)}</h1><p>${escape(intro)}</p></div></div>`
}

export interface NodeRow {
  name: string
  fingerprint: string
  role: string
  type: string
  labels: string[]
  slots: number
  status: 'idle' | 'busy' | 'offline'
  stage?: string
  inventory?: {
    os?: string
    arch?: string
    freeDisk?: number
    xcodes?: Array<{ version: string }>
    tools?: Record<string, unknown>
  }
  checklist: Array<{ title?: string; text?: string; done?: boolean }>
  version?: string
}

/** A cloud pool on the Nodes page, with its machines. */
export interface PoolRow {
  name: string
  type: string
  account: string
  region: string
  size: string
  image: string
  labels: string[]
  maxNodes: number
  slots: number
  ttlMinutes: number
  maxHoursPerNode: number
  machines: Array<{ id: number; state: string; address: string | null }>
}

/** An account pools may be made in, with what its provider offers. */
export interface PoolAccount {
  id: string
  name: string
  /** NoMac pools run one Mac with Xcode; DigitalOcean ones pick region, size and image. */
  provider?: 'digitalocean' | 'nomac'
  catalog?: {
    regions: Array<{ slug: string; name: string }>
    sizes: Array<{ slug: string; description: string; priceMonthly: number }>
    images: Array<{ slug: string; name: string }>
  }
  /** Domains the account's DNS holds, for a host's name. */
  domains?: string[]
  /** False when no administrator entered its key: no host is made in it. */
  adminKeyed?: boolean
  /** Why the catalog could not be read. */
  error?: string
}

/** The pool form's fields: selects from the account's catalog, text inputs without one. */
function poolFields(
  prefix: string,
  account: PoolAccount | undefined,
  pool: Partial<PoolRow>,
  editing: boolean,
): string {
  const row = (
    name: string,
    label: string,
    input: string,
    description?: string,
  ): string => field(`${prefix}-${name}`, label, input, description)
  const text = (name: string, value: string, extra = ''): string =>
    `<input id="${prefix}-${name}" name="${name}" value="${escape(value)}"${extra}>`
  const select = (
    name: string,
    value: string,
    options: Array<{ value: string; label: string }>,
  ): string => {
    // A stored value the catalog no longer lists stays selectable.
    const all =
      options.some((option) => option.value === value) || value === ''
        ? options
        : [{ value, label: value }, ...options]
    return `<select id="${prefix}-${name}" name="${name}">${all.map((option) => `<option value="${escape(option.value)}"${option.value === value ? ' selected' : ''}>${escape(option.label)}</option>`).join('')}</select>`
  }
  const catalog = account?.catalog
  // NoMac picks the Mac itself, one at a time for up to eight hours.
  const mac = account?.provider === 'nomac'
  const number = (
    name: string,
    value: number,
    min: number,
    max: number,
  ): string =>
    text(
      name,
      String(value),
      ` type="number" min="${min}" max="${max}" required`,
    )
  return [
    `<input type="hidden" name="account" value="${escape(account?.id ?? pool.account ?? '')}">`,
    editing
      ? ''
      : row(
          'name',
          'Name',
          text(
            'name',
            pool.name ?? (mac ? 'macos-cloud' : ''),
            ' required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="linux-cloud"',
          ),
          'The pool’s name on this master.',
        ),
    row(
      'type',
      'Node type',
      text(
        'type',
        pool.type ?? (mac ? 'macos-arm64' : ''),
        ' required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="linux-x86"',
      ),
      'Type of node as specified in the Masonfile.',
    ),
    mac
      ? '<p><small>NoMac runs one Apple silicon Mac with Xcode at a time, for up to eight hours.</small></p>'
      : '',
    mac
      ? ''
      : row(
          'region',
          'Region',
          catalog == null
            ? text('region', pool.region ?? '', ' required placeholder="sfo3"')
            : select(
                'region',
                pool.region ?? 'sfo3',
                catalog.regions.map((region) => ({
                  value: region.slug,
                  label: `${region.name} (${region.slug})`,
                })),
              ),
        ),
    mac
      ? ''
      : row(
          'size',
          'Size',
          catalog == null
            ? text(
                'size',
                pool.size ?? '',
                ' required placeholder="s-2vcpu-4gb"',
              )
            : select(
                'size',
                pool.size ?? 's-2vcpu-4gb',
                catalog.sizes.map((size) => ({
                  value: size.slug,
                  label: `${size.slug} · ${size.description} · $${size.priceMonthly}/month`,
                })),
              ),
        ),
    mac
      ? ''
      : row(
          'image',
          'Base image',
          catalog == null
            ? text('image', pool.image ?? 'ubuntu-24-04-x64', ' required')
            : select(
                'image',
                pool.image ?? 'ubuntu-24-04-x64',
                catalog.images.map((image) => ({
                  value: image.slug,
                  label: image.name,
                })),
              ),
        ),
    row(
      'labels',
      'Labels',
      text('labels', (pool.labels ?? [SETUP_LABEL]).join(', ')),
      `Labels its machines carry, comma-separated, for stages that ask for them. Machines labelled ${SETUP_LABEL} run setup.`,
    ),
    row(
      'maxNodes',
      'Max machines',
      number('maxNodes', pool.maxNodes ?? 1, 1, mac ? 1 : 50),
      'Spin up no more than max machines concurrently.',
    ),
    row(
      'slots',
      'Stages per machine',
      number('slots', pool.slots ?? 1, 1, 64),
      'How many stages one machine runs at the same time.',
    ),
    row(
      'ttlMinutes',
      'Retire after idle minutes',
      number('ttlMinutes', pool.ttlMinutes ?? 60, 1, 1440),
      'A machine with no stage to run for this many minutes is shut down and deleted.',
    ),
    row(
      'maxHoursPerNode',
      'Retire after hours up',
      number(
        'maxHoursPerNode',
        pool.maxHoursPerNode ?? (mac ? 8 : 24),
        1,
        mac ? 8 : 720,
      ),
      'A machine is replaced after this many hours in total, even if it keeps getting work, so none runs forever. Its current stage finishes first.',
    ),
  ].join('')
}

/** A Mason host the master made on a cloud provider. */
export interface CloudHostView {
  name: string
  state: string
  account: string
  region: string
  size: string
  address: string | null
  origin: string | null
  dnsName?: string
  /** A DNS name's certificate: waiting until it first answers trusted. */
  certificate?: 'waiting' | 'trusted'
  /** Its DigitalOcean Space for builds. */
  space?: { bucket: string; region: string }
  error: string | null
  /** The release it runs, or the one it is updating to. */
  version?: string | null
  /** A permanent node's type and labels. */
  nodeType?: string | null
  labels?: string[]
}

/** DigitalOcean's Spaces regions. */
function spacesRegionSelect(id: string, value: string): string {
  return `<select id="${id}" name="space.region">${spacesRegions.map((region) => `<option${region === value ? ' selected' : ''}>${region}</option>`).join('')}</select>`
}

/** The Create host (or permanent node) form's fields for one account. */
function hostFields(
  account: PoolAccount,
  role: 'host' | 'worker' = 'host',
): string {
  const prefix = `${role === 'host' ? 'host' : 'node'}-${account.id}`
  const catalog = account.catalog
  const select = (
    name: string,
    value: string,
    options: Array<{ value: string; label: string }>,
  ): string =>
    `<select id="${prefix}-${name.replace('dns.', '') === 'domain' ? 'domain' : name}" name="${name}">${options.map((option) => `<option value="${escape(option.value)}"${option.value === value ? ' selected' : ''}>${escape(option.label)}</option>`).join('')}</select>`
  const text = (name: string, value: string, extra = ''): string =>
    `<input id="${prefix}-${name === 'dns.name' ? 'record' : name}" name="${name}" value="${escape(value)}"${extra}>`
  return [
    `<input type="hidden" name="account" value="${escape(account.id)}">`,
    role === 'host'
      ? `<label for="${prefix}-name">Name</label>${text('name', '', ' required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="builds"')}`
      : `${field(`${prefix}-name`, 'Name', text('name', '', ' required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="linux-node"'), 'The node’s name on this master and its droplet’s.')}${field(`${prefix}-type`, 'Node type', text('type', '', ' required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="linux-x86"'), 'Type of node as specified in the Masonfile.')}${field(`${prefix}-labels`, 'Labels', text('labels', SETUP_LABEL), `Labels it carries, comma-separated, for stages that ask for them. A node labelled ${SETUP_LABEL} runs setup.`)}`,
    `<label for="${prefix}-region">Region</label>${
      catalog == null
        ? text('region', 'sfo3', ' required')
        : select(
            'region',
            'sfo3',
            catalog.regions.map((region) => ({
              value: region.slug,
              label: `${region.name} (${region.slug})`,
            })),
          )
    }`,
    `<label for="${prefix}-size">Size</label>${
      catalog == null
        ? text('size', 's-1vcpu-1gb', ' required')
        : select(
            'size',
            's-1vcpu-1gb',
            catalog.sizes.map((size) => ({
              value: size.slug,
              label: `${size.slug} · ${size.description} · $${size.priceMonthly}/month`,
            })),
          )
    }`,
    `<label for="${prefix}-image">Image</label>${
      catalog == null
        ? text('image', 'ubuntu-24-04-x64', ' required')
        : select(
            'image',
            'ubuntu-24-04-x64',
            catalog.images.map((image) => ({
              value: image.slug,
              label: image.name,
            })),
          )
    }`,
    role === 'worker'
      ? ''
      : `<label for="${prefix}-domain">DNS domain</label>${select('dns.domain', '', [{ value: '', label: 'No DNS: serve the droplet’s address' }, ...(account.domains ?? []).map((domain) => ({ value: domain, label: domain }))])}`,
    role === 'worker'
      ? ''
      : `<label for="${prefix}-record">Record name in the domain (or @)</label>${text('dns.name', '', ' placeholder="builds" pattern="@|[a-z0-9.\\-]{1,200}"')}`,
    role === 'worker'
      ? ''
      : `<label for="${prefix}-space">Store builds in a new DigitalOcean Space named (empty: the host’s disk)</label><input id="${prefix}-space" name="space.bucket" placeholder="mason-builds" pattern="[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]">`,
    role === 'worker'
      ? ''
      : `<label for="${prefix}-space-region">Space region</label>${spacesRegionSelect(`${prefix}-space-region`, 'sfo3')}`,
  ].join('')
}

/** Where the host keeps builds: a new Space Mason makes, an existing Space, or the host's disk. */
/** One place builds are stored, as the Storage card lists it. */
export interface StorageLocationView {
  id: string
  kind: 'disk' | 'space'
  active: boolean
  bucket?: string
  region?: string
  origin?: 'made' | 'added' | 'host'
  bucketOwned?: boolean
  host?: string
  usage?: { files: number; bytes: number }
}

/** Where the host keeps builds: a row per location, and adding a Space. */
function storageCard(options: {
  storage?: {
    driver: 'disk' | 's3'
    bucket?: string
    endpoint?: string
    locations?: StorageLocationView[]
  }
  accounts: PoolAccount[]
  heading: 'h2' | 'h3'
}): string {
  const spaceAccounts = options.accounts.filter(
    (account) => account.provider !== 'nomac',
  )
  const useField = (id: string): string =>
    `<label class="check">${checkbox(id, 'use', true)} Use it for new builds</label>`
  // Mason makes the Space and a key that can use only it, from a DigitalOcean account.
  const newSpace =
    spaceAccounts.length === 0
      ? ''
      : action(
          `${icon('add')} Make a new Space`,
          apiForm(
            '/api/v2/storage/space/new',
            `<p><small class="hint">A Space is DigitalOcean’s storage, billed by use from $5 a month for 250 GB, so there is no machine size to choose. Mason makes it and a key that can use only it; it becomes a row above, beside the others.</small></p>${field('new-space-account', 'DigitalOcean account', `<select id="new-space-account" name="account">${spaceAccounts.map((account) => `<option value="${escape(account.id)}">${escape(account.name)}</option>`).join('')}</select>`)}${field('new-space-bucket', 'Space name', '<input id="new-space-bucket" name="bucket" required value="mason-builds" pattern="[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]">', '3 to 63 lowercase letters, digits and dashes; unique across DigitalOcean.')}${field('new-space-region', 'Region', spacesRegionSelect('new-space-region', 'sfo3').replace('name="space.region"', 'name="region"'))}${useField('new-space-use')}`,
            `${icon('storage')} Make the Space`,
            {
              fields: ['account', 'bucket', 'region', 'use'],
              then: 'reload',
            },
          ),
          { id: 'storage-new' },
        )
  const existing = action(
    `${icon('storage')} Add an existing Space`,
    apiForm(
      '/api/v2/storage/space',
      `<label for="storage-url">Space URL</label><input id="storage-url" name="url" required placeholder="https://name.sfo3.digitaloceanspaces.com"><label for="storage-key">Access key</label><input id="storage-key" name="accessKeyId" required autocomplete="off"><label for="storage-secret">Secret</label><input id="storage-secret" name="secretAccessKey" type="password" required autocomplete="off">${useField('storage-use')}<p><small>Mason writes, reads and deletes a check object with the key before saving; a key that cannot is refused and nothing changes.</small></p>`,
      `${icon('check')} Check and add`,
      {
        fields: ['url', 'accessKeyId', 'secretAccessKey', 'use'],
        then: 'reload',
      },
    ),
    { id: 'storage-existing' },
  )
  const storage = options.storage
  const locations: StorageLocationView[] = storage?.locations ?? [
    { id: 'disk', kind: 'disk', active: storage?.driver !== 's3' },
    ...(storage?.driver === 's3' && storage.bucket != null
      ? [
          {
            id: 'current',
            kind: 'space' as const,
            active: true,
            bucket: storage.bucket,
          },
        ]
      : []),
  ]
  const origin = (location: StorageLocationView): string =>
    location.origin === 'made'
      ? 'made by Mason'
      : location.origin === 'host'
        ? location.host == null
          ? 'made for a host'
          : `made for host ${escape(location.host)}`
        : 'added'
  const rows = locations
    .map((location) => {
      const id = encodeURIComponent(location.id)
      const name =
        location.kind === 'disk'
          ? 'Host’s disk'
          : `<span class="mono">${escape(location.bucket ?? '')}</span>${location.region == null ? '' : ` · ${escape(location.region)}`} · ${origin(location)}`
      const files = location.usage?.files
      const use = location.active
        ? `${icon('check_circle')} New builds go here`
        : apiForm(
            location.kind === 'disk'
              ? '/api/v2/storage/disk'
              : `/api/v2/storage/locations/${id}/use`,
            '',
            'Use for new builds',
            { className: 'secondary', then: 'reload' },
          )
      const deletes = location.bucketOwned === true
      const remove =
        location.kind === 'disk' || location.active
          ? ''
          : action(
              `${icon('delete')} ${deletes ? 'Delete' : 'Forget'}`,
              apiForm(
                `/api/v2/storage/locations/${id}`,
                `<p><small>${
                  deletes
                    ? `Deletes the Space ${escape(location.bucket ?? '')} from DigitalOcean with its key, and its ${files ?? 'stored'} builds and artifacts leave Mason.`
                    : `Mason stops using ${escape(location.bucket ?? '')}; the Space and its files stay in DigitalOcean, and its ${files ?? 'stored'} builds and artifacts leave Mason.`
                }</small></p><label for="remove-location-${escape(location.id)}">Type ${escape(location.bucket ?? '')} to ${deletes ? 'delete' : 'forget'} it</label><input id="remove-location-${escape(location.id)}" name="confirm" required autocomplete="off">`,
                `${icon('delete')} ${deletes ? 'Delete the Space' : 'Forget the Space'}`,
                {
                  method: 'DELETE',
                  fields: ['confirm'],
                  className: 'danger-fill',
                  then: 'reload',
                },
              ),
              { kind: 'danger' },
            )
      return `<tr data-location="${escape(location.id)}"><td>${name}</td><td>${use}</td><td>${files == null ? '—' : String(files)}</td><td>${location.usage == null ? '—' : escape(bytes(location.usage.bytes))}</td><td>${remove}</td></tr>`
    })
    .join('')
  const h = options.heading
  return `<section class="panel" id="storage"><${h}>${icon('storage')}Storage</${h}><p>Every place builds are stored. New builds go to one of them; each keeps serving the builds already in it.</p><table class="compact storage-locations"><thead><tr><th>Location</th><th>New builds</th><th>Files</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody></table>${newSpace}${existing}</section>`
}

const poolFieldNames = [
  'account',
  'name',
  'type',
  'region',
  'size',
  'image',
  'labels',
  'maxNodes',
  'slots',
  'ttlMinutes',
  'maxHoursPerNode',
]

/** A node type in a few words: what it installs, not its JSON. */
function typeSummary(value: unknown): string {
  const software =
    ((value ?? {}) as { software?: Partial<NodeTypeView['software']> })
      .software ?? {}
  const count = (items: unknown[] | undefined, word: string): string[] =>
    items == null || items.length === 0
      ? []
      : [`${items.length} ${word}${items.length === 1 ? '' : 's'}`]
  const parts = [
    ...(software.xcode == null || software.xcode.length === 0
      ? []
      : [`Xcode ${software.xcode.join(', ')}`]),
    ...(software.node == null ? [] : [`Node ${software.node}`]),
    ...(software.java == null ? [] : [`Java ${software.java}`]),
    ...(software.rust == null ? [] : [`Rust ${software.rust}`]),
    ...(software.python == null ? [] : [`Python ${software.python}`]),
    ...(software.go == null ? [] : [`Go ${software.go}`]),
    ...(software.ruby == null ? [] : [`Ruby ${software.ruby}`]),
    ...count(
      [...(software.brew?.formulae ?? []), ...(software.brew?.casks ?? [])],
      'Homebrew package',
    ),
    ...count(
      [...(software.apt ?? []), ...(software.dnf ?? [])],
      'Linux package',
    ),
    ...count(software.android, 'Android package'),
    ...(software.docker === true ? ['Docker'] : []),
  ]
  return parts.length === 0 ? 'Nothing managed yet' : parts.join(' · ')
}

/** Nodes: status, type, current stage, inventory and checklist; node types; cloud pools and their budget; adding a node. */
export function nodesView(data: {
  nodes: NodeRow[]
  types: Record<string, unknown>
  pools: PoolRow[]
  /** Accounts pools and hosts may be made in. */
  poolAccounts?: PoolAccount[]
  /** Hosts the master made on a cloud provider. */
  cloudHosts?: CloudHostView[]
  /** Permanent worker nodes the master made on a cloud provider. */
  cloudNodes?: CloudHostView[]
  /** Where the host keeps builds. */
  storage?: {
    driver: 'disk' | 's3'
    bucket?: string
    endpoint?: string
    locations?: StorageLocationView[]
  }
  budget: { monthly: number; notice?: string }
  host?: string
  /** The master's own release, installable from GitHub when no host serves one. */
  release?: { repository: string; version: string }
  canChange: boolean
  /** Whether the viewer may pair, make or remove the host (administrators). */
  canChangeHosts?: boolean
}): string {
  const rows = data.nodes
    .map((node) => {
      const tools = Object.entries(node.inventory?.tools ?? {})
        .map(
          ([name, value]) =>
            `${name} ${Array.isArray(value) ? value.join(', ') : String((value as { version?: string })?.version ?? value)}`,
        )
        .slice(0, 6)
        .join(' · ')
      const xcodes = (node.inventory?.xcodes ?? [])
        .map((entry) => entry.version)
        .join(', ')
      // Its name, type, labels and slots; a host has only a name to set.
      const id = `node-${node.fingerprint.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`
      const worker = node.role === 'worker'
      const edit = data.canChange
        ? action(
            `${icon('edit')} Edit`,
            apiForm(
              `/api/v2/nodes/${encodeURIComponent(node.fingerprint)}`,
              `${field(`${id}-name`, 'Name', `<input id="${id}-name" name="name" required maxlength="128" value="${escape(node.name)}">`)}${
                worker
                  ? `${field(`${id}-type`, 'Node type', `<input id="${id}-type" name="type" value="${escape(node.type)}" pattern="([A-Za-z0-9][A-Za-z0-9._\\-]{0,63})?">`, 'The type a Masonfile selects it by.')}${field(`${id}-labels`, 'Labels', `<input id="${id}-labels" name="labels" data-kind="list" value="${escape(node.labels.join(', '))}">`, `Comma-separated, for stages that ask for them. A node labelled ${SETUP_LABEL} runs setup; a dedicated node leaves it out.`)}${field(`${id}-slots`, 'Slots', `<input id="${id}-slots" name="slots" type="number" data-kind="number" min="1" max="64" value="${node.slots}">`, 'Stages it runs at a time.')}`
                  : ''
              }`,
              `${icon('edit')} Save`,
              {
                method: 'PUT',
                fields: worker ? ['name', 'type', 'labels', 'slots'] : ['name'],
                then: 'reload',
              },
            ),
            { kind: 'secondary' },
          )
        : ''
      return `<article class="panel node"><h2>${statusDot(node.status === 'busy' ? 'running' : node.status === 'idle' ? 'succeeded' : 'cancelled')}<span class="mono">${escape(node.name)}</span> <small>${[
        node.role,
        node.type,
        node.role === 'worker'
          ? `${node.slots} slot${node.slots === 1 ? '' : 's'}`
          : '',
        node.labels.join(', '),
      ]
        .filter((part) => part !== '')
        .map(escape)
        .join(
          ' · ',
        )}</small></h2><p>${escape(node.status)}${node.stage == null ? '' : ` · running <span class="mono">${escape(node.stage)}</span>`}${node.version == null ? '' : ` · Mason ${escape(node.version)}`}${node.inventory?.os == null ? '' : ` · ${escape(node.inventory.os)} ${escape(node.inventory.arch ?? '')}`}${node.inventory?.freeDisk == null ? '' : ` · ${escape(bytes(node.inventory.freeDisk))} free`}</p>${xcodes === '' ? '' : `<p>Xcode ${escape(xcodes)}</p>`}${tools === '' ? '' : `<p class="mono">${escape(tools)}</p>`}${
        node.checklist.length === 0
          ? ''
          : `<h3>Checklist</h3><ul class="plain checklist">${node.checklist.map((item) => `<li>${icon(item.done === true ? 'check_circle' : 'warning')} ${escape(item.title ?? item.text ?? '')}</li>`).join('')}</ul>`
      }${edit}</article>`
    })
    .join('')
  /** One line that installs Mason and starts it as `role`, from the master's release on GitHub. */
  const installCommand = (role: 'worker' | 'host'): string =>
    data.release != null
      ? command(
          `curl -fsSL https://github.com/${data.release.repository}/releases/download/v${data.release.version}/install.sh | bash -s -- --version ${data.release.version} ${role}`,
        )
      : '<p>This master runs no GitHub release of Mason, so there is no install command to give.</p>'
  const installFrom =
    data.release != null
      ? `It installs Mason ${escape(data.release.version)}, the master’s version, from GitHub,`
      : ''
  /** A numbered step: its title on its own line, then what to do. */
  const step = (title: string, body: string): string =>
    `<li><strong>${title}</strong>${body}</li>`
  const installStep = (
    title: string,
    where: string,
    role: 'worker' | 'host',
  ): string =>
    step(
      title,
      `<small class="hint">${where} ${installFrom} and starts it as a ${role} service under your account; it asks for your password once.</small>${installCommand(role)}<small class="hint">It prints the pairing key.</small>`,
    )
  const pairForm = (
    prefix: string,
    placeholder: string,
    button: string,
    worker = false,
  ): string =>
    apiForm(
      '/api/v2/nodes',
      `${field(`${prefix}-address`, 'Mason node address and port', `<input id="${prefix}-address" name="address" placeholder="${placeholder}" required>`)}${field(`${prefix}-key`, 'Pairing key', `<input id="${prefix}-key" name="key" placeholder="mason1:…" required autocomplete="off">`)}${
        // A worker may be paired with its type and labels, so a dedicated one never runs setup.
        worker
          ? `${field(`${prefix}-type`, 'Node type', `<input id="${prefix}-type" name="type" data-optional placeholder="linux-x86" pattern="([A-Za-z0-9][A-Za-z0-9._\\-]{0,63})?">`, 'Optional: the type a Masonfile selects it by.')}${field(`${prefix}-labels`, 'Labels', `<input id="${prefix}-labels" name="labels" data-kind="list" value="${SETUP_LABEL}">`, `Comma-separated. A node labelled ${SETUP_LABEL} runs setup; a dedicated node leaves it out.`)}`
          : ''
      }`,
      button,
      {
        fields: worker
          ? ['address', 'key', 'type', 'labels']
          : ['address', 'key'],
        then: 'reload',
      },
    )
  const cloudHosts = (data.cloudHosts ?? [])
    .map(
      (host) =>
        `<section class="panel cloud-host" id="host-${escape(host.name)}" data-state="${escape(host.state)}"><h3>${icon('cloud')}<span class="mono">${escape(host.name)}</span> <small>${escape(host.state)}</small></h3><p>${escape(host.region)} · ${escape(host.size)}${host.address == null ? '' : ` · <span class="mono">${escape(host.address)}</span>`}${host.dnsName == null ? '' : ` · <span class="mono">${escape(host.dnsName)}</span>`}${host.version == null || host.state === 'updating' ? '' : ` · Mason ${escape(host.version)}`}</p>${host.state === 'updating' && host.version != null ? `<p class="notice">Updating to Mason ${escape(host.version)}, as the master asked over its link; it reconnects on its own.</p>` : ''}${host.origin == null ? '' : `<p>Serves <a href="${escape(host.origin)}">${escape(host.origin)}</a></p>`}${host.certificate === 'waiting' ? '<p class="notice">Waiting for its certificate: Caddy asks Let’s Encrypt once the DNS name resolves.</p>' : ''}${host.space == null ? '' : `<p>Builds Space <span class="mono">${escape(host.space.bucket)}</span> (${escape(host.space.region)})</p>`}${host.error == null ? '' : `<p class="state-failed">${escape(host.error)}</p>`}${
          data.canChange
            ? `${host.space == null ? action(`${icon('storage')} Store builds in a new DigitalOcean Space`, apiForm(`/api/v2/cloud/hosts/${encodeURIComponent(host.name)}/space`, `<label for="space-${escape(host.name)}">Space name</label><input id="space-${escape(host.name)}" name="bucket" required value="mason-${escape(host.name)}" pattern="[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]"><label for="space-region-${escape(host.name)}">Space region</label>${spacesRegionSelect(`space-region-${escape(host.name)}`, host.region).replace('name="space.region"', 'name="region"')}<p><small>Mason makes the Space and a key that can use only it. New builds are stored there; earlier ones stay where they are.</small></p>`, `${icon('storage')} Make the Space`, { fields: ['bucket', 'region'] })) : ''}${data.canChangeHosts !== true ? '' : `<div class="actions">${apiForm(`/api/v2/cloud/hosts/${encodeURIComponent(host.name)}/reconcile`, '', `${icon('refresh')} Reconcile`, { className: 'secondary' })}${action(`${icon('delete')} Remove`, apiForm(`/api/v2/cloud/hosts/${encodeURIComponent(host.name)}`, `<label for="remove-${escape(host.name)}">Type ${escape(host.name)} to destroy its droplet and unpair it</label><input id="remove-${escape(host.name)}" name="confirm" required autocomplete="off">${host.space == null ? '' : `<label for="remove-space-${escape(host.name)}">Its Space ${escape(host.space.bucket)}</label><select id="remove-space-${escape(host.name)}" name="deleteSpace"><option value="keep">Keep the Space and its builds as a storage location</option><option value="delete">Also delete the Space and every build in it</option></select>`}`, `${icon('delete')} Remove host`, { method: 'DELETE', fields: host.space == null ? ['confirm'] : ['confirm', 'deleteSpace'], className: 'danger-fill' }), { kind: 'danger' })}</div>`}`
            : ''
        }</section>`,
    )
    .join('')
  const hostCommands = `<ol class="howto">${installStep('Install and start Mason as the host', 'On a computer the internet can reach.', 'host')}${step('Pair it here', `<small class="hint">To put the host behind TLS on port 443, see the README’s public-server command.</small>${pairForm('host', 'builds.example.com:9310', `${icon('lan')} Pair host`)}`)}</ol>`
  // Hosts run on DigitalOcean; a NoMac account makes only pool Macs.
  const hostAccounts = (data.poolAccounts ?? [])
    .filter((account) => account.provider !== 'nomac')
    .map((account) =>
      action(
        `${icon('cloud')} Create a host on ${escape(account.name)}`,
        account.adminKeyed === false
          ? `<p class="notice">An administrator must replace this account’s key (<a href="/cloud#account-${escape(account.id)}">Replace key</a> on the Cloud page) before a host is made in it: whoever holds the account holds the host.</p>`
          : `${account.error == null ? '' : `<p class="notice">${escape(account.error)}</p>`}${apiForm('/api/v2/cloud/hosts', hostFields(account), `${icon('add')} Create host`, { fields: ['account', 'name', 'region', 'size', 'image', 'dns.domain', 'dns.name', 'space.bucket', 'space.region'] })}`,
        { id: `add-host-${account.id}`, className: 'add-host' },
      ),
    )
    .join('')
  const storagePanel =
    !data.canChange || (data.host == null && cloudHosts === '')
      ? ''
      : storageCard({
          ...(data.storage == null ? {} : { storage: data.storage }),
          accounts: data.poolAccounts ?? [],
          heading: 'h3',
        })
  const hostPanel =
    !data.canChange && cloudHosts === ''
      ? ''
      : `<section class="panel" id="hosts"><h2>${icon('cloud')}Host</h2><p>A Mason host holds the builds created by the Mason cluster and hosts a web interface for downloading iOS, Android, desktop, and other builds. If it is internet accessible, it is also the proxy to communicate events back to the Mason master, such as GitHub repository change events.</p>${cloudHosts}${
          data.canChange && cloudHosts === '' && data.host == null
            ? data.canChangeHosts !== true
              ? '<p>Only an administrator adds or removes the host.</p>'
              : `${hostAccounts || '<p>Add a DigitalOcean account on the <a href="/cloud">Cloud</a> page to create a host there.</p>'}${action(`${icon('terminal')} Install a host yourself`, hostCommands, { id: 'add-host-command', className: 'add-host' })}`
            : ''
        }${storagePanel}</section>`
  const cloudNodes = (data.cloudNodes ?? [])
    .map(
      (node) =>
        `<section class="panel cloud-node" id="cloud-node-${escape(node.name)}" data-state="${escape(node.state)}"><h3>${icon('cloud')}<span class="mono">${escape(node.name)}</span> <small>${escape(node.state)}</small></h3><p>${[
          node.nodeType ?? '',
          ...(node.labels ?? []),
        ]
          .filter((part) => part !== '')
          .map(escape)
          .join(
            ' · ',
          )} · ${escape(node.region)} · ${escape(node.size)}${node.address == null ? '' : ` · <span class="mono">${escape(node.address)}</span>`}${node.version == null || node.state === 'updating' ? '' : ` · Mason ${escape(node.version)}`}</p>${node.state === 'updating' && node.version != null ? `<p class="notice">Updating to Mason ${escape(node.version)}, as the master asked over its link; it reconnects on its own.</p>` : ''}${node.error == null ? '' : `<p class="state-failed">${escape(node.error)}</p>`}${
          data.canChange
            ? `<div class="actions">${apiForm(`/api/v2/cloud/nodes/${encodeURIComponent(node.name)}/reconcile`, '', `${icon('refresh')} Reconcile`, { className: 'secondary' })}${action(`${icon('delete')} Remove`, apiForm(`/api/v2/cloud/nodes/${encodeURIComponent(node.name)}`, `<label for="remove-node-${escape(node.name)}">Type ${escape(node.name)} to destroy its droplet and unpair it</label><input id="remove-node-${escape(node.name)}" name="confirm" required autocomplete="off">`, `${icon('delete')} Remove node`, { method: 'DELETE', fields: ['confirm'], className: 'danger-fill' }), { kind: 'danger' })}</div>`
            : ''
        }</section>`,
    )
    .join('')
  // Permanent nodes run on DigitalOcean; NoMac Macs come only from pools.
  const nodeAccounts = (data.poolAccounts ?? [])
    .filter((account) => account.provider !== 'nomac')
    .map((account) =>
      action(
        `${icon('cloud')} Create a node on ${escape(account.name)}`,
        `<p>A DigitalOcean machine that stays a worker until you remove it. It needs no public address: only this master reaches it, on its link port.</p>${account.error == null ? '' : `<p class="notice">${escape(account.error)}</p>`}${apiForm('/api/v2/cloud/nodes', hostFields(account, 'worker'), `${icon('add')} Create node`, { fields: ['account', 'name', 'type', 'labels', 'region', 'size', 'image'], then: 'reload' })}`,
        { id: `add-node-${account.id}`, className: 'add-node' },
      ),
    )
    .join('')
  const add = data.canChange
    ? `<section class="panel" id="add-node"><h2>${icon('add')}Nodes</h2><p>Add a node, which Mason can use for building, signing, and testing apps, or any other pipeline tasks. Run the following commands to start Mason on a Linux or macOS computer (Windows coming).</p>${cloudNodes}<ol class="howto">${installStep('Install and start Mason as a worker', 'On the new computer.', 'worker')}${step('Pair it here', pairForm('node', '192.168.1.20:9310', `${icon('lan')} Pair node`, true))}</ol>${nodeAccounts}</section>`
    : cloudNodes === ''
      ? ''
      : `<section class="panel" id="add-node"><h2>${icon('cloud')}Cloud nodes</h2>${cloudNodes}</section>`
  const types = Object.entries(data.types)
    .map(
      ([name, value]) =>
        `<li><span class="mono">${escape(name)}</span> <small>${escape(typeSummary(value))}</small></li>`,
    )
    .join('')
  const accounts = data.poolAccounts ?? []
  const pools = data.pools
    .map((pool) => {
      const account = accounts.find((entry) => entry.id === pool.account)
      const machines = pool.machines
        .map(
          (machine) =>
            `<li><span class="mono">${escape(String(machine.id))}</span> ${escape(machine.state)}${machine.address == null ? '' : ` · <span class="mono">${escape(machine.address)}</span>`}</li>`,
        )
        .join('')
      return `<section class="panel pool" id="pool-${escape(pool.name)}"><h3>${icon('cloud')}<span class="mono">${escape(pool.name)}</span></h3><p>${escape(pool.type)} · ${escape(account?.name ?? pool.account)} · ${escape(pool.region)} · ${escape(pool.size)}${pool.labels.length === 0 ? '' : ` · ${escape(pool.labels.join(', '))}`}</p><p>${pool.machines.length} of at most ${pool.maxNodes} machine${pool.maxNodes === 1 ? '' : 's'} · ${pool.slots} stage${pool.slots === 1 ? '' : 's'} at a time · retire after ${pool.ttlMinutes} idle minutes or ${pool.maxHoursPerNode} hours</p>${machines === '' ? '' : `<ul class="plain">${machines}</ul>`}${
        data.canChange
          ? `${action(`${icon('edit')} Edit`, apiForm(`/api/v2/cloud/pools/${encodeURIComponent(pool.name)}`, poolFields(`pool-${pool.name}`, account, pool, true), `${icon('check')} Save`, { method: 'PUT', fields: poolFieldNames.filter((name) => name !== 'name') }), { kind: 'secondary' })}<div class="actions">${apiForm(`/api/v2/cloud/pools/${encodeURIComponent(pool.name)}`, '', `${icon('delete')} Remove`, { method: 'DELETE', className: 'secondary' })}</div>`
          : ''
      }</section>`
    })
    .join('')
  const addPool = !data.canChange
    ? ''
    : accounts.length === 0
      ? '<p>Add a DigitalOcean or NoMac account on the <a href="/cloud">Cloud</a> page to make pools.</p>'
      : accounts
          .map((account) =>
            action(
              `${icon('add')} Add a pool on ${escape(account.name)}`,
              `${account.error == null ? '' : `<p class="notice">${escape(account.error)}</p>`}${apiForm('/api/v2/cloud/pools', poolFields(`new-${account.id}`, account, {}, false), `${icon('add')} Add pool`, { fields: poolFieldNames })}`,
              { id: `add-pool-${account.id}`, className: 'add-pool' },
            ),
          )
          .join('')
  const poolsPanel = `<section class="panel" id="pools"><h2>${icon('cloud')}Cloud pools</h2><p>Machines made on demand for a node type, reused like your own computers and retired when idle. Monthly budget: $${data.budget.monthly}.</p>${data.budget.notice == null ? '' : `<p class="notice">${escape(data.budget.notice)}</p>`}${pools || '<p>None yet.</p>'}${addPool}</section>`
  return `${head('Nodes', 'Workers and the host, their software, and what each still needs from a person.', ['Nodes'])}${rows || '<p class="empty-state">No nodes are paired.</p>'}<div class="columns"><div>${hostPanel}${add}${poolsPanel}</div><aside><section class="panel"><h2>${icon('tune')}Node types</h2><ul class="plain">${types || '<li>None yet.</li>'}</ul><p><a href="/settings#nodeTypes">Edit in Settings</a></p></section></aside></div>`
}

/** Settings: every area the master keeps, edited as JSON with secrets write-only, plus the Apple ID session. */
/** Each team's signing: set up, being set up, or why not; and checking again. */
function signing(
  setup: NonNullable<Parameters<typeof settingsView>[0]['apple']['setup']>,
  failures: Record<string, string>,
  settingUp: string[],
): string {
  if (setup.error != null)
    return `<p class="state-failed">${escape(setup.error)}</p>`
  const configured = new Map(setup.configured.map((team) => [team.id, team]))
  // The Apple ID's teams, then any set up before that it no longer lists.
  const teams = [
    ...setup.teams,
    ...setup.configured.filter(
      (team) => !setup.teams.some((entry) => entry.id === team.id),
    ),
  ]
  const state = (team: { id: string; name: string }): string => {
    const label = `${escape(team.name)} (<span class="mono">${escape(team.id)}</span>)`
    const done = configured.get(team.id)
    if (settingUp.includes(team.id))
      return `<p class="state-running">${icon('hourglass_top')} Setting signing up for ${label}…</p>`
    // A team not set up, or whose setup failed, has its own button.
    const button = apiForm(
      '/api/v2/apple/setup',
      `<input type="hidden" name="team" value="${escape(team.id)}">`,
      `${icon('key')} Set up ${escape(team.name)}`,
      { fields: ['team'], then: 'reload' },
    )
    if (failures[team.id] != null)
      return `<div><p class="state-failed">${icon('error')} ${escape(failures[team.id]!)}</p>${button}</div>`
    if (done == null)
      return `<div><p>Signing is not set up for ${label}.</p>${button}</div>`
    return `<p class="state-succeeded">${icon('check')} Signing is set up for ${label}: App Store Connect API key <span class="mono">${escape(setup.keyName)}</span> (<span class="mono">${escape(done.keyId)}</span>), ${done.certificate == null ? 'no distribution certificate yet' : `${escape(done.certificate.name)}, expires ${new Date(done.certificate.expiresAt).toISOString().slice(0, 10)}`}.</p>`
  }
  const listed =
    failures[''] == null
      ? ''
      : `<p class="state-failed">${icon('error')} ${escape(failures['']!)}</p>`
  const intro = `<p>When the Apple ID signs in, Mason sets up its team by itself: it makes the team’s App Store Connect API key <span class="mono">${escape(setup.keyName)}</span> and its distribution certificate, and keeps them. With several teams, it sets up by itself only those this master already uses, with a stored key or an app ID assigned to them; set up another here. Checking again asks Apple about a team’s key and certificate and replaces only one that is gone; nothing that still works is revoked.</p>`
  if (setup.teams.length === 0)
    return `${listed}${teams.map(state).join('')}${intro}<p>This Apple ID belongs to no developer team.</p>`
  return `${listed}${teams.map(state).join('')}${intro}${apiForm('/api/v2/apple/setup', `<label for="apple-team">Team</label><select id="apple-team" name="team">${setup.teams.map((team) => `<option value="${escape(team.id)}">${escape(team.name)} (${escape(team.id)})</option>`).join('')}</select>`, `${icon('refresh')} Check signing again`, { fields: ['team'], then: 'reload', className: 'secondary' })}`
}

export function settingsView(data: {
  apple: {
    signedIn: boolean
    appleId?: string
    needsCode: boolean
    notice?: string
    /** Setup from the signed-in Apple ID: its teams, or why they could not be read. */
    setup?: {
      keyName: string
      teams: Array<{ id: string; name: string }>
      /** Teams with a stored key: the key, and the distribution certificate held. */
      configured: Array<{
        id: string
        name: string
        keyId: string
        certificate?: { name: string; expiresAt: number }
      }>
      error?: string
    }
    /** Why each team's last setup failed, by team ID ('' when its teams could not be read). */
    failures?: Record<string, string>
    /** Teams being set up now. */
    settingUp?: string[]
  }
  keys: Array<{
    id: string
    name: string
    role: string
    createdAt: number
    revoked: boolean
    /** `builder` for a key imported from the builder, whose token has no id in it. */
    format?: 'v1' | 'builder'
  }>
  /** How Mason reaches GitHub, without its secrets. */
  github?: {
    kind?: string
    appId?: number
    installationId?: number
    publicKey?: string
  }
  host?: { origin?: string; workerOrigin?: string; offlineGraceHours?: number }
  storage?: {
    driver: 'disk' | 's3'
    bucket?: string
    endpoint?: string
    locations?: StorageLocationView[]
  }
  /** DigitalOcean accounts a new Space can be made in. */
  storageAccounts?: PoolAccount[]
  /** Sign-in methods, without their client secrets. */
  signIn?: SignInMethodView[]
  /** The master's own public origin, for sign-in on its pages. */
  master?: { origin?: string }
  /** The cloud pools' monthly budget in dollars. */
  monthlyBudget?: number
  /** Node types: the software and settings every node of a type keeps. */
  nodeTypes?: Record<string, NodeTypeView>
  canChange: boolean
  /** Whether the viewer may change sign-in methods and addresses (administrators). */
  canChangeSignIn?: boolean
  canCreate: boolean
  canRevoke: boolean
}): string {
  // Signed in, the form waits behind "Sign in again", the Apple ID filled in.
  const signInForm = apiForm(
    '/api/v2/apple/session',
    `<label for="apple-id">Apple ID</label><input id="apple-id" name="appleId" type="email" autocomplete="username" required value="${escape(data.apple.appleId ?? '')}"><label for="apple-password">Password</label><input id="apple-password" name="password" type="password" autocomplete="current-password" required>`,
    `${icon('login')} Sign in`,
    { fields: ['appleId', 'password'], then: 'reload' },
  )
  const signIn = data.apple.signedIn
    ? `<details class="reveal"><summary class="button secondary">${icon('login')} Sign in again</summary>${signInForm}</details>`
    : signInForm
  const apple = `<section class="panel" id="apple-session"><h2>${icon('key')}Apple ID for Xcode downloads</h2><p>${data.apple.signedIn ? `Signed in as ${escape(data.apple.appleId ?? 'the Apple ID')}.` : 'Not signed in.'}</p>${data.apple.notice == null ? '' : `<p class="notice">${escape(data.apple.notice)}</p>`}${
    data.canChange
      ? data.apple.needsCode
        ? apiForm(
            '/api/v2/apple/session/code',
            '<label for="apple-code">Two-factor code</label><input id="apple-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>',
            `${icon('lock')} Send code to the master`,
            { fields: ['code'], then: 'reload' },
          )
        : signIn
      : ''
  }${
    data.canChange && data.apple.signedIn && data.apple.setup != null
      ? `<h3>${icon('key')}Signing for a team</h3>${signing(data.apple.setup, data.apple.failures ?? {}, data.apple.settingUp ?? [])}`
      : // Signed out, a team whose setup failed is still shown.
        Object.values(data.apple.failures ?? {})
          .map((failure) => `<p class="notice">${escape(failure)}</p>`)
          .join('')
  }</section>`
  /** The key's creation day, in the master's time zone. */
  const day = (ms: number): string => {
    const date = new Date(ms)
    const two = (n: number): string => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  }
  // A v1 token is mason_v1_<id>.<secret>: its id's first characters name it without the secret.
  const keyPrefix = (key: (typeof data.keys)[number]): string => {
    if (key.format === 'builder') return '<small>builder key</small>'
    const prefix = `mason_v1_${key.id.slice(0, 5)}…`
    return `<button type="button" class="secondary copy icon-only" data-copy="${escape(prefix)}" aria-label="Copy ${escape(prefix)}">${icon('content_copy')}<span data-copy-label hidden>Copy</span></button><span class="mono">${escape(prefix)}</span>`
  }
  const roles = ['developer', 'tester', 'manager', 'admin']
  const createKey = data.canCreate
    ? action(
        `${icon('add')} Create API key`,
        apiForm(
          '/api/v2/keys',
          `${field('key-name', 'Name', '<input id="key-name" name="name" required maxlength="120" placeholder="ci-uploads">', 'What uses it, so you can find it later.')}${field('key-role', 'Role', `<select id="key-role" name="role">${roles.map((role) => `<option value="${role}">${role}</option>`).join('')}</select>`, 'What it may do: the same as a person with that role.')}<div data-field="token" hidden><p class="notice">Copy it now. Mason stores only a hash of it and cannot show it again. If it is lost, revoke it and create a new one.</p><div class="command"><pre class="mono"></pre><button type="button" class="secondary copy" data-copy="">${icon('content_copy')}<span data-copy-label>Copy</span></button></div><p><a href="/settings?key=created#keys">Done</a></p></div>`,
          `${icon('key')} Create key`,
          { fields: ['name', 'role'], then: 'token' },
        ),
        { id: 'create-key' },
      )
    : ''
  const keys = `<section class="panel" id="keys"><h2>${icon('key')}API keys</h2><p>Create API keys to access Mason from other apps and agents.</p>${createKey}<table class="list compact"><thead><tr><th>Name</th><th>Role</th><th>Created</th><th>State</th><th>Key</th><th></th></tr></thead><tbody>${
    data.keys
      .map(
        (key) =>
          `<tr><td class="mono">${escape(key.name)}</td><td>${escape(key.role)}</td><td>${day(key.createdAt)}</td><td>${key.revoked ? 'revoked' : 'active'}</td><td>${keyPrefix(key)}</td><td>${data.canRevoke && !key.revoked ? apiForm(`/api/v2/keys/${encodeURIComponent(key.id)}`, '', 'Revoke', { method: 'DELETE', then: 'reload', className: 'danger' }) : ''}</td></tr>`,
      )
      .join('') || '<tr><td colspan="6">No keys.</td></tr>'
  }</tbody></table></section>`
  const cards = data.canChange ? settingsCards(data) : ''
  return `${head('Settings', 'How this master signs people in, reaches GitHub and Apple, keeps its backups and runs its nodes.', ['Settings'])}<p><a href="/people">People</a> · <a href="/groups">Groups</a> · <a href="/backups">Backups</a> · <a href="/nodes">Nodes</a></p>${apple}${keys}${cards}`
}

/** A sign-in method as Settings shows it: every field but the client secret. */
export interface SignInMethodView {
  id: string
  type: 'oidc' | 'oauth2'
  name: string
  issuer: string
  clientId: string
  enabled: boolean
  admitTesters?: boolean
  authentication?: 'post' | 'basic'
  signingAlgorithm?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userinfoEndpoint?: string
  scopes?: string[]
  claims?: {
    subject?: string
    name?: string
    email?: string
    emailVerified?: string
  }
}

/** A text input; `extra` holds its attributes. */
const input = (id: string, name: string, value: string, extra = ''): string =>
  `<input id="${escape(id)}" name="${escape(name)}" value="${escape(value)}"${extra}>`
const select = (
  id: string,
  name: string,
  value: string,
  options: Array<[string, string]>,
): string =>
  `<select id="${escape(id)}" name="${escape(name)}">${options.map(([option, label]) => `<option value="${escape(option)}"${option === value ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>`
const checkbox = (id: string, name: string, checked: boolean): string =>
  `<input id="${escape(id)}" name="${escape(name)}" type="checkbox" data-kind="checkbox"${checked ? ' checked' : ''}>`

/** One sign-in method's form: only the fields its type takes. */
function signInForm(
  method: SignInMethodView | undefined,
  type: 'oidc' | 'oauth2',
): string {
  // Existing methods and the Add forms use different prefixes, so no ID a person picks collides.
  const p = method == null ? `signin-new-${type}` : `signin-edit-${method.id}`
  const v = (value: string | undefined): string => value ?? ''
  const fields = [
    method == null
      ? field(
          `${p}-id`,
          'ID',
          input(
            `${p}-id`,
            'id',
            '',
            ' required pattern="[a-z][a-z0-9\\-]*" maxlength="64" placeholder="google"',
          ),
          'A short name in the sign-in URL: lowercase letters, digits and dashes.',
        )
      : '',
    `<input type="hidden" name="type" value="${type}">${method == null ? '<input type="hidden" name="create" value="yes">' : ''}`,
    field(
      `${p}-enabled`,
      'Enabled',
      checkbox(`${p}-enabled`, 'enabled', method?.enabled ?? true),
      'Offered on the sign-in page. A disabled method stays configured.',
    ),
    field(
      `${p}-admitTesters`,
      'Admit as testers',
      checkbox(
        `${p}-admitTesters`,
        'admitTesters',
        method?.admitTesters === true,
      ),
      'A verified sign-in creates a tester account that can install every app.',
    ),
    field(
      `${p}-name`,
      'Display name',
      input(
        `${p}-name`,
        'name',
        v(method?.name),
        ' required maxlength="80" placeholder="Google"',
      ),
      'The button people see: Sign in with this.',
    ),
    field(
      `${p}-issuer`,
      'Issuer URL',
      input(
        `${p}-issuer`,
        'issuer',
        v(method?.issuer),
        ' required type="url" pattern="https://.*" placeholder="https://accounts.google.com"',
      ),
      'The provider’s https address.',
    ),
    field(
      `${p}-clientId`,
      'Client ID',
      input(
        `${p}-clientId`,
        'clientId',
        v(method?.clientId),
        ' required maxlength="256"',
      ),
      'From the app you registered with the provider.',
    ),
    field(
      `${p}-clientSecret`,
      'Client secret',
      `<input id="${p}-clientSecret" name="clientSecret" type="password" data-kind="secret" autocomplete="off"${method == null ? ' required' : ' placeholder="Leave empty to keep the stored secret"'}>`,
      'Write-only: it is never shown again.',
    ),
    field(
      `${p}-authentication`,
      'Client authentication',
      select(
        `${p}-authentication`,
        'authentication',
        method?.authentication ?? 'post',
        [
          ['post', 'In the request body (post)'],
          ['basic', 'HTTP Basic (basic)'],
        ],
      ),
      'How Mason sends the client secret to the token endpoint.',
    ),
    ...(type === 'oidc'
      ? [
          field(
            `${p}-signingAlgorithm`,
            'Signing algorithm',
            select(
              `${p}-signingAlgorithm`,
              'signingAlgorithm',
              method?.signingAlgorithm ?? 'RS256',
              [
                ['RS256', 'RS256'],
                ['ES256', 'ES256'],
                ['EdDSA', 'EdDSA'],
              ],
            ),
            'How the provider signs its ID tokens.',
          ),
        ]
      : [
          field(
            `${p}-authorizationEndpoint`,
            'Authorization endpoint',
            input(
              `${p}-authorizationEndpoint`,
              'authorizationEndpoint',
              v(method?.authorizationEndpoint),
              ' required type="url" pattern="https://.*"',
            ),
          ),
          field(
            `${p}-tokenEndpoint`,
            'Token endpoint',
            input(
              `${p}-tokenEndpoint`,
              'tokenEndpoint',
              v(method?.tokenEndpoint),
              ' required type="url" pattern="https://.*"',
            ),
          ),
          field(
            `${p}-userinfoEndpoint`,
            'Userinfo endpoint',
            input(
              `${p}-userinfoEndpoint`,
              'userinfoEndpoint',
              v(method?.userinfoEndpoint),
              ' required type="url" pattern="https://.*"',
            ),
          ),
          field(
            `${p}-scopes`,
            'Scopes',
            input(
              `${p}-scopes`,
              'scopes',
              (method?.scopes ?? []).join(', '),
              ' data-kind="list" placeholder="read:user, user:email"',
            ),
            'Comma-separated.',
          ),
          field(
            `${p}-subject`,
            'Subject claim',
            input(
              `${p}-subject`,
              'claims.subject',
              v(method?.claims?.subject),
              ' required placeholder="id"',
            ),
            'The userinfo field that identifies a person.',
          ),
          field(
            `${p}-claimName`,
            'Name claim',
            input(
              `${p}-claimName`,
              'claims.name',
              v(method?.claims?.name),
              ' data-optional placeholder="name"',
            ),
          ),
          field(
            `${p}-claimEmail`,
            'Email claim',
            input(
              `${p}-claimEmail`,
              'claims.email',
              v(method?.claims?.email),
              ' data-optional placeholder="email"',
            ),
          ),
          field(
            `${p}-claimVerified`,
            'Email-verified claim',
            input(
              `${p}-claimVerified`,
              'claims.emailVerified',
              v(method?.claims?.emailVerified),
              ' data-optional placeholder="email_verified"',
            ),
          ),
        ]),
  ].join('')
  const names = [
    ...(method == null ? ['id', 'create'] : []),
    'type',
    'enabled',
    'admitTesters',
    'name',
    'issuer',
    'clientId',
    'clientSecret',
    'authentication',
    ...(type === 'oidc'
      ? ['signingAlgorithm']
      : [
          'authorizationEndpoint',
          'tokenEndpoint',
          'userinfoEndpoint',
          'scopes',
          'claims.subject',
          'claims.name',
          'claims.email',
          'claims.emailVerified',
        ]),
  ]
  return apiForm(
    method == null
      ? '/api/v2/settings/signIn/methods/{id}'
      : `/api/v2/settings/signIn/methods/${encodeURIComponent(method.id)}`,
    fields,
    `${icon('check')} ${method == null ? 'Add' : 'Save'}`,
    { method: 'PUT', fields: names, then: 'reload' },
  )
}

/** Settings cards: titled, explained fields and one Save each, never JSON. */
function settingsCards(data: Parameters<typeof settingsView>[0]): string {
  const github = data.github ?? {}
  const kind = github.kind
  const githubCard = `<section class="panel" id="github"><h2>${icon('link')}GitHub</h2><p>How Mason reads your repositories and reports runs on commits. ${kind == null ? 'Not set up yet.' : `Now: ${kind === 'token' ? 'a personal access token' : kind === 'app' ? 'a GitHub App' : 'an SSH deploy key'}.`}</p>${action(
    `${icon('key')} Personal access token`,
    apiForm(
      '/api/v2/settings/github',
      `<input type="hidden" name="kind" value="token">${field('github-token', 'Token', `<input id="github-token" name="token" type="password" data-kind="secret" autocomplete="off"${kind === 'token' ? ' placeholder="Leave empty to keep the stored token"' : ' required'}>`, 'A fine-grained token with read access to contents and write access to commit statuses. Write-only.')}`,
      `${icon('check')} Save`,
      { method: 'PUT', fields: ['kind', 'token'], then: 'reload' },
    ),
    { id: 'github-token-form', open: kind === 'token' },
  )}${action(
    `${icon('extension')} GitHub App`,
    apiForm(
      '/api/v2/settings/github',
      `<input type="hidden" name="kind" value="app">${field('github-appId', 'App ID', input('github-appId', 'appId', github.appId == null ? '' : String(github.appId), ' required type="number" min="1" data-kind="number"'), 'On the app’s settings page in GitHub.')}${field('github-installationId', 'Installation ID', input('github-installationId', 'installationId', github.installationId == null ? '' : String(github.installationId), ' required type="number" min="1" data-kind="number"'), 'The number at the end of the installation’s settings URL.')}${field('github-privateKey', 'Private key', `<textarea id="github-privateKey" name="privateKey" data-kind="secret" rows="4" class="mono"${kind === 'app' ? ' placeholder="Leave empty to keep the stored key"' : ' required'}></textarea>`, 'The .pem file GitHub generated for the app. Write-only.')}`,
      `${icon('check')} Save`,
      {
        method: 'PUT',
        fields: ['kind', 'appId', 'installationId', 'privateKey'],
        then: 'reload',
      },
    ),
    { id: 'github-app-form', open: kind === 'app' },
  )}${action(
    `${icon('terminal')} SSH deploy key`,
    `${kind === 'ssh' && github.publicKey != null ? `<p>Add this public key to each repository as a deploy key:</p>${command(github.publicKey)}` : '<p>Mason makes a key pair and shows its public half to add to each repository as a deploy key.</p>'}${apiForm(
      '/api/v2/settings/github',
      '<input type="hidden" name="kind" value="ssh"><input type="hidden" name="privateKey" data-kind="secret" value="">',
      `${icon('check')} ${kind === 'ssh' ? 'Save' : 'Use a deploy key'}`,
      { method: 'PUT', fields: ['kind', 'privateKey'], then: 'reload' },
    )}${
      kind === 'ssh'
        ? action(
            `${icon('refresh')} Make a new deploy key`,
            `<p>Every repository then needs the new public key.</p>${apiForm('/api/v2/settings/github', '<input type="hidden" name="kind" value="ssh">', `${icon('refresh')} Make a new deploy key`, { method: 'PUT', fields: ['kind'], then: 'reload', className: 'secondary' })}`,
            { kind: 'secondary' },
          )
        : ''
    }`,
    { id: 'github-ssh-form', open: kind === 'ssh' },
  )}</section>`
  const host = data.host ?? {}
  const hostCard = `<section class="panel" id="host"><h2>${icon('cloud')}Host</h2><p>Where the host is served. A host the master makes on DigitalOcean fills this in.</p>${
    data.canChangeSignIn !== true
      ? `<p>Host address: ${host.origin == null ? 'not set' : `<span class="mono">${escape(host.origin)}</span>`}${host.workerOrigin == null ? '' : `; workers reach it at <span class="mono">${escape(host.workerOrigin)}</span>`}; it serves from its cache for ${String(host.offlineGraceHours ?? 72)} hours without the master. Invitation links open there, so only an administrator changes it.</p>`
      : apiForm(
          '/api/v2/settings/host',
          `${field('host-origin', 'Host address', input('host-origin', 'origin', host.origin ?? '', ' required type="url" pattern="https://.*" placeholder="https://builds.example.com"'), 'The https address people, devices and webhooks use.')}${field('host-workerOrigin', 'Worker address', input('host-workerOrigin', 'workerOrigin', host.workerOrigin ?? '', ' data-optional type="url" pattern="https://.*"'), 'Only when cloud machines reach the host at another address; empty uses the host address.')}${field('host-grace', 'Offline grace hours', input('host-grace', 'offlineGraceHours', String(host.offlineGraceHours ?? 72), ' required type="number" min="1" max="720" data-kind="number"'), 'How long the host keeps serving installs while it cannot reach the master.')}`,
          `${icon('check')} Save`,
          {
            method: 'PUT',
            fields: ['origin', 'workerOrigin', 'offlineGraceHours'],
            then: 'reload',
          },
        )
  }</section>`
  const storage = storageCard({
    ...(data.storage == null ? {} : { storage: data.storage }),
    accounts: data.storageAccounts ?? [],
    heading: 'h2',
  })
  const methods = data.signIn ?? []
  const masterOrigin = data.master?.origin
  // The redirect URIs to register with a provider: one per place it is offered.
  const callbacks = (id: string): string => {
    const where = [
      ...(host.origin == null ? [] : [['The host', host.origin]]),
      ...(masterOrigin == null ? [] : [['The master', masterOrigin]]),
    ]
    return where.length === 0
      ? '<p class="hint">Set the host or master address to see the callback URL to register.</p>'
      : `<p>Callback URLs to register with the provider:</p>${where.map(([label, origin]) => `<p><small>${escape(label!)}</small></p>${command(`${origin!}/auth/callback/${id}`)}`).join('')}`
  }
  const signInEditor = data.canChangeSignIn === true
  const masterForm = !signInEditor
    ? `<p>Master address: ${masterOrigin == null ? 'not set' : `<span class="mono">${escape(masterOrigin)}</span>`}. Only an administrator changes sign-in.</p>`
    : apiForm(
        '/api/v2/settings/master',
        field(
          'master-origin',
          'Master address',
          input(
            'master-origin',
            'origin',
            masterOrigin ?? '',
            ' data-optional type="url" pattern="https://.*" placeholder="https://mason-admin.example.com:9300"',
          ),
          'The https address people open the master at. Providers send the browser back here, so it needs a public domain name, though it may resolve to a private address. Empty offers only username and password on the master.',
        ),
        `${icon('check')} Save`,
        { method: 'PUT', fields: ['origin'], then: 'reload' },
      )
  const signInCard = `<section class="panel" id="signIn"><h2>${icon('login')}Sign-in</h2><p>Ways people sign in besides a username and password: OpenID Connect or OAuth 2 providers such as Google or GitHub. The host offers them; the master offers them too once its address is set.</p>${masterForm}${
    methods
      .map(
        (method) =>
          `<section class="panel"><h3>${escape(method.name)} <small class="mono">${escape(method.id)} · ${method.type === 'oidc' ? 'OpenID Connect' : 'OAuth 2'}${method.enabled ? '' : ' · disabled'}</small></h3>${callbacks(method.id)}${!signInEditor ? '' : `${signInForm(method, method.type)}${action(`${icon('delete')} Remove`, apiForm(`/api/v2/settings/signIn/methods/${encodeURIComponent(method.id)}`, `<p>People who sign in with ${escape(method.name)} then use another method.</p>`, `${icon('delete')} Remove ${escape(method.name)}`, { method: 'DELETE', then: 'reload', className: 'secondary' }), { kind: 'secondary' })}`}</section>`,
      )
      .join('') || '<p>None yet.</p>'
  }${!signInEditor ? '' : `${action(`${icon('add')} Add an OpenID Connect method`, signInForm(undefined, 'oidc'), { id: 'signin-add-oidc' })}${action(`${icon('add')} Add an OAuth 2 method`, signInForm(undefined, 'oauth2'), { id: 'signin-add-oauth2' })}`}</section>`
  const budgetCard = `<section class="panel" id="cloud"><h2>${icon('cloud')}Cloud budget</h2><p>Pools are edited on the <a href="/nodes">Nodes</a> page and cloud accounts on the <a href="/cloud">Cloud</a> page.</p>${apiForm(
    '/api/v2/settings/cloud/budget',
    field(
      'cloud-budget',
      'Monthly budget (dollars)',
      input(
        'cloud-budget',
        'monthlyBudget',
        String(data.monthlyBudget ?? ''),
        ' required type="number" min="0" data-kind="number"',
      ),
      'Cloud pools stop making machines when this month’s spend would pass it.',
    ),
    `${icon('check')} Save`,
    { method: 'PUT', fields: ['monthlyBudget'], then: 'reload' },
  )}</section>`
  return `${githubCard}${hostCard}${storage}${signInCard}${budgetCard}${nodeTypesCard(data.nodeTypes ?? {})}`
}

/** A node type as Settings shows it. */
export interface NodeTypeView {
  software: {
    xcode: string[]
    xcodeDefault?: string
    allowBeta: boolean
    simulators: string[]
    commandLineTools: boolean
    rosetta: boolean
    brew: { formulae: string[]; casks: string[] }
    apt: string[]
    dnf: string[]
    docker: boolean
    node?: string
    java?: string
    rust?: string
    python?: string
    go?: string
    ruby?: string
    android: string[]
  }
  settings: {
    noSleep: boolean
    devToolsSecurity: boolean
    automationMode: boolean
  }
  diskThresholdGb: number
  androidLicensesAccepted?: { by: string; at: number }
}

/** One card per node type, and a form to add one. */
function nodeTypesCard(types: Record<string, NodeTypeView>): string {
  const fields = (prefix: string, type: NodeTypeView | undefined): string => {
    const sw = type?.software
    const id = (name: string): string => `${prefix}-${name.replace(/\./g, '-')}`
    const list = (
      name: string,
      title: string,
      value: string[] | undefined,
      description: string,
      placeholder = '',
    ): string =>
      field(
        id(name),
        title,
        input(
          id(name),
          name,
          (value ?? []).join(', '),
          ` data-kind="list"${placeholder === '' ? '' : ` placeholder="${placeholder}"`}`,
        ),
        description,
      )
    const flag = (
      name: string,
      title: string,
      value: boolean | undefined,
      description: string,
    ): string =>
      field(
        id(name),
        title,
        checkbox(id(name), name, value ?? false),
        description,
      )
    const ver = (
      name: string,
      title: string,
      value: string | undefined,
      description: string,
      placeholder: string,
    ): string =>
      field(
        id(name),
        title,
        input(
          id(name),
          name,
          value ?? '',
          ` data-optional pattern="[A-Za-z0-9][A-Za-z0-9._+\\-]{0,39}" placeholder="${placeholder}"`,
        ),
        description,
      )
    return `<h3>Software</h3>${list('software.xcode', 'Xcode versions', sw?.xcode, 'Kept installed side by side.', '26.1, 16.4')}${ver('software.xcodeDefault', 'Default Xcode', sw?.xcodeDefault, 'The Xcode a stage uses when it names none and the repository has no .xcode-version; one of the versions above.', '26.1')}${flag('software.allowBeta', 'Allow beta Xcodes', sw?.allowBeta, 'Whether latest-beta may pick a beta.')}${list('software.simulators', 'Simulator runtimes', sw?.simulators, 'Runtimes to keep, such as iOS 26.1.', 'iOS 26.1')}${flag('software.commandLineTools', 'Command Line Tools', sw?.commandLineTools, 'Apple’s command line developer tools.')}${flag('software.rosetta', 'Rosetta', sw?.rosetta, 'Runs Intel binaries on Apple silicon.')}${list('software.brew.formulae', 'Homebrew formulae', sw?.brew.formulae, 'Installed with brew install.')}${list('software.brew.casks', 'Homebrew casks', sw?.brew.casks, 'Installed with brew install --cask.')}${list('software.apt', 'apt packages', sw?.apt, 'On Debian and Ubuntu nodes.', 'jq, zip')}${list('software.dnf', 'dnf packages', sw?.dnf, 'On Fedora and Red Hat nodes.')}${flag('software.docker', 'Docker', sw?.docker, 'Docker Engine, for stages that run containers.')}${ver('software.node', 'Node.js version', sw?.node, 'Empty: Node.js is not managed.', '24')}${ver('software.java', 'Java version', sw?.java, 'Empty: Java is not managed.', '21')}${ver('software.rust', 'Rust version', sw?.rust, 'Empty: Rust is not managed.', 'stable')}${ver('software.python', 'Python version', sw?.python, 'Empty: Python is not managed.', '3.12')}${ver('software.go', 'Go version', sw?.go, 'Empty: Go is not managed.', '1.23')}${ver('software.ruby', 'Ruby version', sw?.ruby, 'Empty: Ruby is not managed. Built from source once per node.', '3.3')}${list('software.android', 'Android SDK packages', sw?.android, 'sdkmanager package names. Their licences are accepted on a node’s page.', 'platforms;android-35')}<h3>Settings</h3>${flag('settings.noSleep', 'Keep awake', type?.settings.noSleep, 'The node never sleeps while Mason runs.')}${flag('settings.devToolsSecurity', 'Developer tools security', type?.settings.devToolsSecurity, 'Lets tools debug and automate apps without a password prompt (macOS).')}${flag('settings.automationMode', 'Automation mode', type?.settings.automationMode, 'Lets UI tests drive the Mac without prompts (macOS).')}${field(id('diskThresholdGb'), 'Disk threshold (GB)', input(id('diskThresholdGb'), 'diskThresholdGb', String(type?.diskThresholdGb ?? 40), ' required type="number" min="0" data-kind="number"'), 'Unused Xcodes and runtimes are removed when free disk falls below this.')}`
  }
  const names = [
    'software.xcode',
    'software.xcodeDefault',
    'software.allowBeta',
    'software.simulators',
    'software.commandLineTools',
    'software.rosetta',
    'software.brew.formulae',
    'software.brew.casks',
    'software.apt',
    'software.dnf',
    'software.docker',
    'software.node',
    'software.java',
    'software.rust',
    'software.python',
    'software.go',
    'software.ruby',
    'software.android',
    'settings.noSleep',
    'settings.devToolsSecurity',
    'settings.automationMode',
    'diskThresholdGb',
  ]
  const cards = Object.entries(types)
    .map(
      ([name, type]) =>
        `<section class="panel node-type" id="node-type-${escape(name)}"><h3><span class="mono">${escape(name)}</span></h3>${type.androidLicensesAccepted == null ? '' : `<p><small>Android SDK licences accepted by ${escape(type.androidLicensesAccepted.by)} on ${escape(new Date(type.androidLicensesAccepted.at).toISOString().slice(0, 10))}.</small></p>`}${apiForm(`/api/v2/settings/nodeTypes/${encodeURIComponent(name)}`, fields(`type-edit-${name}`, type), `${icon('check')} Save`, { method: 'PUT', fields: names, then: 'reload' })}${action(`${icon('delete')} Remove type`, apiForm(`/api/v2/settings/nodeTypes/${encodeURIComponent(name)}`, `<p>Nodes of type ${escape(name)} keep their software; Mason stops managing it.</p>`, `${icon('delete')} Remove ${escape(name)}`, { method: 'DELETE', then: 'reload', className: 'secondary' }), { kind: 'secondary' })}</section>`,
    )
    .join('')
  const add = action(
    `${icon('add')} Add a node type`,
    apiForm(
      '/api/v2/settings/nodeTypes/{name}',
      `<input type="hidden" name="create" value="yes">${field('type-new-name', 'Name', input('type-new-name', 'name', '', ' required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="macos-arm64"'), 'As the Masonfile and pools name it.')}${fields('type-new', undefined)}`,
      `${icon('add')} Add`,
      { method: 'PUT', fields: ['name', 'create', ...names], then: 'reload' },
    ),
    { id: 'add-node-type' },
  )
  return `<section class="panel" id="nodeTypes"><h2>${icon('tune')}Node types</h2><p>The software and settings every node of a type keeps. Mason installs what is missing and reports what needs a person on the node’s page.</p>${cards || '<p>None yet.</p>'}${add}</section>`
}

/** The box an invitation link appears in, once, with Copy. */
const linkBox = `<div data-field="token" hidden><p class="notice">Copy this link to them now: Mason sends no email, keeps only a hash of it and cannot show it again. It works once.</p><div class="command"><pre class="mono"></pre><button type="button" class="secondary copy" data-copy="">${icon('content_copy')}<span data-copy-label>Copy</span></button></div><p><a href="/people">Done</a></p></div>`

/** People: roles and per-method addresses; administrators change them. */
export function peopleView(data: {
  people: Array<{
    id: number
    name: string
    role: string
    email?: string
    addresses: Record<string, string>
    username?: string
    disabled?: boolean
    /** Whether they have a password. */
    password?: boolean
    /** An unused invitation link: when it expires. */
    invitation?: { expiresAt: number }
  }>
  canChange: boolean
  /** Now, for when invitations expire. */
  now?: number
}): string {
  const roles = ['admin', 'manager', 'developer', 'tester']
  const now = data.now ?? Date.now()
  const invitation = (person: (typeof data.people)[number]): string => {
    if (!data.canChange || person.disabled === true) return ''
    const status =
      person.invitation == null
        ? ''
        : `<p><small>Invited · the link expires ${localTime(person.invitation.expiresAt, now, 'date')}</small></p>${apiForm(`/api/v2/people/${person.id}/invitation`, '', 'Revoke invitation', { method: 'DELETE', then: 'reload', className: 'secondary' })}`
    return `${status}${action(
      person.invitation == null ? 'Invite' : 'Invite again',
      apiForm(
        `/api/v2/people/${person.id}/invitation`,
        `<p>A link, valid for a week, where ${escape(person.name)} chooses ${person.username == null ? 'a username and ' : ''}a password.${person.invitation == null ? '' : ' The earlier link stops working.'}</p>${linkBox}`,
        `${icon('link')} Make the link`,
        { then: 'link' },
      ),
      { kind: 'secondary' },
    )}`
  }
  const passwordFields = (prefix: string, required: boolean): string =>
    `<label for="${prefix}-password">${required ? 'Password' : 'Password (optional)'}</label><input id="${prefix}-password" name="password" type="password" autocomplete="new-password"${required ? ' required' : ''}><label for="${prefix}-confirm">Confirm the password</label><input id="${prefix}-confirm" name="confirm" type="password" autocomplete="new-password"${required ? ' required' : ''}><small class="hint">At least 8 characters with uppercase, lowercase and a number, or 17 characters or more. The browser hashes it; Mason never sees it.</small>`
  const usernameField = (
    prefix: string,
    value: string | undefined,
    required: boolean,
  ): string =>
    `<label for="${prefix}-username">${required ? 'Username' : 'Username (needed for a password)'}</label><input id="${prefix}-username" name="username" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" maxlength="64" value="${escape(value ?? '')}"${required ? ' required' : ''}>`
  // Setting it ends the person's sessions; they sign in with it on the host and the master.
  const password = (person: (typeof data.people)[number]): string =>
    !data.canChange || person.disabled === true
      ? ''
      : action(
          person.password === true ? 'Change password' : 'Set password',
          `<form data-mason="person-password" data-path="/api/v2/people/${person.id}"><p>${escape(person.name)} signs in with this username and password on the host and the master. Their sessions end.</p>${usernameField(`person-${person.id}`, person.username, true)}${passwordFields(`person-${person.id}`, true)}<button>${icon('key')} Set password</button>${statusLine}</form>`,
          { kind: 'secondary' },
        )
  const people = data.people
    .map(
      (person) =>
        `<tr><td><strong>${escape(person.name)}</strong>${person.username == null ? '' : ` <small class="mono">${escape(person.username)}</small>`}</td><td>${person.email == null ? '' : `<small>${escape(person.email)}</small>`}${Object.entries(
          person.addresses,
        )
          .map(
            ([method, address]) =>
              `<small>${escape(method)}: ${escape(address)}</small>`,
          )
          .join('')}</td><td>${
          data.canChange
            ? apiForm(
                `/api/v2/people/${person.id}`,
                `<select name="role" aria-label="Role">${roles.map((role) => `<option${role === person.role ? ' selected' : ''}>${role}</option>`).join('')}</select>`,
                'Set role',
                {
                  method: 'PUT',
                  fields: ['role'],
                  then: 'reload',
                  className: 'secondary',
                },
              )
            : escape(person.role)
        }</td><td>${invitation(person)}${password(person)}${data.canChange ? apiForm(`/api/v2/people/${person.id}`, '', 'Remove', { method: 'DELETE', then: 'reload', className: 'danger' }) : ''}</td></tr>`,
    )
    .join('')
  const add = data.canChange
    ? `<section class="panel"><h2>${icon('add')}Add a person</h2><form data-mason="person-add"><label for="person-name">Name</label><input id="person-name" name="name" required><label for="person-role">Role</label><select id="person-role" name="role">${roles.map((role) => `<option${role === 'tester' ? ' selected' : ''}>${role}</option>`).join('')}</select><label for="person-email">Email</label><input id="person-email" name="email" type="email" required><p>They sign in with any enabled sign-in method that confirms this address, with a password you set here, or with one they choose from an invitation link.</p>${usernameField('person-new', undefined, false)}${passwordFields('person-new', false)}${field('person-invite', 'Make an invitation link', '<input id="person-invite" name="invite" type="checkbox">', 'A link, valid for a week, where they choose a username and password. Mason sends no email: copy it to them.')}${linkBox}<button>${icon('add')} Add</button>${statusLine}</form></section>`
    : ''
  return `${head('People', 'Who signs in, with which addresses, and what their role lets them do.', ['Settings', 'People'])}<table class="list"><thead><tr><th>Person</th><th>Addresses</th><th>Role</th><th></th></tr></thead><tbody>${people || '<tr><td colspan="4">Nobody yet.</td></tr>'}</tbody></table>${add}`
}

/** The add-project wizard: repository, then the Masonfile's app IDs, then branches and triggers. */
export function wizardView(data: {
  slug?: string
  repository?: string
  defaultBranch?: string
  discovery?: {
    status: string
    reason: string | null
    apps?: Array<{
      bundleId: string
      platforms: string[]
      bundleIds?: string[]
    }>
    triggers?: Record<string, unknown[]>
  }
  owned: string[]
  rules: Array<{ pattern: string; mode: string }>
  webhook: boolean
}): string {
  const steps = ['Repository', 'Apps', 'Branches and triggers']
  const step = data.slug == null ? 1 : data.owned.length === 0 ? 2 : 3
  const progress = `<ol class="chips wizard-steps">${steps.map((name, index) => `<li class="chip"${index + 1 === step ? ' aria-current="true"' : ''}>${index + 1}. ${escape(name)}</li>`).join('')}</ol>`
  if (data.slug == null)
    return `${head('Add a project', 'A GitHub repository with a Masonfile.', ['Projects', 'New'])}${progress}<section class="panel">${apiForm('/api/v2/projects/check', '<label for="repository">GitHub repository</label><input id="repository" name="repository" placeholder="git@github.com:owner/repo.git" required>', `${icon('search')} Check with the master's GitHub credentials`, { fields: ['repository'], then: 'wizard' })}</section>`
  const discovery = data.discovery
  const apps =
    discovery == null
      ? apiForm(
          `/api/v2/projects/${data.slug}/discover`,
          '',
          `${icon('play_arrow')} Read the Masonfile on ${escape(data.defaultBranch ?? 'the default branch')}`,
          { then: 'reload' },
        )
      : discovery.status === 'succeeded' && discovery.apps != null
        ? apiForm(
            `/api/v2/projects/${data.slug}/wizard/apps`,
            `<p>The Masonfile declares these app IDs. Choose the ones this project owns.</p>${discovery.apps.map((app) => `<label class="check"><input type="checkbox" name="app" value="${escape(app.bundleId)}"${data.owned.includes(app.bundleId) ? ' checked' : ''}> <span class="mono">${escape(app.bundleId)}</span> ${app.platforms.map(platformChip).join(' ')}${app.bundleIds == null ? '' : ` <small>signs ${app.bundleIds.map(escape).join(', ')}</small>`}</label>`).join('') || '<p>It declares none.</p>'}<input type="hidden" name="apps" value=""><label for="team">Apple team ID (for iOS and macOS app IDs)</label><input id="team" name="team" pattern="[A-Z0-9]{10}">`,
            `${icon('check')} These app IDs are this project's`,
            { fields: ['apps', 'team'], then: 'reload' },
          )
        : discovery.status === 'failed' || discovery.status === 'cancelled'
          ? `<p class="state-failed">Reading the Masonfile ${escape(discovery.status)}: ${escape(discovery.reason ?? '')}</p>${apiForm(`/api/v2/projects/${data.slug}/discover`, '', 'Try again', { then: 'reload' })}`
          : `<p data-wizard-wait>${statusDot('running')} Reading the Masonfile on a worker… <a href="">Refresh</a></p>`
  const triggers = Object.entries(discovery?.triggers ?? {})
    .map(
      ([workflow, list]) =>
        `<li><span class="mono">${escape(workflow)}</span> <small class="mono">${escape(JSON.stringify(list))}</small></li>`,
    )
    .join('')
  const branches =
    step < 3
      ? ''
      : `<section class="panel"><h2>${icon('fork_right')}Branches and triggers</h2>${apiForm(
          `/api/v2/projects/${data.slug}/wizard/rules`,
          `<label for="rules">Branch rules, one per line: a glob, then automatic or request. The first match wins.</label><textarea id="rules" name="rules" rows="5" class="mono">${escape(
            (data.rules.length === 0
              ? [
                  {
                    pattern: data.defaultBranch ?? 'master',
                    mode: 'automatic',
                  },
                  { pattern: '*', mode: 'request' },
                ]
              : data.rules
            )
              .map((rule) => `${rule.pattern} ${rule.mode}`)
              .join('\n'),
          )}</textarea>`,
          `${icon('check')} Save rules`,
          { fields: ['rules'], then: 'reload' },
        )}<h3>Webhook</h3><p>${data.webhook ? 'The project has a webhook secret.' : 'No webhook yet.'}</p>${apiForm(`/api/v2/projects/${data.slug}/webhook`, '', `${icon('link')} Create the GitHub webhook`, { then: 'reload', className: 'secondary' })}<h3>Triggers (from the Masonfile, read only)</h3><ul class="plain">${triggers || '<li>Read the Masonfile first.</li>'}</ul><p><a class="button" href="/?project=${encodeURIComponent(data.slug)}">Done</a></p></section>`
  return `${head('Add a project', data.repository ?? '', ['Projects', data.slug])}${progress}<section class="panel"><h2>${icon('apps')}Apps</h2>${apps}</section>${branches}`
}

/** A project's Masonfile at a commit, read only. */
export function masonfileView(data: {
  slug: string
  name: string
  commits: Array<{ sha: string; branch: string }>
  commit?: string
  file?: string
  text?: string
  error?: string
}): string {
  const lines = (data.text ?? '').split('\n')
  return `${head(`${data.name} · Masonfile`, 'The Masonfile is the project’s configuration; it changes with the code.', [data.name, 'Masonfile'])}${projectTabs(data.slug, 'masonfile')}<form method="get" class="actions"><label for="commit" class="sr-only">Commit</label><select id="commit" name="commit">${data.commits.map((entry) => `<option value="${escape(entry.sha)}"${entry.sha === data.commit ? ' selected' : ''}>${escape(entry.sha.slice(0, 12))} · ${escape(entry.branch)}</option>`).join('')}</select><button class="secondary">Show</button></form>${
    data.error != null
      ? `<p class="empty-state">${escape(data.error)}</p>`
      : data.text == null
        ? '<p class="empty-state">Choose a commit.</p>'
        : `<h2 class="mono">${escape(data.file ?? '')}</h2><pre class="log"><code>${lines.map((line, index) => `<span class="line" data-line="${index + 1}">${escape(line)}</span>`).join('')}</code></pre>`
  }`
}

/** The tabs of a project's pages. */
export function projectTabs(
  slug: string,
  current: 'overview' | 'runs' | 'masonfile' | 'secrets',
): string {
  const path = `/projects/${encodeURIComponent(slug)}`
  const tab = (key: string, href: string, label: string): string =>
    `<a href="${escape(href)}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`
  return `<nav class="tabs" aria-label="Project">${[
    tab('overview', path, 'Overview'),
    tab('runs', `${path}/runs`, 'Runs and builds'),
    tab('masonfile', `${path}/masonfile`, 'Masonfile'),
    tab('secrets', `${path}/secrets`, 'Secrets'),
  ].join('')}</nav>`
}

/** One secret variant as the Secrets tab lists it. */
export interface SecretRowView {
  id: number
  name: string
  kind: 'value' | 'file'
  configs: string[]
  text: boolean
  masked: boolean
  pathEnv?: string
  destination?: string
  bytes: number
}

/** One audit entry as the Secrets tab lists it. */
export interface SecretAuditView {
  name: string
  configs: string[]
  action: string
  who: string
  address: string
  at: number
  detail?: string
}

const pillsOf = (configs: string[], button: boolean): string =>
  (configs.length === 0 ? ['all'] : configs)
    .map((config) =>
      button
        ? `<button type="button" class="pill" data-secret-pill title="Edit build configs">${escape(config)}</button>`
        : `<span class="pill">${escape(config)}</span>`,
    )
    .join('')

/**
 * The Secrets tab: the add buttons and help, one row per variant, the
 * audit for administrators and managers, and the text-file editor. Every
 * control is in the page, hidden until the tab's script shows it.
 */
export function secretsView(data: {
  slug: string
  name: string
  format: 'pipeline' | 'script'
  secrets: SecretRowView[]
  /** Administrators and managers: add, edit, replace, delete, and the audit. */
  canChange: boolean
  /** Changes need a configured backup. */
  backups: boolean
  audit?: SecretAuditView[]
}): string {
  const script = data.format === 'script'
  const manage = data.canChange
  const changeable = manage && data.backups
  const help = script
    ? `<p class="hint">This is a script project: its build stage gets every value as an environment variable, and every file written into the checkout at its name, a path such as <code>android/app/google-services.json</code>. Script projects have no build configs.</p>`
    : `<p class="hint">Values are set as environment variables for the shell commands of stages that declare them in <code>secrets</code>, and the Masonfile reads them with <code>ctx.secret(name)</code>. Files are written by the Masonfile with <code>await ctx.writeSecretFile(name, directory)</code>. A secret’s build configs limit it to stages that list one of them in <code>configs</code>; one with none is used by every other stage.</p>`
  // Script projects take only default variants, so they have no configs to set.
  const configsField = (id: string): string =>
    script
      ? ''
      : field(
          id,
          'Build configs',
          `<input id="${id}" name="configs" autocomplete="off" placeholder="all">`,
          'Comma-separated; empty means all.',
        )
  const notice =
    manage && !data.backups
      ? `<p class="notice" role="status">Configure backups before changing secrets: every change is pushed in a backup before it is saved. <a href="/backups">Backups</a></p>`
      : ''
  const buttons = manage
    ? `<div class="actions"><button type="button" data-secret-add="value"${changeable ? '' : ' disabled'}>${icon('add')}Add secret value</button><button type="button" data-secret-add="file"${changeable ? '' : ' disabled'}>${icon('upload')}Add secret file</button></div>`
    : ''
  const addValue = changeable
    ? `<form class="secret-add" data-secret-add-form="value" hidden><h3>Add secret value</h3>${field('secret-value-name', 'Name', '<input id="secret-value-name" name="name" class="mono" required autocomplete="off" spellcheck="false" placeholder="API_TOKEN">', 'Capital letters, digits and underscores: the environment variable it becomes.')}${configsField('secret-value-configs')}${field('secret-value-value', 'Value', '<input id="secret-value-value" name="value" type="password" class="mono" autocomplete="off" spellcheck="false" required><textarea data-secret-value-lines hidden rows="6" class="mono" autocomplete="off" spellcheck="false" aria-label="Value"></textarea>')}<label class="check" data-secret-reveal><input type="checkbox" data-secret-show> Show the value</label>${script ? '<label class="check"><input type="checkbox" name="masked" checked> Mask in logs</label>' : ''}<div class="actions"><button>Save</button><button type="button" class="secondary" data-secret-add-cancel>Cancel</button></div><output data-secret-output></output></form>`
    : ''
  const addFile = changeable
    ? `<form class="secret-add" data-secret-add-form="file" hidden><h3>Add secret file</h3><div class="drop" data-secret-drop tabindex="0" role="button" aria-label="Drop a file, or choose one">${icon('upload')}<span>Drop a file here, or click to choose one</span><strong data-secret-chosen></strong></div><input type="file" data-secret-add-file hidden>${field('secret-file-text', 'Or paste its text', '<textarea id="secret-file-text" name="text" rows="6" class="mono" spellcheck="false" placeholder="{ … }"></textarea>')}${field('secret-file-name', script ? 'Path in the checkout' : 'File name', `<input id="secret-file-name" name="name" class="mono" required autocomplete="off" spellcheck="false" placeholder="${script ? 'android/app/google-services.json' : 'config.json'}">`, script ? 'Letters, digits, dots, dashes and underscores, with / between directories: where the build stage finds the file.' : 'Letters, digits, dots, dashes and underscores. The Masonfile chooses the directory.')}${configsField('secret-file-configs')}${script ? field('secret-file-path-env', 'Path variable', '<input id="secret-file-path-env" name="pathEnv" class="mono" autocomplete="off" spellcheck="false">', 'Optional: the variable that holds the file’s path in the build.') : ''}<div class="actions"><button>Save</button><button type="button" class="secondary" data-secret-add-cancel>Cancel</button></div><output data-secret-output></output></form>`
    : ''
  const rows = data.secrets
    .map((variant) => {
      const notes = [
        variant.kind === 'value' && !variant.masked
          ? '<small class="hint">not masked</small>'
          : '',
        variant.pathEnv == null
          ? ''
          : `<small class="hint">→ $${escape(variant.pathEnv)}</small>`,
        variant.destination != null && variant.destination !== variant.name
          ? `<small class="hint">at ${escape(variant.destination)}</small>`
          : '',
        variant.kind === 'file'
          ? `<small class="hint">${escape(bytes(variant.bytes))}${variant.text ? ' · text' : ''}</small>`
          : '',
      ].join('')
      const editable = variant.kind === 'value' || variant.text
      const actions = manage
        ? `<span class="row-actions" data-secret-view>${
            editable
              ? `<button type="button" class="secondary" data-secret-edit>${icon('edit')}Edit</button>`
              : `<button type="button" class="secondary" data-secret-replace>${icon('upload')}Replace</button>`
          }<button type="button" class="secondary danger" data-secret-delete>${icon('delete')}Delete</button></span><span class="row-actions" data-secret-editing hidden><button type="button" data-secret-save>Save</button><button type="button" class="secondary" data-secret-cancel>Cancel</button></span><output data-secret-output></output>`
        : ''
      return `<tr data-secret-id="${variant.id}" data-kind="${variant.kind}" data-name="${escape(variant.name)}" data-configs="${escape(variant.configs.join(','))}"><td class="secret-name">${icon(variant.kind === 'value' ? 'key' : 'description')}<span class="mono">${escape(variant.name)}</span>${notes}${manage && variant.kind === 'value' ? `<input class="mono" data-secret-value hidden autocomplete="off" spellcheck="false" aria-label="Value of ${escape(variant.name)}">` : ''}</td><td class="secret-configs"><span class="pills" data-secret-pills>${pillsOf(variant.configs, manage && !script)}</span>${manage && !script ? `<input data-secret-configs-input hidden autocomplete="off" placeholder="all" aria-label="Build configs of ${escape(variant.name)}">` : ''}</td><td class="secret-actions">${actions}</td></tr>`
    })
    .join('')
  const table = `<table class="list secrets"><thead><tr><th>Name</th><th>Build configs</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty-state">No secrets yet.</td></tr>'}</tbody></table>${manage ? '<input type="file" data-secret-file hidden>' : ''}`
  const audit =
    manage && data.audit != null
      ? `<section class="panel"><h2>${icon('history')}Audit</h2><p class="hint">Every view of a value or file, every change and every refusal. Values are never recorded.</p><table class="list audit"><thead><tr><th>When</th><th>Who</th><th>Secret</th><th>Action</th><th>Address</th></tr></thead><tbody>${
          data.audit
            .map(
              (entry) =>
                `<tr><td><time datetime="${new Date(entry.at).toISOString()}" data-at="${entry.at}">${escape(new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19))} UTC</time></td><td>${escape(entry.who)}</td><td><span class="mono">${escape(entry.name)}</span> <span class="pills">${pillsOf(entry.configs, false)}</span></td><td>${escape(entry.action)}${entry.detail == null ? '' : ` <small class="hint">${escape(entry.detail)}</small>`}</td><td class="mono">${escape(entry.address)}</td></tr>`,
            )
            .join('') ||
          '<tr><td colspan="5" class="empty-state">Nothing yet.</td></tr>'
        }</tbody></table></section>`
      : ''
  const editor = manage
    ? `<div class="secret-editor" data-secret-editor hidden role="dialog" aria-modal="true" aria-labelledby="secret-editor-title"><div class="secret-editor-head"><h2 id="secret-editor-title" class="mono" data-secret-editor-title></h2><span class="pill" data-secret-editor-configs></span><span class="spacer"></span><button type="button" data-secret-editor-save>Save</button><button type="button" class="secondary" data-secret-editor-cancel>Cancel</button></div><textarea class="mono" data-secret-editor-text spellcheck="false" aria-labelledby="secret-editor-title"></textarea><output data-secret-editor-output></output></div>`
    : ''
  return `${head(`${data.name} · Secrets`, 'Values and files the project’s stages may read, each limited to build configs.', [data.name, 'Secrets'])}${projectTabs(data.slug, 'secrets')}<section class="panel"${manage ? ` data-secrets="/api/v2/projects/${escape(encodeURIComponent(data.slug))}/secrets"` : ''}>${notice}${buttons}${help}${addValue}${addFile}${table}</section>${audit}${editor}`
}

/** A project's build-number sequences, and where a manager sets one's last number. */
function buildNumbersPanel(data: {
  slug: string
  buildNumbers: Array<{
    key: string
    format: string
    scope: string
    last: Array<{ branch: string; value: string }>
  }>
  canSeed: boolean
}): string {
  const rows = data.buildNumbers
    .map(
      (sequence) =>
        `<tr><td class="mono">${escape(sequence.key)}</td><td class="mono">${escape(sequence.format)}</td><td>${sequence.scope === 'branch' ? 'per branch' : 'across branches'}</td><td>${
          sequence.last
            .map(
              (entry) =>
                `<small>${entry.branch === '' ? '' : `<span class="mono">${escape(entry.branch)}</span> `}${escape(entry.value)}</small>`,
            )
            .join('') || '<small>none yet</small>'
        }</td></tr>`,
    )
    .join('')
  const form =
    data.canSeed && data.buildNumbers.length > 0
      ? apiForm(
          '/api/v2/build-numbers/seed',
          `<input type="hidden" name="project" value="${escape(data.slug)}"><label for="seed-key">Sequence</label><select id="seed-key" name="key">${data.buildNumbers.map((sequence) => `<option>${escape(sequence.key)}</option>`).join('')}</select><label for="seed-branch">Branch (for a per-branch sequence)</label><input id="seed-branch" name="branch"><label for="seed-last">Last number issued</label><input id="seed-last" name="last" required><p>The next build of that sequence gets the number after it. Nothing is lowered.</p>`,
          `${icon('edit')} Set where it stands`,
          {
            fields: ['project', 'key', 'branch', 'last'],
            then: 'reload',
            className: 'secondary',
          },
        )
      : ''
  return `<section class="panel" id="build-numbers"><h2>${icon('label')}Build numbers</h2>${
    rows === ''
      ? '<p>The Masonfile declares no build numbers yet, or setup has not run.</p>'
      : `<table class="list"><thead><tr><th>Sequence</th><th>Format</th><th>Scope</th><th>Last issued</th></tr></thead><tbody>${rows}</tbody></table>`
  }${form}</section>`
}

/**
 * A project's Runs and builds tab in two columns: its branches, All
 * branches first, then those its push trigger builds, then the rest by
 * their latest run; and the selected branch's runs.
 */
export function projectRunsView(
  data: {
    slug: string
    name: string
    branch?: string
    branches: BranchItem[]
    runs: ProjectRunRow[]
  },
  now: number,
): string {
  const base = `/projects/${encodeURIComponent(data.slug)}/runs`
  const item = (
    label: string,
    href: string,
    current: boolean,
    extra = '',
  ): string =>
    `<li><a href="${escape(href)}"${current ? ' aria-current="true"' : ''}>${label}${extra}</a></li>`
  const pinned = data.branches.filter((entry) => entry.pinned)
  const others = data.branches.filter((entry) => !entry.pinned)
  const branch = (entry: BranchItem): string =>
    item(
      `<span class="mono">${escape(entry.branch)}</span>`,
      `${base}?branch=${encodeURIComponent(entry.branch)}`,
      entry.branch === data.branch,
      entry.at == null
        ? '<small>No runs yet</small>'
        : `<small>${localTime(entry.at, now, 'since')}</small>`,
    )
  const list = `<nav class="panel branch-list" aria-label="Branches"><ul class="tree">${item(`<span>${icon('fork_right')} All branches</span>`, base, data.branch == null)}${pinned.map(branch).join('')}${
    pinned.length > 0 && others.length > 0
      ? '<li class="divider" role="separator"></li>'
      : ''
  }${others.map(branch).join('')}</ul></nav>`
  return `${head(`${data.name} · Runs and builds`, data.branch == null ? 'The latest runs on every branch.' : `The latest runs on ${data.branch}.`, [data.name, 'Runs and builds'])}${projectTabs(data.slug, 'runs')}<div class="runs-columns">${list}<section class="panel"><h2>${data.branch == null ? 'All branches' : `<span class="mono">${escape(data.branch)}</span>`}</h2>${projectRunsTable(data.runs, now, data.branch == null)}</section></div>`
}

/** A project on the master: repository, app IDs, branch rules, build numbers, and its tabs. */
export function projectView(data: {
  slug: string
  name: string
  repository: string
  defaultBranch: string
  format: string
  apps: Array<{
    bundleId: string
    platforms: string[]
    apple?: { team: string }
  }>
  rules: Array<{ pattern: string; mode: string }>
  webhook: boolean
  signingLabel?: string
  buildNumbers: Array<{
    key: string
    format: string
    scope: string
    last: Array<{ branch: string; value: string }>
  }>
  canSeed: boolean
}): string {
  return `${head(data.name, data.repository, ['Projects', data.slug])}${projectTabs(data.slug, 'overview')}<section class="panel"><h2>${icon('apps')}App IDs</h2><ul class="plain">${
    data.apps
      .map(
        (app) =>
          `<li><span class="mono">${escape(app.bundleId)}</span> ${app.platforms.map(platformChip).join(' ')}${app.apple == null ? '' : ` <small>Apple team <span class="mono">${escape(app.apple.team)}</span></small>`}</li>`,
      )
      .join('') || '<li>None.</li>'
  }</ul></section><section class="panel"><h2>${icon('fork_right')}Branch rules</h2><table class="list"><tbody>${
    data.rules
      .map(
        (rule) =>
          `<tr><td class="mono">${escape(rule.pattern)}</td><td>${escape(rule.mode)}</td></tr>`,
      )
      .join('') || '<tr><td>No rules: nothing builds.</td></tr>'
  }</tbody></table><p>Default branch <span class="mono">${escape(data.defaultBranch)}</span> · ${escape(data.format)} Masonfile · webhook ${data.webhook ? 'set' : 'not set'}${data.signingLabel == null ? '' : ` · signs on nodes labelled <span class="mono">${escape(data.signingLabel)}</span>`}</p></section>${buildNumbersPanel(data)}`
}

/** One cloud account on the Cloud page: its provider, what its last check found, and its actions. */
export interface CloudAccountRow {
  id: string
  name: string
  provider: 'digitalocean' | 'nomac'
  /** Whether an administrator entered its key, so a host may be made in it. */
  adminKeyed?: boolean
  check?: {
    state: 'ok' | 'refused' | 'timeout' | 'unavailable' | 'error'
    checkedAt: number
    message?: string
    digitalocean?: { email: string; dropletLimit: number; status: string }
    nomac?: {
      credit: number
      spendableSeconds: number
      concurrency: number
      spendingBlocked: boolean
    }
  }
}

const providerLabels = { digitalocean: 'DigitalOcean', nomac: 'NoMac' }

/** Cloud: the provider accounts pools and hosts use; a key is entered once and never shown. */
export function cloudView(data: {
  accounts: CloudAccountRow[]
  canChange: boolean
  now: number
}): string {
  const state = (account: CloudAccountRow): string => {
    const check = account.check
    if (check == null) return '<p>Not checked yet.</p>'
    const when = `<small>Checked ${escape(ago(check.checkedAt, data.now))}</small>`
    if (check.state !== 'ok')
      return `<p class="state-failed">${escape(
        check.state === 'refused'
          ? 'Key refused'
          : check.state === 'timeout'
            ? 'No answer'
            : check.state === 'unavailable'
              ? 'Unavailable'
              : 'Check failed',
      )}: ${escape(check.message ?? '')}</p>${when}`
    if (check.digitalocean != null)
      return `<p class="state-succeeded">OK</p><dl class="facts"><dt>Account</dt><dd>${escape(check.digitalocean.email)}</dd><dt>Droplet limit</dt><dd>${check.digitalocean.dropletLimit}</dd><dt>Status</dt><dd>${escape(check.digitalocean.status)}</dd></dl>${when}`
    const nomac = check.nomac!
    return `<p class="state-succeeded">OK</p><dl class="facts"><dt>Credit</dt><dd>$${nomac.credit.toFixed(2)} (${(nomac.spendableSeconds / 3600).toFixed(1)} hours)</dd><dt>Macs at a time</dt><dd>${nomac.concurrency}</dd>${nomac.spendingBlocked ? '<dt>Spending</dt><dd>Paused for the account</dd>' : ''}</dl>${when}`
  }
  const accounts = data.accounts
    .map(
      (account) =>
        `<section class="panel" id="account-${escape(account.id)}" data-account="${escape(account.id)}"><h2>${icon('cloud')}${escape(account.name)}</h2><p>${escape(providerLabels[account.provider])} · <span class="mono">${escape(account.id)}</span></p>${
          account.provider === 'nomac'
            ? ''
            : account.adminKeyed === true
              ? '<p><small>Its key was entered by an administrator, so a host may be made in it.</small></p>'
              : '<p class="notice">No administrator entered this key, so no host is made in it until one replaces it.</p>'
        }${state(account)}${
          data.canChange
            ? `<div class="actions">${apiForm(`/api/v2/cloud/accounts/${encodeURIComponent(account.id)}/check`, '', `${icon('refresh')} Check`, { className: 'secondary' })}${action(`${icon('key')} Replace key`, apiForm(`/api/v2/cloud/accounts/${encodeURIComponent(account.id)}/key`, `<label for="account-key-${escape(account.id)}">New API key</label><input id="account-key-${escape(account.id)}" name="key" type="password" autocomplete="off" required><p><small>Kept in this master's database and never shown again. Entered by an administrator, a host may be made in the account.</small></p>`, `${icon('key')} Replace key`, { method: 'PUT', fields: ['key'], then: 'reload' }), { kind: 'secondary' })}${apiForm(`/api/v2/cloud/accounts/${encodeURIComponent(account.id)}`, '', `${icon('delete')} Remove`, { method: 'DELETE', className: 'secondary' })}</div>`
            : ''
        }</section>`,
    )
    .join('')
  const add = data.canChange
    ? `<section class="panel" id="add-account"><h2>${icon('add')}Add account</h2>${apiForm(
        '/api/v2/cloud/accounts',
        `<label for="account-provider">Provider</label><select id="account-provider" name="provider"><option value="digitalocean">DigitalOcean</option><option value="nomac">NoMac</option></select><label for="account-name">Name</label><input id="account-name" name="name" required maxlength="80" placeholder="DigitalOcean"><label for="account-key">API key</label><input id="account-key" name="key" type="password" autocomplete="off" required><p><small>A DigitalOcean personal access token with read and write scope, or a NoMac API key (nmk_…). It is kept in this master's database and never shown again.</small></p>`,
        `${icon('add')} Add account`,
        { fields: ['provider', 'name', 'key'] },
      )}</section>`
    : ''
  return `${head('Cloud', 'The provider accounts cloud pools and hosts are made in.', ['Cloud'])}${accounts || '<p class="empty-state">No cloud accounts yet.</p>'}${add}`
}

/** Groups: one row per group, each opening its page, and a name field that adds one. */
export function groupsView(data: {
  groups: Array<{ id: number; name: string }>
  canChange: boolean
}): string {
  const rows = data.groups
    .map(
      (group) =>
        `<a class="list-row" href="/groups/${group.id}"><strong>${escape(group.name)}</strong>${icon('chevron_right')}</a>`,
    )
    .join('')
  const add = data.canChange
    ? `<section class="panel"><h2>${icon('add')}Add a group</h2>${apiForm(
        '/api/v2/groups',
        field(
          'group-name',
          'Name',
          '<input id="group-name" name="name" maxlength="120" required>',
        ),
        `${icon('add')} Add group`,
        { fields: ['name'], then: 'group' },
      )}</section>`
    : ''
  return `${head('Groups', 'The apps each group’s members see in their catalog.', ['Groups'])}<div class="group-list">${rows || '<p class="empty-state">No groups.</p>'}</div>${add}`
}

/**
 * A group: its name, which becomes a text field when tapped, its apps and its
 * members, each with a picker that adds and removes them, and Remove group.
 * Viewers who cannot change groups see text.
 */
export function groupView(data: {
  group: { id: number; name: string; apps: number[]; members: number[] }
  apps: GroupApp[]
  people: GroupPerson[]
  canChange: boolean
}): string {
  const { group } = data
  const name = escape(group.name)
  const crumbs = ['Mason', 'Master', 'Groups']
    .map((part) => `<span>${escape(part)}</span>`)
    .join('<span>/</span>')
  const top = `<div class="page-head"><div><div class="breadcrumbs">${crumbs}<span>/</span><span data-group-title>${name}</span></div><h1 data-group-title>${name}</h1><p>Its members see its apps in their catalog.</p></div></div>`
  const label = `<span><small>Name</small><strong data-group-name-text>${name}</strong></span>`
  const nameRow = data.canChange
    ? `<div class="group-name" data-group-name><button type="button" class="list-row" data-group-rename>${label}${icon('edit')}</button><input name="name" maxlength="120" value="${name}" aria-label="Group name" autocomplete="off" data-group-name-input hidden><p class="notice" role="alert" data-group-name-error hidden></p></div>`
    : `<div class="group-name"><div class="list-row">${label}</div></div>`
  // Add App and Add member: a search field with Done on its right, the
  // choices under it, and the Add button at the bottom of the section.
  const picker = (add: string, find: string, placeholder: string): string =>
    data.canChange
      ? `<div class="group-picker" data-group-picker hidden><div class="picker-bar"><input type="search" data-group-query aria-label="${escape(find)}" placeholder="${escape(placeholder)}" autocomplete="off"><button type="button" class="secondary" data-group-done>Done</button></div><div data-group-choices></div></div><p class="notice" role="alert" data-group-error hidden></p><button type="button" class="secondary" data-group-add>${icon('add')} ${escape(add)}</button>`
      : ''
  const section = (
    kind: 'apps' | 'members',
    title: string,
    heading: string,
    rows: string,
    controls: string,
  ): string =>
    `<section class="panel" data-group-section="${kind}"><h2>${heading}${escape(title)}</h2><ul data-group-rows>${rows}</ul>${controls}</section>`
  // The picker filters this in the browser; `<` is escaped so no text closes the element.
  const catalog = data.canChange
    ? `<script type="application/json" data-group-catalog>${JSON.stringify({
        apps: data.apps,
        people: data.people,
        group: { apps: group.apps, members: group.members },
      }).replaceAll('<', '\\u003c')}</script>`
    : ''
  const remove = data.canChange
    ? apiForm(
        `/api/v2/groups/${group.id}`,
        '',
        `${icon('delete')} Remove group`,
        { method: 'DELETE', then: 'groups', className: 'danger' },
      )
    : ''
  return `${top}<div class="group-page" data-group="${group.id}">${nameRow}${section(
    'apps',
    'Apps',
    icon('apps'),
    sectionRows(data.apps, group.apps, appRow),
    picker('Add App', 'Find an app', 'App name or ID'),
  )}${section(
    'members',
    'Group Members',
    icon('group'),
    sectionRows(data.people, group.members, memberRow),
    picker('Add member', 'Find a person', 'Name or email'),
  )}${remove}${catalog}</div>`
}
