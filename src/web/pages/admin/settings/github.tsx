// Settings → GitHub (screen-10-settings, screen-10b-settings-more): how
// Mason reads repositories and reports runs on commits — a personal access
// token, a GitHub App, or an SSH deploy key the master makes. The three are
// a choice in the card, the one in use chosen first; each is an inline form
// with Save in the card. Secrets are write-only: left empty, the stored one
// is kept.
import { useState, type FormEvent, type JSX } from 'react'
import { asUnknown } from 'cleaners'
import {
  asGithubSetting,
  settingsPath,
  type GithubSetting,
} from '../../../../shared/api/settings.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Alert } from '../../../ui/Alert.js'
import { Button } from '../../../ui/Button.js'
import { CopyField } from '../../../ui/CopyField.js'
import { TextAreaInput, TextInput } from '../../../ui/Field.js'
import { useToast } from '../../../ui/Toast.js'
import {
  Failure,
  Read,
  SettingsCard,
  useActions,
  type Actions,
} from './parts.js'

type Kind = 'token' | 'app' | 'ssh'

const KINDS: ReadonlyArray<{ kind: Kind; title: string; note: string }> = [
  { kind: 'token', title: 'Personal access token', note: 'One user’s token.' },
  { kind: 'app', title: 'GitHub App', note: 'Installed on the organisation.' },
  { kind: 'ssh', title: 'SSH deploy key', note: 'Read-only, per repository.' },
]

/** The connection in use, in words. */
export const nowText = (kind: Kind | undefined): string =>
  kind == null
    ? 'Not set up yet.'
    : `Now: ${kind === 'token' ? 'a personal access token' : kind === 'app' ? 'a GitHub App' : 'an SSH deploy key'}.`

const GITHUB = settingsPath('github')

/** Saves the area, says so, and reads it again. */
function useSave(
  actions: Actions,
  done: () => void,
): (key: string, body: unknown, said: string) => Promise<void> {
  const client = useApi()
  const toast = useToast()
  return async (key, body, said) => {
    const ok = await actions.run(key, async () => {
      await client.put(GITHUB, asUnknown, { body })
    })
    if (!ok) return
    toast({ text: said, icon: 'check_circle' })
    done()
  }
}

