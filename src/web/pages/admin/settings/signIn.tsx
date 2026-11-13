// Settings → Sign-in (screen-10b-settings-more): ways people sign in besides
// a username and password — OpenID Connect or OAuth 2 providers. The master
// address (an administrator's inline form; others read it), then each method
// with its kind, whether it is disabled, and the callback URLs to register
// with the provider, one per place it is offered. Administrators edit a
// method in a large sheet (Availability, Provider, and for OAuth 2 its
// endpoints, scopes and claims collapsed), add one with its ID, and remove
// one with a confirm (tier 2). The sheet keeps a draft without the secret.
import { useMemo, useState, type FormEvent, type JSX } from 'react'
import {
  asMasterSetting,
  asSignInSetting,
  settingsPath,
  signInMethodPath,
  type HostSetting,
  type SignInMethod,
} from '../../../../shared/api/settings.js'
import { useApi } from '../../../api/context.js'
import type { Resource } from '../../../hooks/useResource.js'
import { useResource } from '../../../hooks/useResource.js'
import { Alert } from '../../../ui/Alert.js'
import { Count } from '../../../ui/Badge.js'
import { Button } from '../../../ui/Button.js'
import { Chip } from '../../../ui/Chip.js'
import { CopyField } from '../../../ui/CopyField.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import {
  CheckboxInput,
  SelectInput,
  TextInput,
  type TextInputProps,
} from '../../../ui/Field.js'
import {
  FormDisclosure,
  FormSection,
  LargeSheet,
  useDraft,
} from '../../../ui/LargeSheet.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import {
  Failure,
  isHttps,
  listOf,
  Read,
  SettingsCard,
  useActions,
} from './parts.js'

type Kind = SignInMethod['type']

/** A method's kind in words. */
export const kindText = (type: Kind): string =>
  type === 'oidc' ? 'OpenID Connect' : 'OAuth 2'

/** What the sheet edits. */
export type Editing =
  | { method: SignInMethod; type: Kind }
  | { method?: undefined; type: Kind }

/** The sheet's fields, as text and checks. */
export interface MethodDraft {
  id: string
  enabled: boolean
  admitTesters: boolean
  name: string
  issuer: string
  clientId: string
  clientSecret: string
  authentication: 'post' | 'basic'
  signingAlgorithm: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  scopes: string
  subject: string
  claimName: string
  claimEmail: string
  claimVerified: string
}

/** A method as the sheet's fields; a new one empty. */
export function methodDraft(method: SignInMethod | undefined): MethodDraft {
  return {
    id: method?.id ?? '',
    enabled: method?.enabled ?? true,
    admitTesters: method?.admitTesters ?? false,
    name: method?.name ?? '',
    issuer: method?.issuer ?? '',
    clientId: method?.clientId ?? '',
    clientSecret: '',
    authentication: method?.authentication ?? 'post',
    signingAlgorithm: method?.signingAlgorithm ?? 'RS256',
    authorizationEndpoint: method?.authorizationEndpoint ?? '',
    tokenEndpoint: method?.tokenEndpoint ?? '',
    userinfoEndpoint: method?.userinfoEndpoint ?? '',
    scopes: (method?.scopes ?? []).join(', '),
    subject: method?.claims?.subject ?? '',
    claimName: method?.claims?.name ?? '',
    claimEmail: method?.claims?.email ?? '',
    claimVerified: method?.claims?.emailVerified ?? '',
  }
}

type Errors = Partial<Record<keyof MethodDraft, string>>

