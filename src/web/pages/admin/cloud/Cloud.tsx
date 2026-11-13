// Cloud, on the master (screen-11-cloud): one card per provider account
// with its last check as the master stored it (the page never asks the
// provider on load), and whether an administrator keyed a DigitalOcean
// account, which a host needs. Check asks again and shows what it found;
// managers replace a key or add an account in a form sheet, and remove an
// account after a confirm (tier 2). A key is write-only once stored.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type RefObject,
} from 'react'
import { asUnknown } from 'cleaners'
import {
  asCloudAccountView,
  asCloudAccountViews,
  cloudAccountCheckPath,
  cloudAccountKeyPath,
  cloudAccountPath,
  CLOUD_ACCOUNTS_PATH,
  type CloudAccountCheck,
  type CloudAccountView,
  type CloudProviderName,
} from '../../../../shared/api/cloud.js'
import { relativeTime } from '../../../../shared/format.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Alert } from '../../../ui/Alert.js'
import { Banner } from '../../../ui/Banner.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { FormError, SelectInput, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { Sheet } from '../../../ui/Sheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import { Failed, Loading } from '../../projects/project.js'

export const PROVIDERS: Record<CloudProviderName, string> = {
  digitalocean: 'DigitalOcean',
  nomac: 'NoMac',
}

/** A check that is not ok, in words: its pill's key and the line's start. */
const FAILURES: Record<
  Exclude<CloudAccountCheck['state'], 'ok'>,
  { status: string; words: string }
> = {
  refused: { status: 'refused', words: 'Key refused' },
  timeout: { status: 'noanswer', words: 'No answer' },
  unavailable: { status: 'unavailable', words: 'Unavailable' },
  error: { status: 'error', words: 'Check failed' },
}

/** The status pill of an account's last check. */
export const checkStatus = (check: CloudAccountCheck | undefined): string =>
  check == null
    ? 'unchecked'
    : check.state === 'ok'
      ? 'ok'
      : FAILURES[check.state].status

/** A check's outcome in words, for the toast after Check. */
export const checkWords = (check: CloudAccountCheck | undefined): string =>
  check == null
    ? 'not checked'
    : check.state === 'ok'
      ? 'OK'
      : FAILURES[check.state].words

/** NoMac's credit: `$42.50 (12.3 hours)`. */
export const credit = (dollars: number, seconds: number): string =>
  `$${dollars.toFixed(2)} (${(seconds / 3600).toFixed(1)} hours)`

/** What the last check found: the provider's facts, or why it failed. */
function CheckState({
  check,
  now,
}: {
  check: CloudAccountCheck | undefined
  now: number
}): JSX.Element {
  if (check == null)
    return <p className="m-t-callout m-cloud__line">Not checked yet.</p>
  const when = (
    <span className="m-t-subhead m-tertiary">
      Checked{' '}
      <time dateTime={new Date(check.checkedAt).toISOString()}>
        {relativeTime(check.checkedAt, now)}
      </time>
    </span>
  )
  if (check.state !== 'ok')
    return (
      <>
        <Banner tone="danger" title={FAILURES[check.state].words}>
          {check.message ?? ''}
        </Banner>
        {when}
      </>
    )
  return (
    <>
      {check.digitalocean != null && (
        <dl className="m-kv">
          <dt>Account</dt>
          <dd>{check.digitalocean.email}</dd>
          <dt>Droplet limit</dt>
          <dd className="m-num">{check.digitalocean.dropletLimit}</dd>
          <dt>Status</dt>
          <dd>{check.digitalocean.status}</dd>
        </dl>
      )}
      {check.nomac != null && (
        <dl className="m-kv">
          <dt>Credit</dt>
          <dd className="m-num">
            {credit(check.nomac.credit, check.nomac.spendableSeconds)}
          </dd>
          <dt>Macs at a time</dt>
          <dd className="m-num">{check.nomac.concurrency}</dd>
          {check.nomac.spendingBlocked && (
            <>
              <dt>Spending</dt>
              <dd>Paused for the account</dd>
            </>
          )}
        </dl>
      )}
      {when}
    </>
  )
}