/** A personal access token: write-only. */
function TokenForm({
  setting,
  actions,
  done,
}: {
  setting: GithubSetting
  actions: Actions
  done: () => void
}): JSX.Element {
  const save = useSave(actions, done)
  const stored = setting.kind === 'token'
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!stored && token === '') {
      setError('Enter the token.')
      return
    }
    setError(undefined)
    await save(
      'token',
      { kind: 'token', token: token === '' ? { keep: true } : token },
      'GitHub token saved',
    )
    setToken('')
  }
  return (
    <form
      className="m-stack"
      aria-label="Personal access token"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <TextInput
        label="Token"
        type="password"
        value={token}
        onChange={setToken}
        error={error}
        placeholder={
          stored ? 'Leave empty to keep the stored token' : undefined
        }
        help="A fine-grained token with read access to contents and write access to commit statuses. Write-only."
        autoComplete="off"
        mono
        verbatim
        required={!stored}
      />
      <Failure actions={actions} name="token" />
      <div className="m-form__actions">
        <Button
          variant="primary"
          type="submit"
          icon="check"
          busy={actions.busy === 'token'}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

/** A GitHub App: its ids and its private key, write-only. */
function AppForm({
  setting,
  actions,
  done,
}: {
  setting: GithubSetting
  actions: Actions
  done: () => void
}): JSX.Element {
  const save = useSave(actions, done)
  const stored = setting.kind === 'app'
  const [appId, setAppId] = useState(
    setting.appId == null ? '' : String(setting.appId),
  )
  const [installationId, setInstallationId] = useState(
    setting.installationId == null ? '' : String(setting.installationId),
  )
  const [privateKey, setPrivateKey] = useState('')
  const [errors, setErrors] = useState<{
    appId?: string
    installationId?: string
    privateKey?: string
  }>({})
  const whole = (text: string): boolean => /^[1-9][0-9]*$/.test(text.trim())
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(whole(appId) ? {} : { appId: 'Enter the App ID.' }),
      ...(whole(installationId)
        ? {}
        : { installationId: 'Enter the installation ID.' }),
      ...(!stored && privateKey.trim() === ''
        ? { privateKey: 'Paste the private key.' }
        : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    await save(
      'app',
      {
        kind: 'app',
        appId: Number(appId),
        installationId: Number(installationId),
        privateKey: privateKey.trim() === '' ? { keep: true } : privateKey,
      },
      'GitHub App saved',
    )
    setPrivateKey('')
  }
  return (
    <form
      className="m-stack"
      aria-label="GitHub App"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className="m-grid-2">
        <TextInput
          label="App ID"
          value={appId}
          onChange={setAppId}
          error={errors.appId}
          help="On the app’s settings page in GitHub."
          inputMode="numeric"
          autoComplete="off"
          mono
          required
        />
        <TextInput
          label="Installation ID"
          value={installationId}
          onChange={setInstallationId}
          error={errors.installationId}
          help="The number at the end of the installation’s settings URL."
          inputMode="numeric"
          autoComplete="off"
          mono
          required
        />
      </div>
      <TextAreaInput
        label="Private key"
        value={privateKey}
        onChange={setPrivateKey}
        error={errors.privateKey}
        placeholder={stored ? 'Leave empty to keep the stored key' : undefined}
        help="The .pem file GitHub generated for the app. Write-only: Mason never shows the stored key."
        rows={4}
        mono
        required={!stored}
      />
      <Failure actions={actions} name="app" />
      <div className="m-form__actions">
        <Button
          variant="primary"
          type="submit"
          icon="check"
          busy={actions.busy === 'app'}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

/** An SSH deploy key the master makes: its public half to add to each repository. */
function DeployKey({
  setting,
  actions,
  done,
}: {
  setting: GithubSetting
  actions: Actions
  done: () => void
}): JSX.Element {
  const save = useSave(actions, done)
  const [renewing, setRenewing] = useState(false)
  const active = setting.kind === 'ssh'
  return (
    <div className="m-stack" aria-label="SSH deploy key" role="group">
      {active && setting.publicKey != null ? (
        <>
          <p className="m-t-callout m-secondary">
            Add this public key to each repository as a read-only deploy key.
          </p>
          <CopyField value={setting.publicKey} block name="the deploy key" />
        </>
      ) : (
        <p className="m-t-callout m-secondary">
          Mason makes a key pair and shows its public half to add to each
          repository as a deploy key.
        </p>
      )}
      <Failure actions={actions} name="ssh" />
      <div className="m-form__actions">
        <Button
          variant="primary"
          icon="check"
          busy={actions.busy === 'ssh'}
          onClick={() =>
            void save(
              'ssh',
              active
                ? { kind: 'ssh', privateKey: { keep: true } }
                : { kind: 'ssh' },
              active ? 'Deploy key saved' : 'Mason uses a deploy key now',
            )
          }
        >
          {active ? 'Save' : 'Use a deploy key'}
        </Button>
        {active && (
          <Button
            variant="secondary"
            icon="refresh"
            aria-haspopup="dialog"
            busy={actions.busy === 'renew'}
            onClick={() => setRenewing(true)}
          >
            Make a new deploy key
          </Button>
        )}
      </div>
      <Failure actions={actions} name="renew" />
      <Alert
        open={renewing}
        title="Make a new deploy key?"
        message="The current key stops working. Every repository then needs the new public key."
        confirm="Make a new deploy key"
        tone="danger"
        busy={actions.busy === 'renew'}
        onCancel={() => setRenewing(false)}
        onConfirm={() => {
          setRenewing(false)
          void save('renew', { kind: 'ssh' }, 'New deploy key made')
        }}
      />
    </div>
  )
}

/** The card's body: the choice and the chosen form. */
function GithubBody({
  setting,
  done,
}: {
  setting: GithubSetting
  done: () => void
}): JSX.Element {
  const actions = useActions()
  const [kind, setKind] = useState<Kind>(setting.kind ?? 'token')
  return (
    <div className="m-card__body m-stack">
      <p className="m-t-callout m-secondary">
        How Mason reads your repositories and reports runs on commits.{' '}
        {nowText(setting.kind)}
      </p>
      <div
        className="m-grid-3 m-settings__choices"
        role="radiogroup"
        aria-label="How Mason reaches GitHub"
      >
        {KINDS.map((entry) => (
          <label
            key={entry.kind}
            className={[
              'm-settings__choice',
              kind === entry.kind && 'm-settings__choice--selected',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="m-check">
              <input
                type="radio"
                name="github-kind"
                value={entry.kind}
                checked={kind === entry.kind}
                onChange={() => {
                  actions.clear()
                  setKind(entry.kind)
                }}
              />
              <span>
                <strong className="m-t-headline">{entry.title}</strong>
                {setting.kind === entry.kind && (
                  <span className="m-t-subhead m-settings__inuse">
                    {' '}
                    · in use
                  </span>
                )}
                <br />
                <span className="m-t-subhead m-secondary">{entry.note}</span>
              </span>
            </span>
          </label>
        ))}
      </div>
      {kind === 'token' ? (
        <TokenForm setting={setting} actions={actions} done={done} />
      ) : kind === 'app' ? (
        <AppForm setting={setting} actions={actions} done={done} />
      ) : (
        <DeployKey setting={setting} actions={actions} done={done} />
      )}
    </div>
  )
}

/** The card. */
export function GithubCard(): JSX.Element {
  const read = useResource(GITHUB, asGithubSetting)
  return (
    <SettingsCard
      id="github"
      icon="link"
      title="GitHub"
      actions={
        read.data != null && (
          <span className="m-t-subhead m-secondary">
            {nowText(read.data.kind)}
          </span>
        )
      }
    >
      <Read read={read} what="The GitHub connection">
        {(setting) => <GithubBody setting={setting} done={read.reload} />}
      </Read>
    </SettingsCard>
  )
}
