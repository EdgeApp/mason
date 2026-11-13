// A project's Secrets, on the master only (screen-06-secrets,
// screen-06b-secrets-files): its values and files, each limited to build
// configs, never their contents. Anyone who may read the project sees the
// names; managers and administrators add values and files, edit a value or
// a text file (a value inline, a text file or a value with line breaks in
// the editor), replace a binary file, change build configs inline and
// delete with a confirm (tier 2), and read the audit. Every change is
// pushed in a backup first, so until backups are configured changing is
// off, with the reason. A fetch of contents is audited as a view.
import { useEffect, useRef, useState, type JSX } from 'react'
import { useParams } from 'react-router'
import { asUnknown } from 'cleaners'
import {
  asSecretAudit,
  asSecretContents,
  asSecretsBackups,
  asSecretVariant,
  asSecretVariants,
  secretPath,
  secretsAuditPath,
  secretsBackupsPath,
  secretsPath,
  type ProjectOverview,
  type SecretVariant,
} from '../../../shared/api/index.js'
import { absoluteTime, bytes } from '../../../shared/format.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import { useShell } from '../../layout/ShellContext.js'
import { Alert } from '../../ui/Alert.js'
import { Count } from '../../ui/Badge.js'
import { Banner } from '../../ui/Banner.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { SkeletonText } from '../../ui/Skeleton.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { useToast } from '../../ui/Toast.js'
import { Failed, Loading, ProjectPage } from './project.js'
import { editableText, fileContents, fileRefusal } from './secretFiles.js'
import {
  AddFileSheet,
  AddValueSheet,
  configsText,
  SecretEditor,
  type Editing,
} from './secretSheets.js'

/** Why changing is off until backups are configured. */
const NEEDS_BACKUPS = 'Configure backups first'

/** A variant's notes under its name: masking, where a file goes, its size. */
export function secretNotes(variant: SecretVariant): string[] {
  return [
    ...(variant.kind === 'value' && !variant.masked
      ? ['Not masked in logs']
      : []),
    ...(variant.pathEnv == null ? [] : [`→ $${variant.pathEnv}`]),
    ...(variant.destination != null && variant.destination !== variant.name
      ? [`at ${variant.destination}`]
      : []),
    ...(variant.kind === 'file'
      ? [`${bytes(variant.bytes)} · ${variant.text ? 'text' : 'binary'}`]
      : []),
  ]
}

/** An audit action as a word, a refusal as its status. */
function AuditAction({ action }: { action: string }): JSX.Element {
  if (action === 'refused') return <StatusPill quiet status="refused_audit" />
  return <>{action.charAt(0).toUpperCase() + action.slice(1)}</>
}