/** One account: its name, provider and id, the keying notice, its last check and its actions. */
function AccountCard({
  account,
  now,
  check,
  change,
  removeError,
  onChanged,
  onReplace,
  onRemove,
}: {
  account: CloudAccountView
  /** Why the last Remove was refused. */
  removeError: string | undefined
  now: number
  /** May ask the provider again (settings.read). */
  check: boolean
  /** May replace the key and remove the account (settings.change). */
  change: boolean
  onChanged: (account: CloudAccountView) => void
  onReplace: () => void
  onRemove: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const titleId = useId()
  const ask = async (): Promise<void> => {
    setBusy(true)
    setFailed(undefined)
    try {
      const checked = await client.post(
        cloudAccountCheckPath(account.id),
        asCloudAccountView,
      )
      onChanged(checked)
      toast({
        text: `${checked.name} checked: ${checkWords(checked.check)}`,
        icon: 'refresh',
      })
    } catch (reason) {
      setFailed((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="m-card"
      aria-labelledby={titleId}
      data-account={account.id}
    >
      <header className="m-card__header m-cloud__head">
        <span className="m-glyphbox">
          <Icon name="cloud" />
        </span>
        <div className="m-list__main">
          <h2 className="m-t-title3" id={titleId}>
            {account.name}
          </h2>
          <span className="m-t-subhead m-secondary">
            {PROVIDERS[account.provider]} ·{' '}
            <span className="m-t-mono-sm">{account.id}</span>
          </span>
        </div>
        <StatusPill status={checkStatus(account.check)} />
      </header>
      <div className="m-card__body m-stack">
        {account.provider === 'digitalocean' &&
          (account.adminKeyed ? (
            <p className="m-t-subhead m-secondary m-cloud__line">
              Its key was entered by an administrator, so a host may be made in
              it.
            </p>
          ) : (
            <Banner tone="warning" title="Not keyed by an administrator">
              No administrator entered this key, so no host is made in it until
              one replaces it.
            </Banner>
          ))}
        <CheckState check={account.check} now={now} />
        {failed != null && <FormError>{failed}</FormError>}
        {removeError != null && <FormError>{removeError}</FormError>}
      </div>
      {(check || change) && (
        <footer className="m-card__footer m-cloud__actions">
          {check && (
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              busy={busy}
              aria-label={`Check ${account.name}`}
              onClick={() => void ask()}
            >
              Check
            </Button>
          )}
          {change && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon="key"
                aria-haspopup="dialog"
                aria-label={`Replace the key of ${account.name}`}
                onClick={onReplace}
              >
                Replace key
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon="delete"
                aria-haspopup="dialog"
                aria-label={`Remove ${account.name}`}
                className="m-cloud__remove"
                onClick={onRemove}
              >
                Remove
              </Button>
            </>
          )}
        </footer>
      )}
    </section>
  )
}

/** The help under an API key. */
const KEY_HELP =
  'A DigitalOcean personal access token with read and write scope, or a NoMac API key (nmk_…). It is kept in this master’s database and never shown again.'

/** Sends a sheet's request, keeping its refusal in the sheet with focus on it. */
function useSend(): {
  busy: boolean
  failed: string | undefined
  error: RefObject<HTMLParagraphElement | null>
  clear: () => void
  send: (request: () => Promise<void>) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  return {
    busy,
    failed,
    error,
    clear: () => setFailed(undefined),
    send: async (request): Promise<void> => {
      setBusy(true)
      setFailed(undefined)
      try {
        await request()
      } catch (reason) {
        setFailed((reason as Error).message)
        setTimeout(() => error.current?.focus(), 0)
      } finally {
        setBusy(false)
      }
    },
  }
}

/** Add account: the provider, a name and the API key. */
function AddAccountSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: (account: CloudAccountView) => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const formId = useId()
  const [provider, setProvider] = useState<CloudProviderName>('digitalocean')
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [errors, setErrors] = useState<{ name?: string; key?: string }>({})
  const sending = useSend()
  const close = (): void => {
    setProvider('digitalocean')
    setName('')
    setKey('')
    setErrors({})
    sending.clear()
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(name.trim() === '' ? { name: 'Enter a name.' } : {}),
      ...(key.trim() === '' ? { key: 'Enter the API key.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    await sending.send(async () => {
      const added = await client.post(CLOUD_ACCOUNTS_PATH, asCloudAccountView, {
        body: { provider, name: name.trim(), key: key.trim() },
      })
      toast({ text: `${added.name} added`, icon: 'cloud' })
      onAdded(added)
      close()
    })
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={name !== '' || key !== '' || provider !== 'digitalocean'}
      title="Add a cloud account"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            busy={sending.busy}
          >
            Add account
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="cloud-account"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <SelectInput
          label="Provider"
          name="provider"
          value={provider}
          onChange={(value) => setProvider(value as CloudProviderName)}
          options={[
            { value: 'digitalocean', label: 'DigitalOcean' },
            { value: 'nomac', label: 'NoMac' },
          ]}
        />
        <TextInput
          label="Name"
          name="name"
          value={name}
          onChange={setName}
          error={errors.name}
          placeholder={PROVIDERS[provider]}
          maxLength={80}
          autoComplete="off"
          required
        />
        <TextInput
          label="API key"
          name="key"
          type="password"
          value={key}
          onChange={setKey}
          error={errors.key}
          help={KEY_HELP}
          autoComplete="off"
          mono
          verbatim
          required
        />
        {sending.failed != null && (
          <FormError ref={sending.error}>{sending.failed}</FormError>
        )}
      </form>
    </Sheet>
  )
}

/** Replace key: the new key, write-only. */
function ReplaceKeySheet({
  account,
  onClose,
  onReplaced,
}: {
  account: CloudAccountView | undefined
  onClose: () => void
  onReplaced: (account: CloudAccountView) => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const formId = useId()
  const [key, setKey] = useState('')
  const [wrong, setWrong] = useState<string | undefined>()
  const sending = useSend()
  const close = (): void => {
    setKey('')
    setWrong(undefined)
    sending.clear()
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (account == null) return
    if (key.trim() === '') {
      setWrong('Enter the new API key.')
      return
    }
    setWrong(undefined)
    await sending.send(async () => {
      const replaced = await client.put(
        cloudAccountKeyPath(account.id),
        asCloudAccountView,
        { body: { key: key.trim() } },
      )
      toast({ text: `The key of ${replaced.name} is replaced`, icon: 'key' })
      onReplaced(replaced)
      close()
    })
  }
  return (
    <Sheet
      open={account != null}
      onClose={close}
      dirty={key !== ''}
      title={`Replace the key of ${account?.name ?? ''}`}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            busy={sending.busy}
          >
            Replace key
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="cloud-key"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <TextInput
          label="New API key"
          name="key"
          type="password"
          value={key}
          onChange={setKey}
          error={wrong}
          help="Kept in this master’s database and never shown again. Entered by an administrator, a host may be made in the account."
          autoComplete="off"
          mono
          verbatim
          required
        />
        {sending.failed != null && (
          <FormError ref={sending.error}>{sending.failed}</FormError>
        )}
      </form>
    </Sheet>
  )
}

/** `/cloud`, the master only. */
export function CloudPage(): JSX.Element {
  const { session } = useShell()
  const client = useApi()
  const toast = useToast()
  const check = session.permissions.includes('settings.read')
  const change = session.permissions.includes('settings.change')
  const read = useResource(CLOUD_ACCOUNTS_PATH, asCloudAccountViews)
  // The list as the actions since its read left it.
  const [list, setList] = useState<CloudAccountView[] | undefined>()
  useEffect(() => {
    if (read.data != null) setList(read.data)
  }, [read.data])
  const accounts = list ?? read.data
  const edit = (
    change: (was: CloudAccountView[]) => CloudAccountView[],
  ): void => setList((was) => change(was ?? read.data ?? []))
  const [adding, setAdding] = useState(false)
  const [replacing, setReplacing] = useState<CloudAccountView | undefined>()
  const [removing, setRemoving] = useState<CloudAccountView | undefined>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<Record<string, string>>({})
  const update = (account: CloudAccountView): void =>
    edit((was) => was.map((one) => (one.id === account.id ? account : one)))
  const remove = async (account: CloudAccountView): Promise<void> => {
    setBusy(true)
    try {
      await client.delete(cloudAccountPath(account.id), asUnknown)
      edit((was) => was.filter((one) => one.id !== account.id))
      toast({ text: `${account.name} removed`, icon: 'delete' })
    } catch (reason) {
      setFailed((was) => ({
        ...was,
        [account.id]: (reason as Error).message,
      }))
    } finally {
      setBusy(false)
      setRemoving(undefined)
    }
  }
  const now = Date.now()
  return (
    <Page
      crumbs={[{ label: 'Cloud' }]}
      title="Cloud"
      description="The provider accounts cloud pools and hosts are made in."
      actions={
        change ? (
          <Button
            variant="primary"
            icon="add"
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            Add account
          </Button>
        ) : undefined
      }
    >
      {accounts != null ? (
        accounts.length === 0 ? (
          <section className="m-card">
            <EmptyState icon="cloud" title="No cloud accounts yet.">
              {change
                ? 'Add a DigitalOcean or NoMac account to make pools and a host in.'
                : undefined}
            </EmptyState>
          </section>
        ) : (
          <div className="m-grid-2 m-cloud">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                now={now}
                check={check}
                change={change}
                removeError={failed[account.id]}
                onChanged={update}
                onReplace={() => setReplacing(account)}
                onRemove={() => {
                  setFailed(({ [account.id]: _, ...rest }) => rest)
                  setRemoving(account)
                }}
              />
            ))}
          </div>
        )
      ) : read.error != null ? (
        <Failed
          what="The cloud accounts"
          message={read.error.message}
          retry={read.reload}
        />
      ) : (
        <Loading label="Loading the cloud accounts" />
      )}
      {change && (
        <>
          <AddAccountSheet
            open={adding}
            onClose={() => setAdding(false)}
            onAdded={(account) => edit((was) => [...was, account])}
          />
          <ReplaceKeySheet
            account={replacing}
            onClose={() => setReplacing(undefined)}
            onReplaced={update}
          />
          <Alert
            open={removing != null}
            title={`Remove ${removing?.name ?? ''}?`}
            message="Mason forgets its key: no pool or host can be made in it any more. An account a pool or the host still uses cannot be removed."
            cancel="Keep it"
            confirm="Remove"
            tone="danger"
            busy={busy}
            onCancel={() => setRemoving(undefined)}
            onConfirm={() => {
              if (removing != null) void remove(removing)
            }}
          />
        </>
      )}
    </Page>
  )
}
