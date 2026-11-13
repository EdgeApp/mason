// The Secrets tab's overlays (screen-06-secrets, screen-06b-secrets-files):
// Add value and Add file as form sheets, and the text-file editor as the
// full-height sheet. Each change is pushed in a backup before the master
// saves it, which the sheets say; each refusal stays in the sheet.
import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  asSecretVariant,
  secretPath,
  secretsPath,
  type SecretAdd,
  type SecretVariant,
} from '../../../shared/api/index.js'
import { bytes } from '../../../shared/format.js'
import { useApi } from '../../api/context.js'
import { Alert } from '../../ui/Alert.js'
import { Button } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { Dialog } from '../../ui/Dialog.js'
import { FileInput, FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { Sheet } from '../../ui/Sheet.js'
import { useToast } from '../../ui/Toast.js'
import { fileContents, fileRefusal, textContents } from './secretFiles.js'

/** A variant's build configs in words: `all`, or the list. */
export const configsText = (configs: string[]): string =>
  configs.length === 0 ? 'all' : configs.join(', ')

/** A field's label, control, help and error, for the controls the library has no field for. */
function Frame({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string
  label: ReactNode
  help?: ReactNode
  error?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div className="m-field">
      <label className="m-field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help != null && (
        <p className="m-field__help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error != null && (
        <p className="m-field__error" id={`${id}-error`} role="alert">
          <Icon name="error" />
          {error}
        </p>
      )}
    </div>
  )
}

const described = (
  id: string,
  help: boolean,
  error: string | undefined,
): string | undefined =>
  [help && `${id}-help`, error != null && `${id}-error`]
    .filter(Boolean)
    .join(' ') || undefined

/** The callout every change carries. */
const BackedUp = (): JSX.Element => (
  <div className="m-callout">
    <Icon name="backup" />
    <span>
      Saving pushes a backup first. If the backup fails, nothing changes.
    </span>
  </div>
)

interface AddProps {
  slug: string
  /** Script projects: paths, a path variable, Mask in logs, and no build configs. */
  script: boolean
  open: boolean
  onClose: () => void
  onAdded: (variant: SecretVariant) => void
}

/** Sends an add, saying what happened; a refusal stays in the sheet. */
function useAdd(
  slug: string,
  onAdded: (variant: SecretVariant) => void,
): {
  busy: boolean
  failed: string | undefined
  error: RefObject<HTMLParagraphElement | null>
  send: (body: () => Promise<SecretAdd>) => Promise<boolean>
  clear: () => void
} {
  const client = useApi()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  return {
    busy,
    failed,
    error,
    clear: (): void => setFailed(undefined),
    send: async (body): Promise<boolean> => {
      setBusy(true)
      setFailed(undefined)
      try {
        const added = await client.post(secretsPath(slug), asSecretVariant, {
          body: await body(),
        })
        toast({
          text: `${added.name} added (${configsText(added.configs)})`,
          icon: added.kind === 'value' ? 'key' : 'description',
        })
        onAdded(added)
        return true
      } catch (reason) {
        setFailed((reason as Error).message)
        setTimeout(() => error.current?.focus(), 0)
        return false
      } finally {
        setBusy(false)
      }
    },
  }
}

