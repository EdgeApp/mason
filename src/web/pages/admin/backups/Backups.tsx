// Backups, on the master (screen-15-backups): where the hourly encrypted
// snapshot goes and how the last one went, the repository form and the
// deploy key to add to it. An administrator also gets the backup key once
// backups are configured, and confirms they stored it. "Skip for now"
// leaves for the home and keeps it from sending them back here for the
// rest of the browser session.
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { useNavigate } from 'react-router'
import {
  asBackupConfirm,
  asBackupSettingView,
  BACKUP_CONFIRM_PATH,
  BACKUP_SETTING_PATH,
  type BackupSettingChange,
  type BackupSettingView,
} from '../../../../shared/api/backups.js'
import { absoluteTime } from '../../../../shared/format.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Button } from '../../../ui/Button.js'
import { CopyField } from '../../../ui/CopyField.js'
import { FormError, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { StatusPill } from '../../../ui/StatusPill.js'
import { useToast } from '../../../ui/Toast.js'
import { Failed, Loading } from '../../projects/project.js'
import { setBackupsLater } from './later.js'

/** One SHA length everywhere (DESIGN-LANGUAGE.md §16). */
const SHA = 8

/** The status pill of the main card. */
export function backupStatus(view: BackupSettingView): {
  status: string
  label?: string
} {
  if (view.backedUp) return { status: 'backed_up' }
  if (view.lastFailure != null && view.configured)
    return { status: 'failed', label: 'Backup failed' }
  if (!view.configured) return { status: 'not_set_up' }
  return { status: 'no_backup' }
}

/** How the last backup went, in a sentence. */
function StateLine({
  view,
  now,
}: {
  view: BackupSettingView
  now: number
}): JSX.Element {
  const success = view.lastSuccess
  if (view.backedUp && success != null)
    return (
      <p className="m-t-callout m-backups__state">
        Last backup{' '}
        <time dateTime={new Date(success.at).toISOString()}>
          {absoluteTime(success.at, now)}
        </time>{' '}
        (<span className="m-t-mono-sm">{success.commit.slice(0, SHA)}</span>)
        {success.auth == null
          ? ''
          : `, pushed with ${success.auth === 'github' ? 'the GitHub connection' : 'the deploy key'}`}
        .
      </p>
    )
  if (view.lastFailure != null)
    return (
      <p className="m-t-callout m-backups__state m-backups__state--failed">
        The last backup failed: {view.lastFailure.error}
      </p>
    )
  return <p className="m-t-callout m-backups__state">No backup has run yet.</p>
}

/** Skip for now: home, and no sending back here this browser session. */
function SkipForNow(): JSX.Element {
  const navigate = useNavigate()
  return (
    <Button
      variant="plain"
      onClick={() => {
        setBackupsLater()
        void navigate('/')
      }}
    >
      Skip for now
    </Button>
  )
}

/** The hourly backup: state, the repository form and the deploy key. */
function BackupCard({
  view,
  change,
  skip,
  onSaved,
}: {
  view: BackupSettingView
  /** May configure backups (settings.change). */
  change: boolean
  /** Shows Skip for now here (the key card shows it while it waits). */
  skip: boolean
  onSaved: (view: BackupSettingView) => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [repository, setRepository] = useState(view.repository ?? '')
  const [branch, setBranch] = useState(view.branch ?? 'master')
  const [errors, setErrors] = useState<{
    repository?: string
    branch?: string
  }>({})
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  const pill = backupStatus(view)
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(repository.trim() === ''
        ? { repository: 'Enter the repository’s git URL.' }
        : {}),
      ...(branch.trim() === '' ? { branch: 'Enter a branch.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    setBusy(true)
    setFailed(undefined)
    try {
      const body: BackupSettingChange = {
        repository: repository.trim(),
        branch: branch.trim(),
      }
      const saved = await client.put(BACKUP_SETTING_PATH, asBackupSettingView, {
        body,
      })
      toast({ text: 'Backups saved', icon: 'backup' })
      onSaved(saved)
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => error.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="m-card" aria-labelledby="backup-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="backup" />
          <h2 className="m-t-title3" id="backup-title">
            Hourly backup
          </h2>
        </div>
        <StatusPill
          status={pill.status}
          {...(pill.label == null ? {} : { label: pill.label })}
        />
      </header>
      <div className="m-card__body m-stack">
        <p className="m-t-callout m-backups__intro">
          Every hour the master encrypts a snapshot of its database and pushes
          it to a git repository. Add the deploy key below to that repository
          with write access.
        </p>
        <StateLine view={view} now={Date.now()} />
        <form
          className="m-stack"
          name="backup"
          noValidate
          onSubmit={(event) => void save(event)}
        >
          <TextInput
            label="Repository"
            name="repository"
            value={repository}
            onChange={setRepository}
            error={errors.repository}
            placeholder="git@github.com:owner/mason-backup.git"
            help="An SSH or HTTPS git URL."
            autoComplete="off"
            readOnly={!change}
            mono
            verbatim
            required
          />
          <TextInput
            label="Branch"
            name="branch"
            value={branch}
            onChange={setBranch}
            error={errors.branch}
            autoComplete="off"
            readOnly={!change}
            mono
            verbatim
            required
          />
          {failed != null && <FormError ref={error}>{failed}</FormError>}
          {(change || skip) && (
            <div className="m-form__actions">
              {change && (
                <Button variant="primary" type="submit" busy={busy}>
                  Save
                </Button>
              )}
              {skip && <SkipForNow />}
            </div>
          )}
        </form>
        {view.deployKey != null && (
          <div className="m-field">
            <span className="m-field__label">
              Deploy key — add it to the repository with write access
            </span>
            <CopyField value={view.deployKey} block name="the deploy key" />
          </div>
        )}
      </div>
    </section>
  )
}

/** The backup key, for administrators: store it, then say so. */
function KeyCard({
  backupKey,
  confirmed,
  onConfirmed,
}: {
  backupKey: string
  /** Unknown for a key with no creator: nothing to confirm. */
  confirmed: boolean | undefined
  onConfirmed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setFailed(undefined)
    try {
      await client.post(BACKUP_CONFIRM_PATH, asBackupConfirm, { body: {} })
      toast({ text: 'Backup key confirmed', icon: 'check_circle' })
      onConfirmed()
    } catch (reason) {
      setFailed((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="m-card" aria-labelledby="backup-key-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="key" />
          <h2 className="m-t-title3" id="backup-key-title">
            Backup key
          </h2>
        </div>
        {confirmed != null && (
          <StatusPill
            status={confirmed ? 'ok' : 'not_confirmed'}
            {...(confirmed ? { label: 'Confirmed' } : {})}
          />
        )}
      </header>
      <div className="m-card__body m-stack">
        <p className="m-t-callout m-backups__intro">
          Store this key somewhere safe outside this master. Without it no
          backup can be restored.
        </p>
        <CopyField value={backupKey} block name="the backup key" />
        {failed != null && <FormError>{failed}</FormError>}
        {confirmed === true ? (
          <p className="m-t-subhead m-secondary m-backups__intro">
            You confirmed you stored this key.
          </p>
        ) : confirmed === false ? (
          <div className="m-form__actions">
            <Button
              variant="primary"
              icon="check"
              busy={busy}
              onClick={() => void confirm()}
            >
              I have stored the backup key
            </Button>
            <SkipForNow />
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** `/backups`, the master only. */
export function BackupsPage(): JSX.Element {
  const { session } = useShell()
  const change = session.permissions.includes('settings.change')
  const read = useResource(BACKUP_SETTING_PATH, asBackupSettingView)
  const [view, setView] = useState<BackupSettingView | undefined>()
  useEffect(() => {
    if (read.data != null) setView(read.data)
  }, [read.data])
  const shown = view ?? read.data
  const waiting = shown?.backupKey != null && shown.keyConfirmed === false
  return (
    <Page
      crumbs={[{ label: 'Backups' }]}
      title="Backups"
      description="Encrypted copies of this master, kept in a git repository."
    >
      {shown != null ? (
        <div className="m-grid-2 m-backups">
          <BackupCard
            view={shown}
            change={change}
            skip={!waiting}
            onSaved={setView}
          />
          {shown.backupKey != null && (
            <KeyCard
              backupKey={shown.backupKey}
              confirmed={shown.keyConfirmed}
              onConfirmed={() => setView({ ...shown, keyConfirmed: true })}
            />
          )}
        </div>
      ) : read.error != null ? (
        <Failed
          what="The backup setting"
          message={read.error.message}
          retry={read.reload}
        />
      ) : (
        <Loading label="Loading the backup setting" />
      )}
    </Page>
  )
}
