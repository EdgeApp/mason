// Cloud nodes (screen-09b-nodes-host): permanent workers the master keeps
// on DigitalOcean, each with its state, type, labels, place and error;
// Create a node on an account (a form sheet), Reconcile, and Remove (tier
// 3: its name typed). Without `settings.change` the cards are read-only.
import { useId, useState, type FormEvent, type JSX } from 'react'
import { asUnknown } from 'cleaners'
import type { CloudAccountView } from '../../../../shared/api/cloud.js'
import {
  asCloudMachine,
  asNamed,
  CLOUD_NODES_PATH,
  cloudNodePath,
  SETUP_LABEL,
  type CloudMachine,
  type CloudNodeRequest,
} from '../../../../shared/api/nodes.js'
import { useApi } from '../../../api/context.js'
import type { Resource } from '../../../hooks/useResource.js'
import { Alert } from '../../../ui/Alert.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { Sheet } from '../../../ui/Sheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import { digitalOcean } from './host.js'
import {
  CardError,
  CardLoading,
  listOf,
  machineLine,
  MachineError,
  MachineFields,
  SLUG,
  SubmitError,
  UpdatingNotice,
  useCatalog,
  useSubmit,
  type MachineChoice,
} from './parts.js'

interface NodeForm extends MachineChoice {
  name: string
  type: string
  labels: string
}

const NODE_START: NodeForm = {
  name: '',
  type: '',
  labels: SETUP_LABEL,
  region: 'sfo3',
  size: 's-1vcpu-1gb',
  image: 'ubuntu-24-04-x64',
}

