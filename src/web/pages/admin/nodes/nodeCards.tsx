// The paired nodes (screen-09-nodes): a card per node with its status, what
// it runs and reported, and its checklist; Edit as a form sheet (a host has
// only its name); and Pair a node, the how-to and its fields in a sheet.
import { useState, type FormEvent, type JSX } from 'react'
import { Link } from 'react-router'
import {
  asNamed,
  nodePath,
  SETUP_LABEL,
  type NodeCard as Node,
  type NodeChange,
  type NodePairing,
} from '../../../../shared/api/nodes.js'
import { NODES_PATH } from '../../../../shared/api/admin.js'
import { bytes } from '../../../../shared/format.js'
import { useApi } from '../../../api/context.js'
import type { Resource } from '../../../hooks/useResource.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { StepperInput, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import type { IconName } from '../../../ui/icons.js'
import { Sheet } from '../../../ui/Sheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import {
  CardError,
  CardLoading,
  InstallStep,
  listOf,
  NODE_TYPE,
  SubmitError,
  useSubmit,
  type Release,
} from './parts.js'

/** An operating system's name as people write it. */
const OS_NAMES: Record<string, string> = {
  macos: 'macOS',
  darwin: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
}

/** `worker · macos-arm64 · 2 slots · setup, mac-signing`. */
export const nodeSummary = (node: Node): string =>
  [
    node.role,
    node.type,
    node.role === 'worker'
      ? `${node.slots} slot${node.slots === 1 ? '' : 's'}`
      : '',
    node.labels.join(', '),
  ]
    .filter((part) => part !== '')
    .join(' · ')

/** `Mason 0.6.0 · macOS 15.1 arm64 · 120.4 GB free`: what it runs and reported. */
export const nodeFacts = (node: Node): string[] => {
  const inventory = node.inventory
  const os =
    inventory?.os == null
      ? ''
      : [
          OS_NAMES[inventory.os] ?? inventory.os,
          inventory.osVersion ?? '',
          inventory.arch ?? '',
        ]
          .filter((part) => part !== '')
          .join(' ')
  return [
    node.version === '' ? '' : `Mason ${node.version}`,
    os,
    inventory?.freeDisk == null ? '' : `${bytes(inventory.freeDisk)} free`,
  ].filter((part) => part !== '')
}

/** Up to six tools and their versions: `node 24.1 · java 21`. */
export const nodeTools = (tools: Record<string, unknown>): string =>
  Object.entries(tools)
    .flatMap(([name, value]) => {
      const versions = Array.isArray(value)
        ? value.map(String)
        : typeof value === 'object' && value != null && 'version' in value
          ? [String((value as { version: unknown }).version)]
          : value == null || value === ''
            ? []
            : [String(value)]
      return versions.length === 0 ? [] : [`${name} ${versions.join(', ')}`]
    })
    .slice(0, 6)
    .join(' · ')

/** The glyph for what a node is. */
const nodeIcon = (node: Node): IconName =>
  node.role === 'host'
    ? 'cloud'
    : node.inventory?.os === 'macos' || node.inventory?.os === 'darwin'
      ? 'desktop_mac'
      : node.inventory?.os === 'windows'
        ? 'desktop_windows'
        : 'dns'

/** The stage it runs: `<run id> <stage>`, the run linked. */
function Running({ stage }: { stage: string }): JSX.Element {
  const [run = '', ...rest] = stage.split(' ')
  return (
    <>
      Running{' '}
      <Link className="m-t-mono-sm" to={`/runs/${encodeURIComponent(run)}`}>
        {run} {rest.join(' ')}
      </Link>
    </>
  )
}

