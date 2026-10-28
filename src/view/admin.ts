import { bytes, platformChip, statusDot } from './dashboard.js'
import { ago, escape } from './html.js'
import { icon } from './icons.js'

const statusLine =
  '<p class="notice" role="status" data-field="status" hidden></p>'

/** A shell command with a button that copies it. */
const command = (text: string): string =>
  `<div class="command"><pre class="mono">${escape(text)}</pre><button type="button" class="secondary copy" data-copy="${escape(text)}">${icon('content_copy')}<span data-copy-label>Copy</span></button></div>`

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
  catalog?: {
    regions: Array<{ slug: string; name: string }>
    sizes: Array<{ slug: string; description: string; priceMonthly: number }>
    images: Array<{ slug: string; name: string }>
  }
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
  const field = (name: string, label: string, input: string): string =>
    `<label for="${prefix}-${name}">${label}</label>${input}`
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
      : field(
          'name',
          'Name',
          text(
            'name',
            pool.name ?? '',
            ' required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="linux-cloud"',
          ),
        ),
    field(
      'type',
      'Node type its machines serve',
      text(
        'type',
        pool.type ?? '',
        ' required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="linux"',
      ),
    ),
    field(
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
    field(
      'size',
      'Size',
      catalog == null
        ? text('size', pool.size ?? '', ' required placeholder="s-2vcpu-4gb"')
        : select(
            'size',
            pool.size ?? 's-2vcpu-4gb',
            catalog.sizes.map((size) => ({
              value: size.slug,
              label: `${size.slug} · ${size.description} · $${size.priceMonthly}/month`,
            })),
          ),
    ),
    field(
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
    field(
      'labels',
      'Labels (comma-separated)',
      text('labels', (pool.labels ?? []).join(', ')),
    ),
    field(
      'maxNodes',
      'Machines at most',
      number('maxNodes', pool.maxNodes ?? 1, 1, 50),
    ),
    field(
      'slots',
      'Stages at a time per machine',
      number('slots', pool.slots ?? 1, 1, 64),
    ),
    field(
      'ttlMinutes',
      'Retire after idle minutes',
      number('ttlMinutes', pool.ttlMinutes ?? 60, 1, 1440),
    ),
    field(
      'maxHoursPerNode',
      'Retire after hours up',
      number('maxHoursPerNode', pool.maxHoursPerNode ?? 24, 1, 720),
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
  error: string | null
}

/** The Create host form's fields for one account. */
function hostFields(account: PoolAccount): string {
  const prefix = `host-${account.id}`
  const catalog = account.catalog
  const select = (
    name: string,
    value: string,
    options: Array<{ value: string; label: string }>,
  ): string =>
    `<select id="${prefix}-${name}" name="${name}">${options.map((option) => `<option value="${escape(option.value)}"${option.value === value ? ' selected' : ''}>${escape(option.label)}</option>`).join('')}</select>`
  const text = (name: string, value: string, extra = ''): string =>
    `<input id="${prefix}-${name}" name="${name}" value="${escape(value)}"${extra}>`
  return [
    `<input type="hidden" name="account" value="${escape(account.id)}">`,
    `<label for="${prefix}-name">Name</label>${text('name', '', ' required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="builds"')}`,
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
  ].join('')
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

/** Nodes: status, type, current stage, inventory and checklist; node types; cloud pools and their budget; adding a node. */
export function nodesView(data: {
  nodes: NodeRow[]
  types: Record<string, unknown>
  pools: PoolRow[]
  /** Accounts pools and hosts may be made in. */
  poolAccounts?: PoolAccount[]
  /** Hosts the master made on a cloud provider. */
  cloudHosts?: CloudHostView[]
  budget: { monthly: number; notice?: string }
  host?: string
  /** The master's own release, installable from GitHub when no host serves one. */
  release?: { repository: string; version: string }
  canChange: boolean
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
      }</article>`
    })
    .join('')
  const install =
    data.host != null
      ? `install Mason from the host: ${command(`/bin/bash -c "$(curl -fsSL ${data.host}/install.sh)" -- --from ${data.host}`)}`
      : data.release != null
        ? `install Mason ${escape(data.release.version)}, the master’s version: ${command(`/bin/bash -c "$(curl -fsSL https://github.com/${data.release.repository}/releases/latest/download/install.sh)" -- --version ${data.release.version}`)}`
        : 'install Mason from a host: set the host\'s origin in <a href="/settings#host">Settings</a> to see its command.'
  const cloudHosts = (data.cloudHosts ?? [])
    .map(
      (host) =>
        `<section class="panel cloud-host" id="host-${escape(host.name)}" data-state="${escape(host.state)}"><h3>${icon('cloud')}<span class="mono">${escape(host.name)}</span> <small>${escape(host.state)}</small></h3><p>${escape(host.region)} · ${escape(host.size)}${host.address == null ? '' : ` · <span class="mono">${escape(host.address)}</span>`}${host.dnsName == null ? '' : ` · <span class="mono">${escape(host.dnsName)}</span>`}</p>${host.origin == null ? '' : `<p>Serves <a href="${escape(host.origin)}">${escape(host.origin)}</a></p>`}${host.error == null ? '' : `<p class="state-failed">${escape(host.error)}</p>`}${
          data.canChange
            ? `<div class="actions">${apiForm(`/api/v2/cloud/hosts/${encodeURIComponent(host.name)}/reconcile`, '', `${icon('refresh')} Reconcile`, { className: 'secondary' })}</div><details><summary>Remove</summary>${apiForm(`/api/v2/cloud/hosts/${encodeURIComponent(host.name)}`, `<label for="remove-${escape(host.name)}">Type ${escape(host.name)} to destroy its droplet and unpair it</label><input id="remove-${escape(host.name)}" name="confirm" required autocomplete="off">`, `${icon('delete')} Remove host`, { method: 'DELETE', fields: ['confirm'], className: 'secondary' })}</details>`
            : ''
        }</section>`,
    )
    .join('')
  const hostCommands = `<p>On the host’s computer, ${install}</p><p>Start it as the host: ${command('sudo mason host --install')} It prints its pairing key; pair it in Add node.</p>`
  const hostAccounts = (data.poolAccounts ?? [])
    .map(
      (account) =>
        `<details class="add-host" id="add-host-${escape(account.id)}"><summary>On ${escape(account.name)}</summary>${account.error == null ? '' : `<p class="notice">${escape(account.error)}</p>`}${apiForm('/api/v2/cloud/hosts', hostFields(account), `${icon('add')} Create host`, { fields: ['account', 'name', 'region', 'size', 'image'] })}</details>`,
    )
    .join('')
  const hostPanel =
    !data.canChange && cloudHosts === ''
      ? ''
      : `<section class="panel" id="hosts"><h2>${icon('cloud')}Host</h2>${cloudHosts}${
          data.canChange && cloudHosts === '' && data.host == null
            ? `<details class="add-host" open><summary>With a command</summary>${hostCommands}</details>${hostAccounts || '<p>Or add a DigitalOcean account on the <a href="/cloud">Cloud</a> page to make one there.</p>'}`
            : ''
        }</section>`
  const add = data.canChange
    ? `<section class="panel"><h2>${icon('add')}Add node</h2><ol><li>On the new computer, ${install}</li><li>Start it as a worker: ${command('sudo mason worker --install --link-port 9410')} It prints its pairing key.</li><li>Pair it here:</li></ol>${apiForm('/api/v2/nodes', '<label for="node-address">Address</label><input id="node-address" name="address" placeholder="192.168.1.20:9410" required><label for="node-key">Pairing key</label><input id="node-key" name="key" placeholder="mason1:…" required autocomplete="off">', `${icon('lan')} Pair node`, { fields: ['address', 'key'], then: 'reload' })}</section>`
    : ''
  const types = Object.entries(data.types)
    .map(
      ([name, value]) =>
        `<li><span class="mono">${escape(name)}</span> <small class="mono">${escape(JSON.stringify(value).slice(0, 200))}</small></li>`,
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
          ? `<details><summary>Edit</summary>${apiForm(`/api/v2/cloud/pools/${encodeURIComponent(pool.name)}`, poolFields(`pool-${pool.name}`, account, pool, true), `${icon('check')} Save`, { method: 'PUT', fields: poolFieldNames.filter((name) => name !== 'name') })}</details><div class="actions">${apiForm(`/api/v2/cloud/pools/${encodeURIComponent(pool.name)}`, '', `${icon('delete')} Remove`, { method: 'DELETE', className: 'secondary' })}</div>`
          : ''
      }</section>`
    })
    .join('')
  const addPool = !data.canChange
    ? ''
    : accounts.length === 0
      ? '<p>Add a DigitalOcean account on the <a href="/cloud">Cloud</a> page to make pools.</p>'
      : accounts
          .map(
            (account) =>
              `<details class="add-pool" id="add-pool-${escape(account.id)}"><summary>${icon('add')}Add a pool on ${escape(account.name)}</summary>${account.error == null ? '' : `<p class="notice">${escape(account.error)}</p>`}${apiForm('/api/v2/cloud/pools', poolFields(`new-${account.id}`, account, {}, false), `${icon('add')} Add pool`, { fields: poolFieldNames })}</details>`,
          )
          .join('')
  const poolsPanel = `<section class="panel" id="pools"><h2>${icon('cloud')}Cloud pools</h2><p>Machines made on demand for a node type, reused like your own computers and retired when idle. Monthly budget: $${data.budget.monthly}.</p>${data.budget.notice == null ? '' : `<p class="notice">${escape(data.budget.notice)}</p>`}${pools || '<p>None yet.</p>'}${addPool}</section>`
  return `${head('Nodes', 'Workers and the host, their software, and what each still needs from a person.', ['Nodes'])}${rows || '<p class="empty-state">No nodes are paired.</p>'}<div class="columns"><div>${hostPanel}${add}${poolsPanel}</div><aside><section class="panel"><h2>${icon('tune')}Node types</h2><ul class="plain">${types || '<li>None yet.</li>'}</ul><p><a href="/settings#nodeTypes">Edit in Settings</a></p></section></aside></div>`
}

/** Settings: every area the master keeps, edited as JSON with secrets write-only, plus the Apple ID session. */
export function settingsView(data: {
  areas: Array<{ name: string; value: unknown; error?: string }>
  apple: {
    signedIn: boolean
    appleId?: string
    needsCode: boolean
    notice?: string
  }
  keys: Array<{
    id: string
    name: string
    role: string
    createdAt: number
    revoked: boolean
  }>
  canChange: boolean
  canRevoke: boolean
}): string {
  const areas = data.areas
    .map(
      (area) =>
        `<section class="panel" id="${escape(area.name)}"><h2>${icon('tune')}${escape(area.name)}</h2>${
          area.error != null
            ? `<p>${escape(area.error)}</p>`
            : data.canChange
              ? apiForm(
                  `/api/v2/settings/${area.name}`,
                  `<label for="setting-${escape(area.name)}">Value (JSON; a secret shows as {"set":true}; send {"keep":true} to keep it)</label><textarea id="setting-${escape(area.name)}" name="value" rows="8" class="mono">${escape(JSON.stringify(area.value ?? {}, null, 2))}</textarea>`,
                  `${icon('check')} Save`,
                  { method: 'PUT', json: 'value', then: 'reload' },
                )
              : `<pre class="mono">${escape(JSON.stringify(area.value ?? {}, null, 2))}</pre>`
        }</section>`,
    )
    .join('')
  const apple = `<section class="panel" id="apple-session"><h2>${icon('key')}Apple ID for Xcode downloads</h2><p>${data.apple.signedIn ? `Signed in as ${escape(data.apple.appleId ?? 'the Apple ID')}.` : 'Not signed in.'}</p>${data.apple.notice == null ? '' : `<p class="notice">${escape(data.apple.notice)}</p>`}${
    data.canChange
      ? data.apple.needsCode
        ? apiForm(
            '/api/v2/apple/session/code',
            '<label for="apple-code">Two-factor code</label><input id="apple-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>',
            `${icon('lock')} Send code to the master`,
            { fields: ['code'], then: 'reload' },
          )
        : apiForm(
            '/api/v2/apple/session',
            '<label for="apple-id">Apple ID</label><input id="apple-id" name="appleId" type="email" autocomplete="username" required><label for="apple-password">Password</label><input id="apple-password" name="password" type="password" autocomplete="current-password" required>',
            `${icon('login')} Sign in`,
            { fields: ['appleId', 'password'], then: 'reload' },
          )
      : ''
  }</section>`
  const keys = `<section class="panel" id="keys"><h2>${icon('key')}API keys</h2><table class="list"><thead><tr><th>Name</th><th>Role</th><th>Created</th><th>State</th><th></th></tr></thead><tbody>${
    data.keys
      .map(
        (key) =>
          `<tr><td class="mono">${escape(key.name)}</td><td>${escape(key.role)}</td><td>${escape(ago(key.createdAt, Date.now()))}</td><td>${key.revoked ? 'revoked' : 'active'}</td><td>${data.canRevoke ? apiForm(`/api/v2/keys/${encodeURIComponent(key.id)}`, '', 'Revoke', { method: 'DELETE', then: 'reload', className: 'danger' }) : ''}</td></tr>`,
      )
      .join('') || '<tr><td colspan="5">No keys.</td></tr>'
  }</tbody></table><p>Create keys with <span class="mono">mason keys create</span> or <span class="mono">POST /api/v2/keys</span>; a key's token is shown once.</p></section>`
  return `${head('Settings', 'How this master signs people in, reaches GitHub and Apple, keeps its backups and runs its nodes.', ['Settings'])}<p><a href="/people">People and groups</a> · <a href="/backups">Backups</a> · <a href="/nodes">Nodes</a></p>${apple}${keys}${areas}`
}

/** People and groups: roles and per-method addresses; administrators change them. */
export function peopleView(data: {
  people: Array<{
    id: number
    name: string
    role: string
    email?: string
    addresses: Record<string, string>
    username?: string
  }>
  groups: Array<{
    id: number
    name: string
    apps: Array<{ id: number; slug: string }>
    members: number[]
  }>
  canChange: boolean
  canChangeGroups: boolean
}): string {
  const roles = ['admin', 'manager', 'developer', 'tester']
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
        }</td><td>${data.canChange ? apiForm(`/api/v2/people/${person.id}`, '', 'Remove', { method: 'DELETE', then: 'reload', className: 'danger' }) : ''}</td></tr>`,
    )
    .join('')
  const add = data.canChange
    ? `<section class="panel"><h2>${icon('add')}Add a person</h2>${apiForm('/api/v2/people', `<label for="person-name">Name</label><input id="person-name" name="name" required><label for="person-role">Role</label><select id="person-role" name="role">${roles.map((role) => `<option${role === 'tester' ? ' selected' : ''}>${role}</option>`).join('')}</select><label for="person-email">Email</label><input id="person-email" name="email" type="email" required><p>They sign in with any enabled sign-in method that confirms this address.</p>`, `${icon('add')} Add`, { fields: ['name', 'email', 'role'], then: 'reload' })}</section>`
    : ''
  const name = new Map(data.people.map((person) => [person.id, person.name]))
  const groups = data.groups
    .map(
      (group) =>
        `<li><strong>${escape(group.name)}</strong><small>${group.apps.map((app) => escape(app.slug)).join(', ') || 'No apps'} · ${group.members.map((id) => escape(name.get(id) ?? String(id))).join(', ') || 'No members'}</small></li>`,
    )
    .join('')
  return `${head('People', 'Who signs in, with which addresses, and what their role lets them do.', ['Settings', 'People'])}<table class="list"><thead><tr><th>Person</th><th>Addresses</th><th>Role</th><th></th></tr></thead><tbody>${people || '<tr><td colspan="4">Nobody yet.</td></tr>'}</tbody></table><div class="columns"><div>${add}</div><aside><section class="panel"><h2>${icon('group')}Tester groups</h2><ul class="plain">${groups || '<li>No groups.</li>'}</ul>${
    data.canChangeGroups
      ? apiForm(
          '/api/v2/groups',
          '<label for="group-json">New group (JSON: name, apps, members)</label><textarea id="group-json" name="value" rows="4" class="mono">{"name": "", "apps": [], "members": []}</textarea>',
          `${icon('add')} Add group`,
          { json: 'value', then: 'reload', className: 'secondary' },
        )
      : ''
  }</section></aside></div>`
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
  return `${head(`${data.name} · Masonfile`, 'The Masonfile is the project’s configuration; it changes with the code.', [data.name, 'Masonfile'])}<form method="get" class="actions"><label for="commit" class="sr-only">Commit</label><select id="commit" name="commit">${data.commits.map((entry) => `<option value="${escape(entry.sha)}"${entry.sha === data.commit ? ' selected' : ''}>${escape(entry.sha.slice(0, 12))} · ${escape(entry.branch)}</option>`).join('')}</select><button class="secondary">Show</button></form>${
    data.error != null
      ? `<p class="empty-state">${escape(data.error)}</p>`
      : data.text == null
        ? '<p class="empty-state">Choose a commit.</p>'
        : `<h2 class="mono">${escape(data.file ?? '')}</h2><pre class="log"><code>${lines.map((line, index) => `<span class="line" data-line="${index + 1}">${escape(line)}</span>`).join('')}</code></pre>`
  }`
}

/** A project on the master: repository, app IDs, branch rules, webhook and secrets (names only; values are write-only). */
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
  env: Array<{ name: string; secret: boolean }>
  files: Array<{ destination: string; env?: string }>
  webhook: boolean
  signingLabel?: string
  canChangeSecrets: boolean
  buildNumbers: Array<{
    key: string
    format: string
    scope: string
    last: Array<{ branch: string; value: string }>
  }>
  canSeed: boolean
}): string {
  const keep = {
    env: data.env.map((entry) => ({ name: entry.name, keep: true })),
    files: data.files.map((file) => ({
      destination: file.destination,
      keep: true,
    })),
  }
  return `${head(data.name, data.repository, ['Projects', data.slug])}<p><a href="/?project=${encodeURIComponent(data.slug)}">Runs and builds</a> · <a href="/projects/${encodeURIComponent(data.slug)}/masonfile">Masonfile</a></p><div class="columns"><div><section class="panel"><h2>${icon('apps')}App IDs</h2><ul class="plain">${
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
  }</tbody></table><p>Default branch <span class="mono">${escape(data.defaultBranch)}</span> · ${escape(data.format)} Masonfile · webhook ${data.webhook ? 'set' : 'not set'}${data.signingLabel == null ? '' : ` · signs on nodes labelled <span class="mono">${escape(data.signingLabel)}</span>`}</p></section>${buildNumbersPanel(data)}</div><aside><section class="panel"><h2>${icon('key')}Secrets</h2><ul class="plain">${
    [
      ...data.env.map(
        (entry) =>
          `<li><span class="mono">${escape(entry.name)}</span> <small>${entry.secret ? 'secret' : 'environment'} · set</small></li>`,
      ),
      ...data.files.map(
        (file) =>
          `<li><span class="mono">${escape(file.env ?? file.destination)}</span> <small>file · set</small></li>`,
      ),
    ].join('') || '<li>None.</li>'
  }</ul>${
    data.canChangeSecrets
      ? apiForm(
          `/api/v2/projects/${data.slug}/secrets`,
          `<label for="secrets">Secrets (JSON). Stored values are never shown: keep one with {"keep": true}, replace it with a new "value" or "contents".</label><textarea id="secrets" name="value" rows="8" class="mono">${escape(JSON.stringify(keep, null, 2))}</textarea>`,
          `${icon('lock')} Save secrets`,
          {
            method: 'PUT',
            json: 'value',
            then: 'reload',
            className: 'secondary',
          },
        )
      : ''
  }</section></aside></div>`
}

/** One cloud account on the Cloud page: its provider, what its last check found, and its actions. */
export interface CloudAccountRow {
  id: string
  name: string
  provider: 'digitalocean' | 'nomac'
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
        `<section class="panel" id="account-${escape(account.id)}" data-account="${escape(account.id)}"><h2>${icon('cloud')}${escape(account.name)}</h2><p>${escape(providerLabels[account.provider])} · <span class="mono">${escape(account.id)}</span></p>${state(account)}${
          data.canChange
            ? `<div class="actions">${apiForm(`/api/v2/cloud/accounts/${encodeURIComponent(account.id)}/check`, '', `${icon('refresh')} Check`, { className: 'secondary' })}${apiForm(`/api/v2/cloud/accounts/${encodeURIComponent(account.id)}`, '', `${icon('delete')} Remove`, { method: 'DELETE', className: 'secondary' })}</div>`
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