/** Add value: its name, its build configs, the value (hidden until shown) and, in a script project, Mask in logs. */
export function AddValueSheet({
  slug,
  script,
  open,
  onClose,
  onAdded,
}: AddProps): JSX.Element {
  const id = useId()
  const [name, setName] = useState('')
  const [configs, setConfigs] = useState('')
  const [value, setValue] = useState('')
  // A pasted value with line breaks moves to a text area, which cannot hide it.
  const [lines, setLines] = useState(false)
  const [shown, setShown] = useState(false)
  const [masked, setMasked] = useState(true)
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({})
  const add = useAdd(slug, onAdded)
  const dirty = name !== '' || configs !== '' || value !== '' || !masked
  const reset = (): void => {
    setName('')
    setConfigs('')
    setValue('')
    setLines(false)
    setShown(false)
    setMasked(true)
    setErrors({})
    add.clear()
  }
  const close = (): void => {
    reset()
    onClose()
  }
  const paste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData('text')
    if (!/[\r\n]/.test(pasted)) return
    event.preventDefault()
    setValue(value + pasted)
    setLines(true)
    setTimeout(() => document.getElementById(`${id}-value`)?.focus(), 0)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = {
      ...(name.trim() === '' ? { name: 'Enter a name.' } : {}),
      ...(value === '' ? { value: 'Enter the value.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    if (
      await add.send(async () => ({
        kind: 'value',
        name: name.trim(),
        configs: script ? '' : configs,
        value,
        ...(script ? { masked } : {}),
      }))
    )
      close()
  }
  const formId = `${id}-form`
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title="Add a secret value"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={add.busy}>
            Save value
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="secret-value"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <TextInput
          label="Name"
          name="name"
          value={name}
          onChange={setName}
          error={errors.name}
          placeholder="API_TOKEN"
          help="Capital letters, digits and underscores: the environment variable it becomes."
          autoComplete="off"
          mono
          verbatim
          required
        />
        {!script && (
          <TextInput
            label="Build configs"
            name="configs"
            value={configs}
            onChange={setConfigs}
            placeholder="all"
            help="Comma-separated. Empty means all."
            autoComplete="off"
            optional
            mono
            verbatim
          />
        )}
        <Frame
          id={`${id}-value`}
          label="Value"
          error={errors.value}
          help={
            lines ? 'It has line breaks, so it is shown as it is.' : undefined
          }
        >
          {lines ? (
            <textarea
              id={`${id}-value`}
              name="value"
              className="m-textarea m-textarea--mono"
              rows={6}
              value={value}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={errors.value != null || undefined}
              aria-describedby={described(`${id}-value`, true, errors.value)}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <div className="m-field__control">
              <input
                id={`${id}-value`}
                name="value"
                className="m-input m-input--mono m-input--end"
                type={shown ? 'text' : 'password'}
                value={value}
                autoComplete="off"
                spellCheck={false}
                aria-required
                aria-invalid={errors.value != null || undefined}
                aria-describedby={described(`${id}-value`, false, errors.value)}
                onPaste={paste}
                onChange={(event) => setValue(event.target.value)}
              />
              <span className="m-affix__end">
                <Button
                  variant="plain"
                  size="sm"
                  iconOnly
                  icon="visibility"
                  label={shown ? 'Hide the value' : 'Show the value'}
                  aria-pressed={shown}
                  onClick={() => setShown((was) => !was)}
                />
              </span>
            </div>
          )}
        </Frame>
        {script && (
          <label className="m-check">
            <input
              type="checkbox"
              name="masked"
              checked={masked}
              onChange={(event) => setMasked(event.target.checked)}
            />
            <span>Mask in logs</span>
          </label>
        )}
        <BackedUp />
        {add.failed != null && (
          <FormError ref={add.error}>{add.failed}</FormError>
        )}
      </form>
    </Sheet>
  )
}

/**
 * Add file: a drop zone (up to 5 MiB) or its text pasted, its file name
 * (a path in the checkout in a script project), its build configs, and in
 * a script project the variable that holds its path.
 */
export function AddFileSheet({
  slug,
  script,
  open,
  onClose,
  onAdded,
}: AddProps): JSX.Element {
  const id = useId()
  const [file, setFile] = useState<File | undefined>()
  const [fileError, setFileError] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [configs, setConfigs] = useState('')
  const [pathEnv, setPathEnv] = useState('')
  const [errors, setErrors] = useState<{ name?: string }>({})
  const add = useAdd(slug, onAdded)
  const dirty =
    file != null ||
    text !== '' ||
    name !== '' ||
    configs !== '' ||
    pathEnv !== ''
  const reset = (): void => {
    setFile(undefined)
    setFileError(undefined)
    setText('')
    setName('')
    setConfigs('')
    setPathEnv('')
    setErrors({})
    add.clear()
  }
  const close = (): void => {
    reset()
    onClose()
  }
  const choose = (chosen: File | undefined): void => {
    if (chosen == null) return
    const refusal = fileRefusal(chosen)
    setFileError(refusal)
    if (refusal != null) {
      setFile(undefined)
      return
    }
    setFile(chosen)
    if (name === '') setName(chosen.name)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = name.trim() === '' ? { name: 'Enter its name.' } : {}
    setErrors(wrong)
    const nothing =
      file == null && text === ''
        ? 'Drop or choose a file, or paste its text'
        : undefined
    setFileError(nothing)
    if (nothing != null || wrong.name != null) return
    if (
      await add.send(async () => ({
        kind: 'file',
        name: name.trim(),
        configs: script ? '' : configs,
        contents: file != null ? await fileContents(file) : textContents(text),
        ...(script && pathEnv.trim() !== '' ? { pathEnv: pathEnv.trim() } : {}),
      }))
    )
      close()
  }
  const formId = `${id}-form`
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title="Add a secret file"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={add.busy}>
            Save file
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="secret-file"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <FileInput
          label="File"
          file={file}
          onChange={choose}
          choose="Choose a file"
          hint="Up to 5 MiB."
          describe={(chosen) => bytes(chosen.size)}
          error={fileError}
        />
        <div className="m-or">or paste its text</div>
        <Frame
          id={`${id}-text`}
          label={<span className="m-sr">File text</span>}
        >
          <textarea
            id={`${id}-text`}
            name="text"
            className="m-textarea m-textarea--mono"
            rows={4}
            value={text}
            placeholder="{ … }"
            spellCheck={false}
            disabled={file != null}
            onChange={(event) => setText(event.target.value)}
          />
        </Frame>
        <div className="m-grid-2">
          <TextInput
            label={script ? 'Path in the checkout' : 'File name'}
            name="name"
            value={name}
            onChange={setName}
            error={errors.name}
            placeholder={
              script ? 'android/app/google-services.json' : 'config.json'
            }
            help={
              script
                ? 'Letters, digits, dots, dashes and underscores, with / between directories: where the build stage finds the file.'
                : 'Letters, digits, dots, dashes and underscores. The Masonfile chooses the directory.'
            }
            autoComplete="off"
            mono
            verbatim
            required
          />
          {script ? (
            <TextInput
              label="Path variable"
              name="pathEnv"
              value={pathEnv}
              onChange={setPathEnv}
              help="The variable that holds the file’s path in the build."
              autoComplete="off"
              optional
              mono
              verbatim
            />
          ) : (
            <TextInput
              label="Build configs"
              name="configs"
              value={configs}
              onChange={setConfigs}
              placeholder="all"
              help="Comma-separated. Empty means all."
              autoComplete="off"
              optional
              mono
              verbatim
            />
          )}
        </div>
        <BackedUp />
        {add.failed != null && (
          <FormError ref={add.error}>{add.failed}</FormError>
        )}
      </form>
    </Sheet>
  )
}