/** Create a permanent node on one DigitalOcean account. */
export function CreateNodeSheet({
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
  const catalog = useCatalog(account, open)
  const [form, setForm] = useState(NODE_START)
  const [errors, setErrors] = useState<{ name?: string; type?: string }>({})
  const set = (fields: Partial<NodeForm>): void =>
    setForm((was) => ({ ...was, ...fields }))
  const close = (): void => {
    setForm(NODE_START)
    setErrors({})
    submit.clear()
    onClose()
  }
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const slug = 'Lowercase letters, digits and dashes, up to 40.'
    const wrong = {
      ...(SLUG.test(form.name) ? {} : { name: slug }),
      ...(SLUG.test(form.type) ? {} : { type: slug }),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const body: CloudNodeRequest = {
      account: account.id,
      name: form.name,
      type: form.type,
      labels: listOf(form.labels),
      region: form.region,
      size: form.size,
      image: form.image,
    }
    if (
      await submit.run(async () => {
        await client.post(CLOUD_NODES_PATH, asNamed, { body })
      })
    ) {
      toast({ text: `Making the node ${form.name}`, icon: 'cloud' })
      close()
      onCreated()
    }
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Create a node on ${account.name}`}
      dirty={JSON.stringify(form) !== JSON.stringify(NODE_START)}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="add"
            busy={submit.busy}
          >
            Create node
          </Button>
        </>
      )}
    >
      <form
        noValidate
        id={formId}
        className="m-stack"
        onSubmit={(event) => void create(event)}
      >
        <p className="m-t-subhead m-secondary m-nodes__flush">
          A DigitalOcean machine that stays a worker until you remove it. It
          needs no public address: only this master reaches it, on its link
          port.
        </p>
        <TextInput
          label="Name"
          value={form.name}
          onChange={(name) => set({ name })}
          required
          mono
          verbatim
          autoComplete="off"
          placeholder="linux-node"
          help="The node’s name on this master and its droplet’s."
          error={errors.name}
        />
        <TextInput
          label="Node type"
          value={form.type}
          onChange={(type) => set({ type })}
          required
          mono
          verbatim
          autoComplete="off"
          placeholder="linux-x86"
          help="Type of node as specified in the Masonfile."
          error={errors.type}
        />
        <TextInput
          label="Labels"
          optional
          value={form.labels}
          onChange={(labels) => set({ labels })}
          mono
          verbatim
          autoComplete="off"
          help={`Labels it carries, comma-separated, for stages that ask for them. A node labelled ${SETUP_LABEL} runs setup.`}
        />
        <MachineFields
          account={account}
          catalog={catalog}
          value={form}
          onChange={(choice) => set(choice)}
        />
        <SubmitError submit={submit} />
      </form>
    </Sheet>
  )
}

/** One cloud node: its facts, and a manager's Reconcile and Remove. */
function CloudNodeRow({
  node,
  canChange,
  onChanged,
}: {
  node: CloudMachine
  canChange: boolean
  onChanged: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const reconcile = useSubmit()
  const remove = useSubmit()
  const [removing, setRemoving] = useState(false)
  const kind = [node.node_type ?? '', ...node.labels].filter(
    (part) => part !== '',
  )
  return (
    <li className="m-list__row m-nodes__row" data-cloud-node={node.name}>
      <span className="m-list__main m-stack m-nodes__tight">
        <span className="m-row">
          <span className="m-t-mono m-nodes__name">{node.name}</span>
          <StatusPill status={node.state} quiet />
        </span>
        <span className="m-list__sub m-t-mono-sm">
          {machineLine(node, kind)}
        </span>
        <UpdatingNotice machine={node} />
        <MachineError machine={node} />
        <SubmitError submit={reconcile} />
        <SubmitError submit={remove} />
      </span>
      {canChange && (
        <span className="m-list__end">
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            busy={reconcile.busy}
            aria-label={`Reconcile ${node.name}`}
            onClick={() =>
              void reconcile
                .run(async () => {
                  await client.post(
                    cloudNodePath(node.name, 'reconcile'),
                    asCloudMachine,
                  )
                })
                .then((done) => {
                  if (!done) return
                  toast({ text: `${node.name} checked again`, icon: 'refresh' })
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
            aria-label={`Remove ${node.name}`}
            busy={remove.busy}
            onClick={() => setRemoving(true)}
          >
            Remove
          </Button>
          <Alert
            open={removing}
            title={`Remove the node ${node.name}?`}
            message="Its droplet is destroyed and it is unpaired. A stage it runs now fails."
            confirm="Remove node"
            tone="danger"
            typeToConfirm={node.name}
            busy={remove.busy}
            onCancel={() => setRemoving(false)}
            onConfirm={() =>
              void remove
                .run(async () => {
                  await client.delete(cloudNodePath(node.name), asUnknown, {
                    body: { confirm: node.name },
                  })
                })
                .then((done) => {
                  setRemoving(false)
                  if (!done) return
                  toast({ text: `${node.name} removed`, icon: 'delete' })
                  onChanged()
                })
            }
          />
        </span>
      )}
    </li>
  )
}

/** The Cloud nodes card: hidden while there are none and none may be made. */
export function CloudNodesCard({
  read,
  accounts,
  canChange,
  onChanged,
}: {
  read: Resource<CloudMachine[]>
  accounts: CloudAccountView[]
  canChange: boolean
  onChanged: () => void
}): JSX.Element | null {
  const [creating, setCreating] = useState<string | undefined>()
  const ocean = canChange ? digitalOcean(accounts) : []
  if (read.data != null && read.data.length === 0 && ocean.length === 0)
    return null
  return (
    <section className="m-card" aria-labelledby="nodes-cloud-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="dns" />
          <h2 className="m-t-title3" id="nodes-cloud-title">
            Cloud nodes
          </h2>
        </div>
        {ocean.length > 0 && (
          <div className="m-btngroup">
            {ocean.map((account) => (
              <Button
                key={account.id}
                variant="tinted"
                size="sm"
                icon="add"
                aria-haspopup="dialog"
                onClick={() => setCreating(account.id)}
              >
                Create a node on {account.name}
              </Button>
            ))}
          </div>
        )}
      </header>
      {read.data == null ? (
        read.error != null ? (
          <CardError
            what="The cloud nodes"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <CardLoading label="Loading the cloud nodes" />
        )
      ) : read.data.length === 0 ? (
        <EmptyState icon="dns" title="None yet.">
          A DigitalOcean machine that stays a worker until you remove it.
        </EmptyState>
      ) : (
        <ul className="m-list">
          {read.data.map((node) => (
            <CloudNodeRow
              key={node.name}
              node={node}
              canChange={canChange}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {ocean.map((account) => (
        <CreateNodeSheet
          key={account.id}
          account={account}
          open={creating === account.id}
          onClose={() => setCreating(undefined)}
          onCreated={onChanged}
        />
      ))}
    </section>
  )
}