/** Every view of a value or file, every change and every refusal; never a value. */
function Audit({
  slug,
  generation,
}: {
  slug: string
  generation: number
}): JSX.Element {
  const read = useResource(secretsAuditPath(slug), asSecretAudit)
  const { reload } = read
  // Each saved change is in the audit: read it again.
  useEffect(() => {
    if (generation > 0) reload()
  }, [generation, reload])
  const now = Date.now()
  return (
    <section className="m-card" aria-labelledby="audit-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="history" />
          <h2 className="m-t-title3" id="audit-title">
            Audit
          </h2>
        </div>
        <span className="m-t-subhead m-tertiary">
          Values are never recorded
        </span>
      </header>
      {read.data == null ? (
        read.error != null ? (
          <div className="m-card__body">
            <FormError>{read.error.message}</FormError>
          </div>
        ) : (
          <div className="m-card__body">
            <SkeletonText lines={4} label="Loading the audit" />
          </div>
        )
      ) : read.data.length === 0 ? (
        <EmptyState icon="history" title="Nothing yet." />
      ) : (
        <div className="m-table-wrap">
          <table className="m-table m-table--stack">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Secret</th>
                <th scope="col">Action</th>
                <th scope="col">Address</th>
              </tr>
            </thead>
            <tbody>
              {read.data.map((entry) => (
                <tr key={entry.id}>
                  <td data-primary data-label="When" className="m-num m-left">
                    <time dateTime={new Date(entry.at).toISOString()}>
                      {absoluteTime(entry.at, now)}
                    </time>
                  </td>
                  <td data-label="Who">{entry.who}</td>
                  <td data-label="Secret">
                    <span className="m-row">
                      <span className="m-t-mono-sm">{entry.name}</span>
                      <Chip kind="mono">{configsText(entry.configs)}</Chip>
                    </span>
                  </td>
                  <td data-label="Action">
                    <AuditAction action={entry.action} />
                    {entry.detail != null && (
                      <span className="m-t-subhead m-secondary m-secrets__detail">
                        {entry.detail}
                      </span>
                    )}
                  </td>
                  <td data-label="Address" className="m-t-mono-sm">
                    {entry.address}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** A row being edited in place: a value, or its build configs. */
interface RowEdit {
  id: number
  mode: 'value' | 'configs'
  text: string
}

/** The edit block a row becomes: its one field, then Cancel and Save. */
function EditBlock({
  variant,
  edit,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  variant: SecretVariant
  edit: RowEdit
  busy: boolean
  error: string | undefined
  onChange: (text: string) => void
  onCancel: () => void
  onSave: () => void
}): JSX.Element {
  return (
    <tr className="m-secrets__editrow">
      <td colSpan={3}>
        <form
          className="m-editblock"
          aria-label={`Edit ${variant.name}`}
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel()
          }}
        >
          <div className="m-editblock__fields">
            {edit.mode === 'value' ? (
              <TextInput
                label={`Value of ${variant.name}`}
                value={edit.text}
                onChange={onChange}
                autoComplete="off"
                autoFocus
                mono
                verbatim
              />
            ) : (
              <TextInput
                label={`Build configs of ${variant.name}`}
                value={edit.text}
                onChange={onChange}
                placeholder="all"
                help="Comma-separated. Empty means all."
                autoComplete="off"
                autoFocus
                mono
                verbatim
              />
            )}
          </div>
          {error != null && <FormError>{error}</FormError>}
          <div className="m-editblock__foot">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" busy={busy}>
              Save
            </Button>
          </div>
        </form>
      </td>
    </tr>
  )
}

/** The secrets table with every manager's action, and the add sheets, the editor and the delete confirm. */
function SecretsCard({
  slug,
  script,
  variants,
  manage,
  backups,
  changed,
}: {
  slug: string
  script: boolean
  variants: SecretVariant[]
  /** A manager or administrator: the actions. */
  manage: boolean
  /** Backups are configured, so changes may be made. */
  backups: boolean
  /** A change was saved: read the list and the audit again. */
  changed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [adding, setAdding] = useState<'value' | 'file' | undefined>()
  const [editing, setEditing] = useState<Editing | undefined>()
  const [edit, setEdit] = useState<RowEdit | undefined>()
  const [deleting, setDeleting] = useState<SecretVariant | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [refusal, setRefusal] = useState<SecretVariant | undefined>()
  const picker = useRef<HTMLInputElement>(null)
  const replacing = useRef<SecretVariant | undefined>(undefined)
  const off = manage && !backups ? NEEDS_BACKUPS : undefined
  const fail = (variant: SecretVariant, reason: unknown): void =>
    setErrors((was) => ({ ...was, [variant.id]: (reason as Error).message }))
  const clear = (variant: SecretVariant): void =>
    setErrors((was) =>
      Object.fromEntries(
        Object.entries(was).filter(([id]) => Number(id) !== variant.id),
      ),
    )
  /** Opens a value or a text file to edit: inline, or in the editor when it has lines. */
  const open = async (variant: SecretVariant): Promise<void> => {
    clear(variant)
    setRefusal(undefined)
    setBusy(`open-${variant.id}`)
    try {
      const contents = await client.get(
        secretPath(slug, variant.id),
        asSecretContents,
      )
      const text =
        'value' in contents
          ? contents.value
          : 'text' in contents
            ? contents.text
            : undefined
      if (text == null)
        throw new Error(`${variant.name} is binary: replace it instead`)
      if (variant.kind === 'value' && !/[\r\n]/.test(text)) {
        setEdit({ id: variant.id, mode: 'value', text })
        return
      }
      const editable = editableText(text)
      if (editable == null) {
        setRefusal(variant)
        return
      }
      setEditing({ variant, text: editable.text, crlf: editable.crlf })
    } catch (reason) {
      fail(variant, reason)
    } finally {
      setBusy(undefined)
    }
  }
  const saveEdit = async (variant: SecretVariant): Promise<void> => {
    if (edit == null) return
    setBusy(`save-${variant.id}`)
    clear(variant)
    try {
      const saved =
        edit.mode === 'value'
          ? await client.put(secretPath(slug, variant.id), asSecretVariant, {
              body: { value: edit.text },
            })
          : await client.put(
              secretPath(slug, variant.id, 'configs'),
              asSecretVariant,
              { body: { configs: edit.text } },
            )
      toast({
        text:
          edit.mode === 'value'
            ? `${saved.name} saved`
            : `${saved.name} now for ${configsText(saved.configs)}`,
        icon: 'check_circle',
      })
      setEdit(undefined)
      changed()
    } catch (reason) {
      fail(variant, reason)
    } finally {
      setBusy(undefined)
    }
  }
  const replace = async (variant: SecretVariant, file: File): Promise<void> => {
    clear(variant)
    setRefusal(undefined)
    const refused = fileRefusal(file)
    if (refused != null) {
      fail(variant, new Error(refused))
      return
    }
    setBusy(`replace-${variant.id}`)
    try {
      await client.put(secretPath(slug, variant.id, 'file'), asSecretVariant, {
        body: { contents: await fileContents(file) },
      })
      toast({ text: `${variant.name} replaced`, icon: 'upload' })
      changed()
    } catch (reason) {
      fail(variant, reason)
    } finally {
      setBusy(undefined)
    }
  }
  const remove = async (variant: SecretVariant): Promise<void> => {
    setBusy(`delete-${variant.id}`)
    try {
      await client.delete(secretPath(slug, variant.id), asUnknown)
      toast({
        text: `${variant.name} (${configsText(variant.configs)}) deleted`,
        icon: 'delete',
      })
      setDeleting(undefined)
      changed()
    } catch (reason) {
      setDeleting(undefined)
      fail(variant, reason)
    } finally {
      setBusy(undefined)
    }
  }
  const chooseReplacement = (variant: SecretVariant): void => {
    replacing.current = variant
    picker.current?.click()
  }
  return (
    <section className="m-card" aria-labelledby="secrets-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="key" />
          <h2 className="m-t-title3" id="secrets-title">
            Secrets
          </h2>
          <Count count={variants.length} />
        </div>
        {manage && (
          <div className="m-btngroup m-secrets__add">
            {off != null && (
              <span className="m-t-subhead m-tertiary">{off}</span>
            )}
            <Button
              variant="tinted"
              size="sm"
              icon="add"
              aria-haspopup="dialog"
              disabled={off != null}
              title={off}
              onClick={() => setAdding('value')}
            >
              Add value
            </Button>
            <Button
              variant="tinted"
              size="sm"
              icon="upload"
              aria-haspopup="dialog"
              disabled={off != null}
              title={off}
              onClick={() => setAdding('file')}
            >
              Add file
            </Button>
          </div>
        )}
      </header>
      <div className="m-card__body m-stack m-secrets__intro">
        <div className="m-callout">
          <Icon name="info" />
          {script ? (
            <span>
              This is a script project: its build stage gets every value as an
              environment variable, and every file written into the checkout at
              its name, a path such as{' '}
              <code className="m-t-mono-sm">
                android/app/google-services.json
              </code>
              . Script projects have no build configs.
            </span>
          ) : (
            <span>
              Stages that list a value in{' '}
              <code className="m-t-mono-sm">secrets</code> get it as an
              environment variable, and the Masonfile reads it with{' '}
              <code className="m-t-mono-sm">ctx.secret(name)</code>; it writes a
              file with{' '}
              <code className="m-t-mono-sm">
                await ctx.writeSecretFile(name, directory)
              </code>
              . A secret’s build configs limit it to stages that list one of
              them in <code className="m-t-mono-sm">configs</code>; one with
              none is used by every other stage.
            </span>
          )}
        </div>
        {refusal != null && (
          <Banner
            tone="danger"
            title={
              refusal.kind === 'file'
                ? 'This file mixes line endings'
                : 'This value mixes line endings'
            }
            actions={
              <>
                {refusal.kind === 'file' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="upload"
                    onClick={() => chooseReplacement(refusal)}
                  >
                    Replace
                  </Button>
                )}
                <Button
                  variant="plain"
                  size="sm"
                  onClick={() => setRefusal(undefined)}
                >
                  Dismiss
                </Button>
              </>
            }
          >
            {refusal.kind === 'file'
              ? `The editor would change them in ${refusal.name}. Replace the file instead.`
              : `The editor would change them in ${refusal.name}.`}
          </Banner>
        )}
      </div>
      {variants.length === 0 ? (
        <EmptyState icon="key" title="No secrets yet." />
      ) : (
        <div className="m-table-wrap">
          <table className="m-table m-table--stack m-secrets">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Build configs</th>
                <th scope="col">
                  <span className="m-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {variants.flatMap((variant) => {
                const notes = secretNotes(variant)
                const error = errors[variant.id]
                const editable = variant.kind === 'value' || variant.text
                if (edit?.id === variant.id)
                  return [
                    <EditBlock
                      key={variant.id}
                      variant={variant}
                      edit={edit}
                      busy={busy === `save-${variant.id}`}
                      error={error}
                      onChange={(text) => setEdit({ ...edit, text })}
                      onCancel={() => {
                        setEdit(undefined)
                        clear(variant)
                      }}
                      onSave={() => void saveEdit(variant)}
                    />,
                  ]
                const row = (
                  <tr
                    key={variant.id}
                    data-secret={variant.name}
                    data-kind={variant.kind}
                  >
                    <td data-primary data-label="Name">
                      <span className="m-row m-secrets__name">
                        <Icon
                          name={
                            variant.kind === 'value' ? 'key' : 'description'
                          }
                        />
                        <span className="m-list__main">
                          <span className="m-t-mono m-wrap-any m-secrets__title">
                            {variant.name}
                          </span>
                          {notes.length > 0 && (
                            <span className="m-t-subhead m-secondary">
                              {notes.join(' · ')}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td data-label="Build configs">
                      <span className="m-row">
                        {manage && !script ? (
                          <button
                            type="button"
                            className="m-chip m-chip--mono"
                            title={off ?? 'Change build configs'}
                            aria-label={`Build configs of ${variant.name}: ${configsText(variant.configs)}. Change`}
                            disabled={off != null}
                            onClick={() =>
                              setEdit({
                                id: variant.id,
                                mode: 'configs',
                                text: variant.configs.join(', '),
                              })
                            }
                          >
                            {configsText(variant.configs)}
                          </button>
                        ) : (
                          <Chip kind="mono">
                            {configsText(variant.configs)}
                          </Chip>
                        )}
                      </span>
                    </td>
                    <td data-actions>
                      {manage && (
                        <div className="m-table__actions">
                          {editable ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon="edit"
                              busy={busy === `open-${variant.id}`}
                              disabled={off != null}
                              title={off}
                              aria-label={`Edit ${variant.name}`}
                              onClick={() => void open(variant)}
                            >
                              Edit
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon="upload"
                              busy={busy === `replace-${variant.id}`}
                              disabled={off != null}
                              title={off}
                              aria-label={`Replace ${variant.name}`}
                              onClick={() => chooseReplacement(variant)}
                            >
                              Replace
                            </Button>
                          )}
                          <Button
                            variant="danger"
                            size="sm"
                            icon="delete"
                            disabled={off != null}
                            title={off}
                            aria-label={`Delete ${variant.name}`}
                            aria-haspopup="dialog"
                            onClick={() => setDeleting(variant)}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
                return error == null
                  ? [row]
                  : [
                      row,
                      <tr
                        key={`${variant.id}-error`}
                        className="m-secrets__errorrow"
                      >
                        <td colSpan={3}>
                          <FormError>{error}</FormError>
                        </td>
                      </tr>,
                    ]
              })}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <>
          <input
            ref={picker}
            type="file"
            className="m-vh"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              const variant = replacing.current
              // Cleared, so choosing the same file again is a change too.
              event.currentTarget.value = ''
              if (file != null && variant != null) void replace(variant, file)
            }}
          />
          <AddValueSheet
            slug={slug}
            script={script}
            open={adding === 'value'}
            onClose={() => setAdding(undefined)}
            onAdded={changed}
          />
          <AddFileSheet
            slug={slug}
            script={script}
            open={adding === 'file'}
            onClose={() => setAdding(undefined)}
            onAdded={changed}
          />
          <SecretEditor
            slug={slug}
            editing={editing}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined)
              changed()
            }}
          />
          <Alert
            open={deleting != null}
            title={`Delete ${deleting?.name ?? ''}?`}
            message={`Stages in ${configsText(deleting?.configs ?? [])} build configs can no longer read it. The change is backed up first.`}
            cancel="Keep it"
            confirm="Delete"
            tone="danger"
            busy={deleting != null && busy === `delete-${deleting.id}`}
            onCancel={() => setDeleting(undefined)}
            onConfirm={() => {
              if (deleting != null) void remove(deleting)
            }}
          />
        </>
      )}
    </section>
  )
}

/** The tab's reads: the list, whether backups are configured, and the audit for managers. */
function SecretsBody({ overview }: { overview: ProjectOverview }): JSX.Element {
  const { session } = useShell()
  const slug = overview.slug
  const list = useResource(secretsPath(slug), asSecretVariants)
  const backups = useResource(secretsBackupsPath(slug), asSecretsBackups)
  const [generation, setGeneration] = useState(0)
  const manage = session.permissions.includes('secrets.change')
  const audit = session.permissions.includes('secrets.read')
  const configured = backups.data?.backupsConfigured ?? true
  return (
    <>
      {manage && backups.data?.backupsConfigured === false && (
        <Banner
          tone="warning"
          icon="backup"
          title="Configure backups before changing secrets"
          actions={
            <ButtonLink variant="secondary" size="sm" to="/backups">
              Open Backups
            </ButtonLink>
          }
        >
          Every change is pushed in a backup before it is saved. Until then,
          adding, editing and deleting secrets is off.
        </Banner>
      )}
      {list.data != null ? (
        <SecretsCard
          slug={slug}
          script={overview.format === 'script'}
          variants={list.data}
          manage={manage}
          backups={configured}
          changed={() => {
            list.reload()
            setGeneration((n) => n + 1)
          }}
        />
      ) : list.error != null ? (
        <Failed
          what="The secrets"
          message={list.error.message}
          retry={list.reload}
        />
      ) : (
        <Loading label="Loading the secrets" />
      )}
      {audit && <Audit slug={slug} generation={generation} />}
    </>
  )
}

/** `/projects/:slug/secrets`, the master only. */
export function SecretsPage(): JSX.Element {
  const { slug = '' } = useParams()
  return (
    <ProjectPage
      slug={slug}
      tab="secrets"
      title="Secrets"
      crumbs={[{ label: 'Secrets' }]}
      description="Values and files the project’s stages may read, each limited to build configs."
    >
      {(overview) => <SecretsBody overview={overview} />}
    </ProjectPage>
  )
}
