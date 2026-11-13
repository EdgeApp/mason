// Settings → API keys (screen-10-settings, screen-10b-settings-more): the
// keys with their role, creation day, state and the start of their token;
// Create key (a form sheet: name, and a role up to the viewer's own) shows
// the new token once, in a success banner with a copy field and Done —
// never a toast; Revoke confirms naming the key (tier 2).
import { useId, useState, type FormEvent, type JSX } from 'react'
import { asUnknown } from 'cleaners'
import {
  asApiKey,
  asApiKeys,
  keyPath,
  KEYS_PATH,
  type ApiKey,
} from '../../../../shared/api/settings.js'
import {
  roles,
  type Permission,
  type Role,
} from '../../../../shared/permissions.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Alert } from '../../../ui/Alert.js'
import { Count } from '../../../ui/Badge.js'
import { Banner } from '../../../ui/Banner.js'
import { Button } from '../../../ui/Button.js'
import { CopyField } from '../../../ui/CopyField.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { FormError, SelectInput, TextInput } from '../../../ui/Field.js'
import { Sheet } from '../../../ui/Sheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import { day, Failure, Read, SettingsCard, useActions } from './parts.js'

/** A role's name with a capital. */
export const roleWord = (role: string): string =>
  role.charAt(0).toUpperCase() + role.slice(1)

/** The roles a key may take: up to the viewer's own, developer first. */
export function keyRoles(viewer: Role): Role[] {
  const rank = roles.indexOf(viewer)
  return (['developer', 'tester', 'manager', 'admin'] as const).filter(
    (role) => roles.indexOf(role) <= rank,
  )
}

/**
 * What names a key without its secret: a v1 token is `mason_v1_<id>.<secret>`,
 * so its id's first characters; a builder key has none.
 */
export const keyPrefix = (key: ApiKey): string | undefined =>
  key.format === 'builder' ? undefined : `mason_v1_${key.id.slice(0, 5)}…`

/** Create an API key: its name and role. */
function CreateKeySheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (key: ApiKey) => void
}): JSX.Element {
  const id = useId()
  const client = useApi()
  const { session } = useShell()
  const actions = useActions()
  const choices = keyRoles(session.role)
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>(choices[0] ?? 'tester')
  const [error, setError] = useState<string | undefined>()
  const close = (): void => {
    setName('')
    setRole(choices[0] ?? 'tester')
    setError(undefined)
    actions.clear()
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (name.trim() === '') {
      setError('Enter a name.')
      return
    }
    setError(undefined)
    let created: ApiKey | undefined
    const ok = await actions.run('create', async () => {
      created = await client.post(KEYS_PATH, asApiKey, {
        body: { name: name.trim(), role },
      })
    })
    if (!ok || created == null) return
    onCreated(created)
    close()
  }
  const formId = `${id}-form`
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={name !== ''}
      title="Create an API key"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="key"
            busy={actions.busy === 'create'}
          >
            Create key
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <TextInput
          label="Name"
          value={name}
          onChange={setName}
          error={error}
          placeholder="ci-uploads"
          help="What uses it, so you can find it later."
          maxLength={120}
          autoComplete="off"
          mono
          verbatim
          required
        />
        <SelectInput
          label="Role"
          value={role}
          onChange={setRole}
          help="What it may do: the same as a person with that role."
          options={choices.map((entry) => ({
            value: entry,
            label: roleWord(entry),
          }))}
        />
        <Failure actions={actions} name="create" />
      </form>
    </Sheet>
  )
}