/** One paired node. */
export function NodeCard({
  node,
  onEdit,
}: {
  node: Node
  /** A manager's Edit; none hides it. */
  onEdit?: (() => void) | undefined
}): JSX.Element {
  const facts = nodeFacts(node)
  const xcodes = (node.inventory?.xcodes ?? []).map((xcode) => xcode.version)
  const tools = nodeTools(node.inventory?.tools ?? {})
  const titleId = `node-${node.id}`
  return (
    <article
      className="m-card m-nodes__node"
      aria-labelledby={titleId}
      data-node={node.name}
    >
      <header className="m-card__header m-nodes__nodehead">
        <span className="m-glyphbox">
          <Icon name={nodeIcon(node)} />
        </span>
        <div className="m-list__main">
          <h2 className="m-t-title3 m-t-mono m-wrap-any" id={titleId}>
            {node.name}
          </h2>
          <span className="m-t-mono-sm m-secondary">{nodeSummary(node)}</span>
        </div>
        <StatusPill status={node.status} />
        {onEdit != null && (
          <Button
            variant="secondary"
            size="sm"
            icon="edit"
            aria-haspopup="dialog"
            aria-label={`Edit ${node.name}`}
            onClick={onEdit}
          >
            Edit
          </Button>
        )}
      </header>
      <div className="m-card__body m-stack">
        <dl className="m-kv">
          <dt>Now</dt>
          <dd>
            {node.stage == null ? (
              node.status.charAt(0).toUpperCase() + node.status.slice(1)
            ) : (
              <Running stage={node.stage} />
            )}
            {facts.map((fact) => ` · ${fact}`).join('')}
          </dd>
          {xcodes.length > 0 && (
            <>
              <dt>Xcode</dt>
              <dd className="m-t-mono-sm">{xcodes.join(', ')}</dd>
            </>
          )}
          {tools !== '' && (
            <>
              <dt>Tools</dt>
              <dd className="m-t-mono-sm">{tools}</dd>
            </>
          )}
        </dl>
        {node.checklist.length > 0 && (
          <div>
            <h3 className="m-t-eyebrow m-nodes__eyebrow">Checklist</h3>
            <ul className="m-checklist">
              {node.checklist.map((item, n) => (
                <li key={item.id ?? n}>
                  <Icon
                    name={item.done ? 'check_circle' : 'warning'}
                    className={item.done ? 'done' : 'todo'}
                    label={item.done ? 'Done' : 'To do'}
                  />
                  <span>{item.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  )
}

/** Edit a node: its name; a worker's type, labels and slots too. */
export function EditNodeSheet({
  node,
  onClose,
  onSaved,
}: {
  node: Node | undefined
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const submit = useSubmit()
  const [form, setForm] = useState<{
    for: string | undefined
    name: string
    type: string
    labels: string
    slots: number
  }>({ for: undefined, name: '', type: '', labels: '', slots: 1 })
  const [errors, setErrors] = useState<{ name?: string; type?: string }>({})
  // A node opened anew starts from what it has.
  if (node != null && form.for !== node.fingerprint) {
    setForm({
      for: node.fingerprint,
      name: node.name,
      type: node.type,
      labels: node.labels.join(', '),
      slots: node.slots,
    })
    setErrors({})
    submit.clear()
  }
  const worker = node?.role === 'worker'
  const dirty =
    node != null &&
    form.for === node.fingerprint &&
    (form.name !== node.name ||
      form.type !== node.type ||
      form.labels !== node.labels.join(', ') ||
      form.slots !== node.slots)
  const close = (): void => {
    setForm((was) => ({ ...was, for: undefined }))
    onClose()
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (node == null) return
    const name = form.name.trim()
    const wrong = {
      ...(name === '' ? { name: 'Enter a name.' } : {}),
      ...(worker && form.type !== '' && !NODE_TYPE.test(form.type)
        ? {
            type: 'Up to 64 letters, digits, dots, dashes and underscores.',
          }
        : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const body: NodeChange = worker
      ? {
          name,
          type: form.type,
          labels: listOf(form.labels),
          slots: form.slots,
        }
      : { name }
    if (
      await submit.run(async () => {
        await client.put(nodePath(node.fingerprint), asNamed, { body })
      })
    ) {
      toast({ text: `${name} saved`, icon: 'check_circle' })
      close()
      onSaved()
    }
  }
  return (
    <Sheet
      open={node != null}
      onClose={close}
      title={`Edit ${node?.name ?? ''}`}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="node-edit"
            busy={submit.busy}
          >
            Save
          </Button>
        </>
      )}
    >
      <form
        noValidate
        id="node-edit"
        className="m-stack"
        onSubmit={(e) => void save(e)}
      >
        <TextInput
          label="Name"
          value={form.name}
          onChange={(name) => setForm({ ...form, name })}
          required
          maxLength={128}
          autoComplete="off"
          error={errors.name}
        />
        {worker && (
          <>
            <TextInput
              label="Node type"
              optional
              value={form.type}
              onChange={(type) => setForm({ ...form, type })}
              mono
              verbatim
              autoComplete="off"
              placeholder="linux-x86"
              help="The type a Masonfile selects it by."
              error={errors.type}
            />
            <TextInput
              label="Labels"
              optional
              value={form.labels}
              onChange={(labels) => setForm({ ...form, labels })}
              mono
              verbatim
              autoComplete="off"
              help={`Comma-separated, for stages that ask for them. A node labelled ${SETUP_LABEL} runs setup; a dedicated node leaves it out.`}
            />
            <StepperInput
              label="Slots"
              value={form.slots}
              onChange={(slots) => setForm({ ...form, slots })}
              min={1}
              max={64}
              unit="slots"
              help="Stages it runs at a time, 1–64."
            />
          </>
        )}
        <SubmitError submit={submit} />
      </form>
    </Sheet>
  )
}

/** Pair a node: install it, then its address, key, and optionally its type and labels. */
export function PairNodeSheet({
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
  const blank = { address: '', key: '', type: '', labels: SETUP_LABEL }
  const [form, setForm] = useState(blank)
  const [errors, setErrors] = useState<{
    address?: string
    key?: string
    type?: string
  }>({})
  const dirty = JSON.stringify(form) !== JSON.stringify(blank)
  const close = (): void => {
    setForm(blank)
    setErrors({})
    submit.clear()
    onClose()
  }
  const pair = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(form.address.trim() === ''
        ? { address: 'Enter the node’s address and port.' }
        : {}),
      ...(form.key.trim() === '' ? { key: 'Enter the pairing key.' } : {}),
      ...(form.type !== '' && !NODE_TYPE.test(form.type)
        ? {
            type: 'Up to 64 letters, digits, dots, dashes and underscores.',
          }
        : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const body: NodePairing = {
      address: form.address.trim(),
      key: form.key.trim(),
      ...(form.type === '' ? {} : { type: form.type }),
      labels: listOf(form.labels),
    }
    let name: string | undefined
    if (
      await submit.run(async () => {
        name = (await client.post(NODES_PATH, asNamed, { body })).name
      })
    ) {
      toast({ text: `${name ?? 'The node'} paired`, icon: 'lan' })
      close()
      onPaired()
    }
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Pair a node"
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="node-pair"
            icon="lan"
            busy={submit.busy}
          >
            Pair node
          </Button>
        </>
      )}
    >
      <p className="m-t-subhead m-secondary m-nodes__flush">
        Add a node, which Mason can use for building, signing, and testing apps,
        or any other pipeline tasks. Run the following commands to start Mason
        on a Linux or macOS computer (Windows coming).
      </p>
      <form noValidate id="node-pair" onSubmit={(e) => void pair(e)}>
        <ol className="m-howto">
          <InstallStep
            release={release}
            role="worker"
            where="On the new computer."
          />
          <li>
            <div>
              <span className="m-t-headline">Pair it here</span>
              <TextInput
                label="Address and port"
                value={form.address}
                onChange={(address) => setForm({ ...form, address })}
                required
                mono
                verbatim
                autoComplete="off"
                placeholder="192.168.1.20:9310"
                error={errors.address}
              />
              <TextInput
                label="Pairing key"
                value={form.key}
                onChange={(key) => setForm({ ...form, key })}
                required
                mono
                verbatim
                autoComplete="off"
                placeholder="mason1:…"
                error={errors.key}
              />
              <TextInput
                label="Node type"
                optional
                value={form.type}
                onChange={(type) => setForm({ ...form, type })}
                mono
                verbatim
                autoComplete="off"
                placeholder="linux-x86"
                help="The type a Masonfile selects it by."
                error={errors.type}
              />
              <TextInput
                label="Labels"
                optional
                value={form.labels}
                onChange={(labels) => setForm({ ...form, labels })}
                mono
                verbatim
                autoComplete="off"
                help={`Comma-separated. A node labelled ${SETUP_LABEL} runs setup; a dedicated node leaves it out.`}
              />
              <SubmitError submit={submit} />
            </div>
          </li>
        </ol>
      </form>
    </Sheet>
  )
}

/** Every paired node, or why none shows. */
export function NodeList({
  read,
  canChange,
  onPair,
  onEdit,
}: {
  read: Resource<Node[]>
  canChange: boolean
  onPair: () => void
  onEdit: (node: Node) => void
}): JSX.Element {
  if (read.data == null)
    return (
      <section className="m-card" aria-label="Nodes">
        {read.error != null ? (
          <CardError
            what="The nodes"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <CardLoading label="Loading the nodes" />
        )}
      </section>
    )
  if (read.data.length === 0)
    return (
      <section className="m-card" aria-label="Nodes">
        <EmptyState
          icon="dns"
          title="No nodes are paired."
          actions={
            canChange && (
              <Button
                variant="primary"
                size="sm"
                icon="lan"
                aria-haspopup="dialog"
                onClick={onPair}
              >
                Pair a node
              </Button>
            )
          }
        >
          Install Mason as a worker on a Mac or Linux machine, then pair it
          here.
        </EmptyState>
      </section>
    )
  return (
    <>
      {read.data.map((node) => (
        <NodeCard
          key={node.fingerprint}
          node={node}
          onEdit={canChange ? (): void => onEdit(node) : undefined}
        />
      ))}
    </>
  )
}