/** What the editor is open on: a text file, or a value with line breaks. */
export interface Editing {
  variant: SecretVariant
  text: string
  /** Every line ended in CRLF: a save puts them back. */
  crlf: boolean
}

/**
 * The text-file editor: the largest sheet, the file's text in a full-height
 * mono area, Save and Cancel; Esc closes, asking first when it changed.
 */
export function SecretEditor({
  slug,
  editing,
  onClose,
  onSaved,
}: {
  slug: string
  editing: Editing | undefined
  onClose: () => void
  onSaved: (variant: SecretVariant) => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const titleId = useId()
  const [text, setText] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const shown = text ?? editing?.text ?? ''
  const dirty = editing != null && text != null && text !== editing.text
  const finish = (): void => {
    setText(undefined)
    setFailed(undefined)
    setConfirming(false)
    onClose()
  }
  const requestClose = (): void => {
    // A save in flight keeps the editor open, so its end is seen.
    if (busy) return
    if (dirty) setConfirming(true)
    else finish()
  }
  const save = async (): Promise<void> => {
    if (editing == null) return
    const contents = editing.crlf ? shown.replace(/\n/g, '\r\n') : shown
    setBusy(true)
    setFailed(undefined)
    try {
      const saved = await client.put(
        secretPath(slug, editing.variant.id),
        asSecretVariant,
        {
          body:
            editing.variant.kind === 'file'
              ? { text: contents }
              : { value: contents },
        },
      )
      toast({ text: `${saved.name} saved`, icon: 'check_circle' })
      setText(undefined)
      onSaved(saved)
    } catch (reason) {
      setFailed((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const variant = editing?.variant
  return (
    <>
      <Dialog
        open={editing != null}
        onClose={requestClose}
        labelledBy={titleId}
        initialFocus={area}
      >
        <div className="m-editor">
          <div className="m-formsheet__head">
            <h2
              className="m-t-title3 m-t-mono m-wrap-any"
              id={titleId}
              tabIndex={-1}
              data-dialog-title=""
            >
              {variant?.name}
            </h2>
            {variant != null && (
              <Chip kind="mono">{configsText(variant.configs)}</Chip>
            )}
            <span className="m-editor__spacer" />
            <Button variant="secondary" size="sm" onClick={requestClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              busy={busy}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
          <textarea
            ref={area}
            aria-label={`Contents of ${variant?.name ?? ''}`}
            value={shown}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
          {failed != null && (
            <div className="m-editor__error">
              <FormError>{failed}</FormError>
            </div>
          )}
          <div className="m-formsheet__foot m-editor__foot">
            <span className="m-t-subhead m-tertiary">
              Esc closes · Changes are backed up before they are saved
            </span>
            <span className="m-t-mono-sm m-tertiary">
              {editing?.crlf === true ? 'CRLF' : 'LF'} · UTF-8
            </span>
          </div>
        </div>
      </Dialog>
      <Alert
        open={editing != null && confirming}
        title="Discard your changes?"
        message={`What you changed in ${variant?.name ?? 'the file'} is not saved.`}
        cancel="Keep editing"
        confirm="Discard"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={finish}
      />
    </>
  )
}