/** What is wrong with the fields, by field. */
export function methodErrors(
  draft: MethodDraft,
  type: Kind,
  adding: boolean,
): Errors {
  const https = (value: string): string | undefined =>
    isHttps(value) ? undefined : 'Enter an https address.'
  const errors: Errors = {
    ...(adding && !/^[a-z][a-z0-9-]{0,63}$/.test(draft.id.trim())
      ? {
          id: 'Use lowercase letters, digits and dashes, starting with a letter.',
        }
      : {}),
    ...(draft.name.trim() === '' ? { name: 'Enter the display name.' } : {}),
    ...(https(draft.issuer) == null ? {} : { issuer: https(draft.issuer) }),
    ...(draft.clientId.trim() === ''
      ? { clientId: 'Enter the client ID.' }
      : {}),
    ...(adding && draft.clientSecret === ''
      ? { clientSecret: 'Enter the client secret.' }
      : {}),
  }
  if (type === 'oauth2') {
    for (const field of [
      'authorizationEndpoint',
      'tokenEndpoint',
      'userinfoEndpoint',
    ] as const) {
      const wrong = https(draft[field])
      if (wrong != null) errors[field] = wrong
    }
    if (draft.subject.trim() === '') errors.subject = 'Enter the subject claim.'
  }
  return errors
}

/** What the method route takes. */
export function methodBody(
  draft: MethodDraft,
  type: Kind,
  adding: boolean,
): Record<string, unknown> {
  const optional = (key: string, value: string): Record<string, string> =>
    value.trim() === '' ? {} : { [key]: value.trim() }
  return {
    type,
    enabled: draft.enabled,
    admitTesters: draft.admitTesters,
    name: draft.name.trim(),
    issuer: draft.issuer.trim(),
    clientId: draft.clientId.trim(),
    clientSecret:
      draft.clientSecret === '' ? { keep: true } : draft.clientSecret,
    authentication: draft.authentication,
    ...(type === 'oidc'
      ? { signingAlgorithm: draft.signingAlgorithm }
      : {
          authorizationEndpoint: draft.authorizationEndpoint.trim(),
          tokenEndpoint: draft.tokenEndpoint.trim(),
          userinfoEndpoint: draft.userinfoEndpoint.trim(),
          scopes: listOf(draft.scopes),
          claims: {
            subject: draft.subject.trim(),
            ...optional('name', draft.claimName),
            ...optional('email', draft.claimEmail),
            ...optional('emailVerified', draft.claimVerified),
          },
        }),
    ...(adding ? { create: true } : {}),
  }
}

