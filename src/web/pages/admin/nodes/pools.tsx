// Cloud pools (screen-09-nodes, screen-09b-nodes-host): machines made on
// demand for a node type, with the monthly budget and its notice. Each pool
// lists its machines; Add a pool on an account and Edit are a large sheet
// (Machine; Capacity and retirement), NoMac's variant without region, size
// and image; Remove is a tier-2 Alert.
import { useId, useMemo, useState, type FormEvent, type JSX } from 'react'
import { Link } from 'react-router'
import { asUnknown } from 'cleaners'
import type { CloudBudget } from '../../../../shared/api/admin.js'
import type { CloudAccountView } from '../../../../shared/api/cloud.js'
import {
  asPool,
  CLOUD_POOLS_PATH,
  cloudPoolPath,
  SETUP_LABEL,
  type Pool,
  type PoolRequest,
} from '../../../../shared/api/nodes.js'
import { useApi } from '../../../api/context.js'
import type { Resource } from '../../../hooks/useResource.js'
import { Alert } from '../../../ui/Alert.js'
import { Banner } from '../../../ui/Banner.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { StepperInput, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { FormSection, LargeSheet, useDraft } from '../../../ui/LargeSheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import {
  CardError,
  CardLoading,
  listOf,
  MachineFields,
  SLUG,
  SubmitError,
  useCatalog,
  useSubmit,
} from './parts.js'

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`

/** `1 of at most 3 machines · 1 stage at a time · retire after 60 idle minutes or 24 hours`. */
export const poolCapacity = (pool: Pool): string =>
  `${pool.machines.length} of at most ${plural(pool.maxNodes, 'machine')} · ${plural(pool.slots, 'stage')} at a time · retire after ${pool.ttlMinutes} idle minutes or ${pool.maxHoursPerNode} hours`

/** `linux-x86 · DigitalOcean · sfo3 · s-2vcpu-4gb · setup`; a NoMac pool has no region or size. */
export const poolSummary = (
  pool: Pool,
  account: CloudAccountView | undefined,
): string =>
  [
    pool.type,
    account?.name ?? pool.account,
    ...((account?.provider ?? pool.provider) === 'nomac'
      ? []
      : [pool.region, pool.size]),
    pool.labels.join(', '),
  ]
    .filter((part) => part !== '')
    .join(' · ')

/** The pool sheet's fields, numbers as typed. */
interface PoolForm {
  name: string
  type: string
  region: string
  size: string
  image: string
  labels: string
  maxNodes: number
  slots: number
  ttlMinutes: string
  maxHoursPerNode: string
}

const poolStart = (mac: boolean, pool: Pool | undefined): PoolForm => ({
  name: pool?.name ?? (mac ? 'macos-cloud' : ''),
  type: pool?.type ?? (mac ? 'macos-arm64' : ''),
  region: pool?.region ?? 'sfo3',
  size: pool?.size ?? 's-2vcpu-4gb',
  image: pool?.image ?? 'ubuntu-24-04-x64',
  labels: (pool?.labels ?? [SETUP_LABEL]).join(', '),
  maxNodes: pool?.maxNodes ?? 1,
  slots: pool?.slots ?? 1,
  ttlMinutes: String(pool?.ttlMinutes ?? 60),
  maxHoursPerNode: String(pool?.maxHoursPerNode ?? (mac ? 8 : 24)),
})

/** A whole number in a range, or why not. */
const whole = (text: string, min: number, max: number): string | undefined =>
  /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max
    ? undefined
    : `A whole number from ${min} to ${max}.`

/** Add a pool on an account, or edit one (it keeps its name). */
export function PoolSheet({
  account,
  pool,
  open,
  budget,
  onClose,
  onSaved,
}: {
  account: CloudAccountView
  /** The pool edited; none adds one. */
  pool: Pool | undefined
  open: boolean
  budget: CloudBudget | undefined
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const submit = useSubmit()
  const formId = useId()
  const mac = account.provider === 'nomac'
  // Taken when the sheet opens: useDraft adopts it as its key changes.
  const start = useMemo(() => poolStart(mac, pool), [mac, pool])
  const draft = useDraft<PoolForm>(
    open ? `pool:${account.id}:${pool?.name ?? ''}` : null,
    start,
  )
  const catalog = useCatalog(account, open && !mac)
  const [errors, setErrors] = useState<Partial<Record<keyof PoolForm, string>>>(
    {},
  )
  const form = draft.value
  const set = (fields: Partial<PoolForm>): void =>
    draft.set((was) => ({ ...was, ...fields }))
  const maxHours = mac ? 8 : 720
  const close = (): void => {
    draft.clear()
    setErrors({})
    submit.clear()
    onClose()
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const slug = 'Lowercase letters, digits and dashes, up to 40.'
    const ttl = whole(form.ttlMinutes, 1, 1440)
    const hours = whole(form.maxHoursPerNode, 1, maxHours)
    const wrong: Partial<Record<keyof PoolForm, string>> = {
      ...(pool == null && !SLUG.test(form.name) ? { name: slug } : {}),
      ...(SLUG.test(form.type) ? {} : { type: slug }),
      ...(ttl == null ? {} : { ttlMinutes: ttl }),
      ...(hours == null ? {} : { maxHoursPerNode: hours }),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const name = pool?.name ?? form.name
    const body: PoolRequest = {
      account: account.id,
      name,
      type: form.type,
      ...(mac
        ? {}
        : { region: form.region, size: form.size, image: form.image }),
      labels: listOf(form.labels),
      maxNodes: mac ? 1 : form.maxNodes,
      slots: form.slots,
      ttlMinutes: Number(form.ttlMinutes),
      maxHoursPerNode: Number(form.maxHoursPerNode),
    }
    if (
      await submit.run(async () => {
        if (pool == null) await client.post(CLOUD_POOLS_PATH, asPool, { body })
        else await client.put(cloudPoolPath(pool.name), asPool, { body })
      })
    ) {
      toast({
        text: pool == null ? `${name} added` : `${name} saved`,
        icon: 'check_circle',
      })
      close()
      onSaved()
    }
  }
  return (
    <LargeSheet
      open={open}
      onClose={close}
      title={
        pool == null ? `Add a pool on ${account.name}` : `Edit ${pool.name}`
      }
      dirty={draft.dirty}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon={pool == null ? 'add' : 'check'}
            busy={submit.busy}
          >
            {pool == null ? 'Add pool' : 'Save'}
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
        {budget?.notice != null ? (
          <Banner
            tone="warning"
            icon="monitoring"
            compact
            title={budget.notice}
          />
        ) : budget != null ? (
          <p className="m-t-subhead m-secondary m-nodes__flush">
            Monthly budget across all pools: ${budget.monthly}.
          </p>
        ) : null}
        <FormSection legend="Machine">
          {pool == null && (
            <TextInput
              label="Name"
              value={form.name}
              onChange={(name) => set({ name })}
              required
              mono
              verbatim
              autoComplete="off"
              placeholder="linux-cloud"
              help="The pool’s name on this master."
              error={errors.name}
            />
          )}
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
          {mac ? (
            <p className="m-t-subhead m-secondary m-nodes__wide m-nodes__flush">
              NoMac runs one Apple silicon Mac with Xcode at a time, for up to
              eight hours.
            </p>
          ) : (
            <MachineFields
              account={account}
              catalog={catalog}
              value={form}
              onChange={(choice) => set(choice)}
              imageLabel="Base image"
            />
          )}
          <TextInput
            label="Labels"
            optional
            value={form.labels}
            onChange={(labels) => set({ labels })}
            mono
            verbatim
            autoComplete="off"
            help={`Labels its machines carry, comma-separated, for stages that ask for them. Machines labelled ${SETUP_LABEL} run setup.`}
          />
        </FormSection>
        <FormSection legend="Capacity and retirement">
          {mac ? (
            <TextInput
              label="Max machines"
              value="1"
              onChange={() => undefined}
              readOnly
              mono
              help="NoMac pools run one machine."
            />
          ) : (
            <StepperInput
              label="Max machines"
              value={form.maxNodes}
              onChange={(maxNodes) => set({ maxNodes })}
              min={1}
              max={50}
              unit="machines"
              help="1–50. Spin up no more than this many at once."
            />
          )}
          <StepperInput
            label="Stages per machine"
            value={form.slots}
            onChange={(slots) => set({ slots })}
            min={1}
            max={64}
            unit="stages"
            help="1–64. How many stages one machine runs at the same time."
          />
          <TextInput
            label="Retire after idle minutes"
            value={form.ttlMinutes}
            onChange={(ttlMinutes) => set({ ttlMinutes })}
            required
            mono
            inputMode="numeric"
            autoComplete="off"
            help="1–1440. A machine with no stage to run for this long is shut down and deleted."
            error={errors.ttlMinutes}
          />
          <TextInput
            label="Retire after hours up"
            value={form.maxHoursPerNode}
            onChange={(maxHoursPerNode) => set({ maxHoursPerNode })}
            required
            mono
            inputMode="numeric"
            autoComplete="off"
            help={`1–${maxHours}. A machine is replaced after this many hours, even if it keeps getting work; its current stage finishes first.`}
            error={errors.maxHoursPerNode}
          />
        </FormSection>
        <SubmitError submit={submit} />
      </form>
    </LargeSheet>
  )
}

/** One pool: what it makes, its capacity and its machines; a manager's Edit and Remove. */
function PoolRow({
  pool,
  account,
  canChange,
  budget,
  onChanged,
}: {
  pool: Pool
  account: CloudAccountView | undefined
  canChange: boolean
  budget: CloudBudget | undefined
  onChanged: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const remove = useSubmit()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  return (
    <li className="m-list__row m-nodes__row" data-pool={pool.name}>
      <span className="m-list__main m-stack m-nodes__tight">
        <span className="m-t-mono m-nodes__name">{pool.name}</span>
        <span className="m-list__sub m-t-mono-sm">
          {poolSummary(pool, account)}
        </span>
        <span className="m-list__sub">{poolCapacity(pool)}</span>
        {pool.machines.length > 0 && (
          <ul
            className="m-nodes__machines"
            aria-label={`${pool.name}’s machines`}
          >
            {pool.machines.map((machine) => (
              <li key={machine.id} className="m-row">
                <span className="m-chip m-chip--mono">{machine.id}</span>
                <StatusPill status={machine.state} quiet />
                {machine.address != null && (
                  <span className="m-t-mono-sm m-tertiary">
                    {machine.address}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <SubmitError submit={remove} />
      </span>
      {canChange && (
        <span className="m-list__end">
          <Button
            variant="secondary"
            size="sm"
            icon="edit"
            aria-haspopup="dialog"
            aria-label={`Edit ${pool.name}`}
            disabled={account == null}
            title={account == null ? 'Its cloud account is gone' : undefined}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="delete"
            aria-haspopup="dialog"
            aria-label={`Remove ${pool.name}`}
            busy={remove.busy}
            onClick={() => setRemoving(true)}
          >
            Remove
          </Button>
        </span>
      )}
      {canChange && account != null && (
        <PoolSheet
          account={account}
          pool={pool}
          open={editing}
          budget={budget}
          onClose={() => setEditing(false)}
          onSaved={onChanged}
        />
      )}
      {canChange && (
        <Alert
          open={removing}
          title={`Remove the pool ${pool.name}?`}
          message={`Its ${plural(pool.machines.length, 'machine')} retire: each finishes its current stage and is destroyed. Stages that ask for ${pool.type} wait for another node.`}
          confirm="Remove"
          tone="danger"
          busy={remove.busy}
          onCancel={() => setRemoving(false)}
          onConfirm={() =>
            void remove
              .run(async () => {
                await client.delete(cloudPoolPath(pool.name), asUnknown)
              })
              .then((done) => {
                setRemoving(false)
                if (!done) return
                toast({ text: `${pool.name} removed`, icon: 'delete' })
                onChanged()
              })
          }
        />
      )}
    </li>
  )
}

/** The Cloud pools card: the budget, every pool, and Add a pool per account. */
export function PoolsCard({
  read,
  budget,
  accounts,
  canChange,
  onChanged,
}: {
  read: Resource<Pool[]>
  budget: Resource<CloudBudget>
  accounts: Resource<CloudAccountView[]>
  canChange: boolean
  onChanged: () => void
}): JSX.Element {
  const [adding, setAdding] = useState<string | undefined>()
  const all = accounts.data ?? []
  const money = budget.data
  return (
    <section className="m-card" aria-labelledby="nodes-pools-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="cloud" />
          <h2 className="m-t-title3" id="nodes-pools-title">
            Cloud pools
          </h2>
          {money != null && (
            <span className="m-count">Budget ${money.monthly} / month</span>
          )}
        </div>
        {canChange && all.length > 0 && (
          <div className="m-btngroup">
            {all.map((account) => (
              <Button
                key={account.id}
                variant="tinted"
                size="sm"
                icon="add"
                aria-haspopup="dialog"
                onClick={() => setAdding(account.id)}
              >
                Add a pool on {account.name}
              </Button>
            ))}
          </div>
        )}
      </header>
      <div className="m-card__body m-stack">
        <p className="m-t-subhead m-secondary m-nodes__flush">
          Machines made on demand for a node type, reused like your own
          computers and retired when idle.
          {money != null && ` Monthly budget: $${money.monthly}.`}
        </p>
        {money?.notice != null && (
          <Banner
            tone="warning"
            icon="monitoring"
            compact
            title={money.notice}
          />
        )}
        {budget.error != null && (
          <CardError
            what="The budget"
            message={budget.error.message}
            retry={budget.reload}
          />
        )}
        {canChange && accounts.data?.length === 0 && (
          <p className="m-t-subhead m-secondary m-nodes__flush">
            Add a DigitalOcean or NoMac account on the{' '}
            <Link to="/cloud">Cloud</Link> page to make pools.
          </p>
        )}
        {accounts.error != null && (
          <CardError
            what="The cloud accounts"
            message={accounts.error.message}
            retry={accounts.reload}
          />
        )}
      </div>
      {read.data == null ? (
        read.error != null ? (
          <CardError
            what="The pools"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <CardLoading label="Loading the pools" />
        )
      ) : read.data.length === 0 ? (
        <EmptyState icon="cloud" title="None yet." />
      ) : (
        <ul className="m-list">
          {read.data.map((pool) => (
            <PoolRow
              key={pool.name}
              pool={pool}
              account={all.find((account) => account.id === pool.account)}
              canChange={canChange}
              budget={money}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {canChange &&
        all.map((account) => (
          <PoolSheet
            key={account.id}
            account={account}
            pool={undefined}
            open={adding === account.id}
            budget={money}
            onClose={() => setAdding(undefined)}
            onSaved={onChanged}
          />
        ))}
    </section>
  )
}