/** The keys table, with Revoke for managers. */
function KeysTable({
  keys,
  revoke,
  changed,
}: {
  keys: ApiKey[]
  revoke: boolean
  changed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const [revoking, setRevoking] = useState<ApiKey | undefined>()
  const confirm = async (key: ApiKey): Promise<void> => {
    const ok = await actions.run('revoke', async () => {
      await client.delete(keyPath(key.id), asUnknown)
    })
    setRevoking(undefined)
    if (!ok) return
    toast({ text: `${key.name} revoked`, icon: 'block' })
    changed()
  }
  if (keys.length === 0) return <EmptyState icon="key" title="No keys." />
  const now = Date.now()
  return (
    <>
      <div className="m-table-wrap">
        <table className="m-table m-table--stack m-settings__keys">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Created</th>
              <th scope="col">State</th>
              <th scope="col">Key</th>
              {revoke && (
                <th scope="col">
                  <span className="m-sr">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const prefix = keyPrefix(key)
              return (
                <tr key={key.id} data-key={key.id}>
                  <td data-primary data-label="Name" className="m-t-mono">
                    {key.name}
                  </td>
                  <td data-label="Role">{roleWord(key.role)}</td>
                  <td data-label="Created" className="m-num">
                    <time dateTime={new Date(key.createdAt).toISOString()}>
                      {day(key.createdAt, now)}
                    </time>
                  </td>
                  <td data-label="State">
                    <StatusPill
                      quiet
                      status={key.revoked ? 'revoked' : 'active'}
                    />
                  </td>
                  <td data-label="Key">
                    {prefix == null ? (
                      <span className="m-t-subhead m-secondary">
                        builder key
                      </span>
                    ) : (
                      <span className="m-t-mono-sm">{prefix}</span>
                    )}
                  </td>
                  {revoke && (
                    <td data-actions>
                      {!key.revoked && (
                        <div className="m-table__actions">
                          <Button
                            variant="danger"
                            size="sm"
                            aria-haspopup="dialog"
                            aria-label={`Revoke ${key.name}`}
                            onClick={() => {
                              actions.clear()
                              setRevoking(key)
                            }}
                          >
                            Revoke
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
      {actions.failed('revoke') != null && (
        <div className="m-card__body">
          <FormError ref={actions.error}>{actions.failed('revoke')}</FormError>
        </div>
      )}
      <Alert
        open={revoking != null}
        title={`Revoke the key ${revoking?.name ?? ''}?`}
        message="Apps and agents that use it are refused from then on. A revoked key cannot be used again."
        cancel="Keep it"
        confirm="Revoke"
        tone="danger"
        busy={actions.busy === 'revoke'}
        onCancel={() => setRevoking(undefined)}
        onConfirm={() => {
          if (revoking != null) void confirm(revoking)
        }}
      />
    </>
  )
}

/** The card: Create key, the one-time token, and the table. */
export function KeysCard(): JSX.Element {
  const { session } = useShell()
  const may = (permission: Permission): boolean =>
    session.permissions.includes(permission)
  const read = useResource(may('keys.read') ? KEYS_PATH : null, asApiKeys)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<ApiKey | undefined>()
  return (
    <SettingsCard
      id="keys"
      icon="token"
      title="API keys"
      count={read.data == null ? undefined : <Count count={read.data.length} />}
      actions={
        may('keys.create') && (
          <Button
            variant="tinted"
            size="sm"
            icon="add"
            aria-haspopup="dialog"
            onClick={() => setCreating(true)}
          >
            Create key
          </Button>
        )
      }
    >
      <div className="m-card__body m-stack">
        <p className="m-t-callout m-secondary">
          Create API keys to access Mason from other apps and agents.
        </p>
        {created?.token != null && (
          <Banner
            tone="success"
            title={`Copy the new key ${created.name} now`}
            actions={
              <Button
                variant="plain"
                size="sm"
                onClick={() => setCreated(undefined)}
              >
                Done
              </Button>
            }
          >
            Mason stores only a hash of it and cannot show it again. If it is
            lost, revoke it and create a new one.
          </Banner>
        )}
        {created?.token != null && (
          <CopyField value={created.token} block name="the new key" />
        )}
      </div>
      {may('keys.read') && (
        <Read read={read} what="The API keys">
          {(keys) => (
            <KeysTable
              keys={keys}
              revoke={may('keys.revoke')}
              changed={read.reload}
            />
          )}
        </Read>
      )}
      {may('keys.create') && (
        <CreateKeySheet
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreated(key)
            read.reload()
          }}
        />
      )}
    </SettingsCard>
  )
}