/** A method's editor, or a new one's, in a large sheet. */
function MethodSheet({
  editing,
  onClose,
  onSaved,
}: {
  editing: Editing | undefined
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const method = editing?.method
  const type = editing?.type ?? 'oidc'
  const adding = editing != null && method == null
  const key =
    editing == null
      ? null
      : method == null
        ? `signIn:new:${type}`
        : `signIn:${method.id}`
  const initial = useMemo(() => methodDraft(method), [method])
  const draft = useDraft(key, initial, ['clientSecret'])
  const [errors, setErrors] = useState<Errors>({})
  const [removing, setRemoving] = useState(false)
  const value = draft.value
  const field = (
    name: keyof MethodDraft,
  ): Pick<TextInputProps, 'value' | 'onChange' | 'error'> => ({
    value: value[name] as string,
    onChange: (next: string) => draft.set((was) => ({ ...was, [name]: next })),
    error: errors[name],
  })
  const close = (): void => {
    draft.clear()
    setErrors({})
    actions.clear()
    onClose()
  }
  const id = adding ? value.id.trim() : (method?.id ?? '')
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = methodErrors(value, type, adding)
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const ok = await actions.run('save', async () => {
      await client.put(signInMethodPath(id), asSignInSetting, {
        body: methodBody(value, type, adding),
      })
    })
    if (!ok) return
    toast({
      text: `${value.name.trim()} ${adding ? 'added' : 'saved'}`,
      icon: 'check_circle',
    })
    close()
    onSaved()
  }
  const remove = async (): Promise<void> => {
    if (method == null) return
    const ok = await actions.run('remove', async () => {
      await client.delete(signInMethodPath(method.id), asSignInSetting)
    })
    setRemoving(false)
    if (!ok) return
    toast({ text: `${method.name} removed`, icon: 'delete' })
    close()
    onSaved()
  }
  const oauthWrong = (
    [
      'authorizationEndpoint',
      'tokenEndpoint',
      'userinfoEndpoint',
      'subject',
    ] as const
  ).some((name) => errors[name] != null)
  const formId = 'signin-method-form'
  return (
    <LargeSheet
      open={editing != null}
      onClose={close}
      dirty={draft.dirty}
      title={
        adding ? (
          `Add an ${kindText(type)} method`
        ) : (
          <>
            Sign-in method <span className="m-t-mono">{method?.id}</span>
          </>
        )
      }
      badge={<Chip>{kindText(type)}</Chip>}
      footer={(requestClose) => (
        <>
          {method != null && (
            <Button
              variant="danger"
              icon="delete"
              className="m-settings__footstart"
              aria-haspopup="dialog"
              onClick={() => setRemoving(true)}
            >
              Remove method
            </Button>
          )}
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon="check"
            busy={actions.busy === 'save'}
          >
            {adding ? 'Add' : 'Save'}
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
        {draft.restored && (
          <p className="m-t-subhead m-secondary">
            Your unsaved changes were restored. The client secret is never kept.
          </p>
        )}
        <FormSection legend="Availability" grid={false}>
          <CheckboxInput
            label="Enabled"
            checked={value.enabled}
            onChange={(enabled) => draft.set((was) => ({ ...was, enabled }))}
            help="Offered on the sign-in page. A disabled method stays configured."
          />
          <CheckboxInput
            label="Admit as testers"
            checked={value.admitTesters}
            onChange={(admitTesters) =>
              draft.set((was) => ({ ...was, admitTesters }))
            }
            help="A verified sign-in creates a tester account that can install every app."
          />
        </FormSection>
        <FormSection legend="Provider">
          {adding && (
            <TextInput
              label="ID"
              {...field('id')}
              placeholder="google"
              help="A short name in the sign-in and callback URLs: lowercase letters, digits and dashes."
              maxLength={64}
              autoComplete="off"
              mono
              verbatim
              required
            />
          )}
          <TextInput
            label="Display name"
            {...field('name')}
            placeholder="Google"
            help="The button people see: Sign in with this."
            maxLength={80}
            autoComplete="off"
            required
          />
          <TextInput
            label="Issuer URL"
            {...field('issuer')}
            placeholder="https://accounts.google.com"
            help="The provider’s https address."
            inputMode="url"
            autoComplete="off"
            mono
            verbatim
            required
          />
          <TextInput
            label="Client ID"
            {...field('clientId')}
            help="From the app you registered with the provider."
            maxLength={256}
            autoComplete="off"
            mono
            verbatim
            required
          />
          <TextInput
            label="Client secret"
            type="password"
            {...field('clientSecret')}
            placeholder={
              adding ? undefined : 'Leave empty to keep the stored secret'
            }
            help="Write-only: it is never shown again."
            autoComplete="off"
            verbatim
            required={adding}
          />
          <SelectInput
            label="Client authentication"
            value={value.authentication}
            onChange={(next) =>
              draft.set((was) => ({
                ...was,
                authentication: next === 'basic' ? 'basic' : 'post',
              }))
            }
            help="How Mason sends the client secret to the token endpoint."
            options={[
              { value: 'post', label: 'In the request body (post)' },
              { value: 'basic', label: 'HTTP Basic (basic)' },
            ]}
          />
          {type === 'oidc' && (
            <SelectInput
              label="Signing algorithm"
              value={value.signingAlgorithm}
              onChange={(next) =>
                draft.set((was) => ({ ...was, signingAlgorithm: next }))
              }
              help="How the provider signs its ID tokens."
              options={['RS256', 'ES256', 'EdDSA']}
            />
          )}
        </FormSection>
        {type === 'oauth2' && (
          <FormDisclosure
            summary="Endpoints, scopes and claims"
            open={adding || oauthWrong}
          >
            <TextInput
              label="Authorization endpoint"
              {...field('authorizationEndpoint')}
              inputMode="url"
              autoComplete="off"
              mono
              verbatim
              required
            />
            <TextInput
              label="Token endpoint"
              {...field('tokenEndpoint')}
              inputMode="url"
              autoComplete="off"
              mono
              verbatim
              required
            />
            <TextInput
              label="Userinfo endpoint"
              {...field('userinfoEndpoint')}
              inputMode="url"
              autoComplete="off"
              mono
              verbatim
              required
            />
            <TextInput
              label="Scopes"
              {...field('scopes')}
              placeholder="read:user, user:email"
              help="Comma-separated."
              optional
              autoComplete="off"
              mono
              verbatim
            />
            <TextInput
              label="Subject claim"
              {...field('subject')}
              placeholder="id"
              help="The userinfo field that identifies a person."
              autoComplete="off"
              mono
              verbatim
              required
            />
            <TextInput
              label="Name claim"
              {...field('claimName')}
              placeholder="name"
              optional
              autoComplete="off"
              mono
              verbatim
            />
            <TextInput
              label="Email claim"
              {...field('claimEmail')}
              placeholder="email"
              optional
              autoComplete="off"
              mono
              verbatim
            />
            <TextInput
              label="Email-verified claim"
              {...field('claimVerified')}
              placeholder="email_verified"
              optional
              autoComplete="off"
              mono
              verbatim
            />
          </FormDisclosure>
        )}
        <Failure actions={actions} name="save" />
        <Failure actions={actions} name="remove" />
      </form>
      <Alert
        open={removing}
        title={`Remove the sign-in method ${method?.name ?? ''}?`}
        message={`People who sign in with ${method?.name ?? 'it'} then use another method.`}
        confirm="Remove"
        tone="danger"
        busy={actions.busy === 'remove'}
        onCancel={() => setRemoving(false)}
        onConfirm={() => void remove()}
      />
    </LargeSheet>
  )
}

/** The callback URLs to register for a method, one per place it is offered. */
function Callbacks({
  id,
  host,
  master,
}: {
  id: string
  host: string | undefined
  master: string | undefined
}): JSX.Element {
  const where = [
    ...(host == null ? [] : [['Host', host] as const]),
    ...(master == null ? [] : [['Master', master] as const]),
  ]
  if (where.length === 0)
    return (
      <span className="m-t-subhead m-tertiary">
        Set the host or master address to see the callback URL to register.
      </span>
    )
  return (
    <span className="m-stack m-settings__callbacks">
      <span className="m-t-subhead m-secondary">
        Callback URLs to register with the provider:
      </span>
      {where.map(([label, origin]) => (
        <CopyField
          key={label}
          label={label}
          value={`${origin.replace(/\/+$/, '')}/auth/callback/${id}`}
          name={`the ${label.toLowerCase()} callback URL of ${id}`}
        />
      ))}
    </span>
  )
}

/** The master address: an administrator's form. */
function MasterForm({
  origin,
  done,
}: {
  origin: string | undefined
  done: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const [text, setText] = useState(origin ?? '')
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (text.trim() !== '' && !isHttps(text)) {
      setError('Enter an https address, or leave it empty.')
      return
    }
    setError(undefined)
    const ok = await actions.run('master', async () => {
      await client.put(settingsPath('master'), asMasterSetting, {
        body: text.trim() === '' ? {} : { origin: text.trim() },
      })
    })
    if (!ok) return
    toast({ text: 'Master address saved', icon: 'check_circle' })
    done()
  }
  return (
    <form
      className="m-stack"
      aria-label="Master address"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <TextInput
        label="Master address"
        optional
        value={text}
        onChange={setText}
        error={error}
        placeholder="https://mason-admin.example.com:9300"
        help="The https address people open the master at. Providers send the browser back here, so it needs a public domain name, though it may resolve to a private address. Empty offers only username and password on the master."
        inputMode="url"
        autoComplete="off"
        mono
        verbatim
      />
      <Failure actions={actions} name="master" />
      <div className="m-form__actions">
        <Button
          variant="primary"
          type="submit"
          icon="check"
          busy={actions.busy === 'master'}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

/** The card: the master address, the methods, and their editor. */
export function SignInCard({
  host,
  admin,
}: {
  host: Resource<HostSetting>
  /** An administrator (signIn.change): the editors. */
  admin: boolean
}): JSX.Element {
  const read = useResource(settingsPath('signIn'), asSignInSetting)
  const master = useResource(settingsPath('master'), asMasterSetting)
  const [editing, setEditing] = useState<Editing | undefined>()
  const methods = read.data?.methods
  return (
    <SettingsCard
      id="signIn"
      icon="login"
      title="Sign-in"
      count={methods == null ? undefined : <Count count={methods.length} />}
      actions={
        admin && (
          <div className="m-btngroup">
            <Button
              variant="tinted"
              size="sm"
              icon="add"
              aria-haspopup="dialog"
              onClick={() => setEditing({ type: 'oidc' })}
            >
              Add an OpenID Connect method
            </Button>
            <Button
              variant="tinted"
              size="sm"
              icon="add"
              aria-haspopup="dialog"
              onClick={() => setEditing({ type: 'oauth2' })}
            >
              Add an OAuth 2 method
            </Button>
          </div>
        )
      }
    >
      <div className="m-card__body m-stack">
        <p className="m-t-callout m-secondary">
          Ways people sign in besides a username and password: OpenID Connect or
          OAuth 2 providers such as Google or GitHub. The host offers them; the
          master offers them too once its address is set.
        </p>
      </div>
      <Read read={master} what="The master address">
        {(value) => (
          <div className="m-card__body">
            {admin ? (
              <MasterForm origin={value.origin} done={master.reload} />
            ) : (
              <p className="m-t-callout m-settings__readonly">
                Master address:{' '}
                {value.origin == null ? (
                  'not set'
                ) : (
                  <span className="m-t-mono-sm">{value.origin}</span>
                )}
                . Only an administrator changes sign-in.
              </p>
            )}
          </div>
        )}
      </Read>
      <Read read={read} what="The sign-in methods">
        {(setting) =>
          setting.methods.length === 0 ? (
            <EmptyState icon="login" title="None yet." />
          ) : (
            <ul className="m-list m-settings__methods">
              {setting.methods.map((method) => (
                <li
                  key={method.id}
                  className="m-list__row m-settings__method"
                  data-method={method.id}
                >
                  <span className="m-list__main">
                    <span className="m-t-headline">{method.name}</span>
                    <span className="m-list__sub m-t-mono-sm">
                      {[
                        method.id,
                        kindText(method.type),
                        ...(method.enabled ? [] : ['disabled']),
                      ].join(' · ')}
                    </span>
                    <span className="m-row">
                      <StatusPill
                        quiet
                        status={method.enabled ? 'active' : 'removed'}
                        label={method.enabled ? 'Enabled' : 'Disabled'}
                      />
                      {method.admitTesters && <Chip>Admits testers</Chip>}
                    </span>
                    <Callbacks
                      id={method.id}
                      host={host.data?.origin}
                      master={master.data?.origin}
                    />
                  </span>
                  {admin && (
                    <span className="m-list__end">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="edit"
                        aria-haspopup="dialog"
                        aria-label={`Edit ${method.name}`}
                        onClick={() =>
                          setEditing({ method, type: method.type })
                        }
                      >
                        Edit
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Read>
      {admin && (
        <MethodSheet
          editing={editing}
          onClose={() => setEditing(undefined)}
          onSaved={read.reload}
        />
      )}
    </SettingsCard>
  )
}
