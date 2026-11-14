// Settings → Node types (screen-10b-settings-more): the software and
// settings every node of a type keeps, one row per type with what it
// installs in a few words and who accepted its Android SDK licences. Each
// is edited in a large sheet — Xcode, packages and runtimes, then the
// machine's settings — that keeps a draft; Add a node type opens it empty
// with a Name; Remove type confirms naming it (tier 2).
import { useMemo, useState, type FormEvent, type JSX } from 'react'
import {
  asNodeTypeSettings,
  nodeTypePath,
  settingsPath,
  type NodeType,
} from '../../../../shared/api/settings.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Alert } from '../../../ui/Alert.js'
import { Count } from '../../../ui/Badge.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import {
  CheckboxInput,
  TextInput,
  type TextInputProps,
} from '../../../ui/Field.js'
import {
  FormDisclosure,
  FormSection,
  LargeSheet,
  useDraft,
} from '../../../ui/LargeSheet.js'
import { useToast } from '../../../ui/Toast.js'
import {
  day,
  Failure,
  listOf,
  Read,
  SettingsCard,
  useActions,
} from './parts.js'

/** A type's name: 1–40 lowercase letters, digits and dashes. */
const TYPE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A version a runtime is pinned to. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`

/** A node type in a few words: what it installs, not its JSON. */
export function typeSummary(type: NodeType): string {
  const software = type.software
  const versions: Array<[string, string | undefined]> = [
    ['Node', software.node],
    ['Java', software.java],
    ['Rust', software.rust],
    ['Python', software.python],
    ['Go', software.go],
    ['Ruby', software.ruby],
  ]
  const brew = software.brew.formulae.length + software.brew.casks.length
  return [
    ...(software.xcode.length === 0
      ? []
      : [`Xcode ${software.xcode.join(', ')}`]),
    ...versions.flatMap(([name, version]) =>
      version == null ? [] : [`${name} ${version}`],
    ),
    ...(brew === 0 ? [] : [plural(brew, 'Homebrew package')]),
    ...(software.apt.length === 0
      ? []
      : [plural(software.apt.length, 'apt package')]),
    ...(software.dnf.length === 0
      ? []
      : [plural(software.dnf.length, 'dnf package')]),
    ...(software.docker ? ['Docker'] : []),
    ...(software.android.length === 0
      ? []
      : [plural(software.android.length, 'Android SDK package')]),
    `Disk threshold ${type.diskThresholdGb} GB`,
  ].join(' · ')
}

/** The sheet's fields, as text and checks. */
export interface TypeDraft {
  name: string
  xcode: string
  xcodeDefault: string
  allowBeta: boolean
  simulators: string
  commandLineTools: boolean
  rosetta: boolean
  formulae: string
  casks: string
  apt: string
  dnf: string
  docker: boolean
  node: string
  java: string
  rust: string
  python: string
  go: string
  ruby: string
  android: string
  noSleep: boolean
  devToolsSecurity: boolean
  automationMode: boolean
  diskThresholdGb: string
}

/** A type as the sheet's fields; a new one empty. */
export function typeDraft(
  name: string | undefined,
  type: NodeType | undefined,
): TypeDraft {
  const software = type?.software
  const list = (items: string[] | undefined): string => (items ?? []).join(', ')
  return {
    name: name ?? '',
    xcode: list(software?.xcode),
    xcodeDefault: software?.xcodeDefault ?? '',
    allowBeta: software?.allowBeta ?? false,
    simulators: list(software?.simulators),
    commandLineTools: software?.commandLineTools ?? false,
    rosetta: software?.rosetta ?? false,
    formulae: list(software?.brew.formulae),
    casks: list(software?.brew.casks),
    apt: list(software?.apt),
    dnf: list(software?.dnf),
    docker: software?.docker ?? false,
    node: software?.node ?? '',
    java: software?.java ?? '',
    rust: software?.rust ?? '',
    python: software?.python ?? '',
    go: software?.go ?? '',
    ruby: software?.ruby ?? '',
    android: list(software?.android),
    noSleep: type?.settings.noSleep ?? false,
    devToolsSecurity: type?.settings.devToolsSecurity ?? false,
    automationMode: type?.settings.automationMode ?? false,
    diskThresholdGb: String(type?.diskThresholdGb ?? 40),
  }
}

const RUNTIMES = ['node', 'java', 'rust', 'python', 'go', 'ruby'] as const

type Errors = Partial<Record<keyof TypeDraft, string>>

/** What is wrong with the fields, by field. */
export function typeErrors(draft: TypeDraft, adding: boolean): Errors {
  const errors: Errors = {}
  if (adding && !TYPE_NAME.test(draft.name.trim()))
    errors.name = 'Use 1 to 40 lowercase letters, digits and dashes.'
  for (const field of ['xcodeDefault', ...RUNTIMES] as const) {
    const value = draft[field].trim()
    if (value !== '' && !VERSION.test(value))
      errors[field] = 'Enter a version such as 24 or 3.12, or leave it empty.'
  }
  if (!/^[0-9]+$/.test(draft.diskThresholdGb.trim()))
    errors.diskThresholdGb = 'Enter whole gigabytes, 0 or more.'
  return errors
}

/** What the node type route takes. */
export function typeBody(
  draft: TypeDraft,
  adding: boolean,
): Record<string, unknown> {
  const version = (field: (typeof RUNTIMES)[number]): Record<string, string> =>
    draft[field].trim() === '' ? {} : { [field]: draft[field].trim() }
  return {
    software: {
      xcode: listOf(draft.xcode),
      ...(draft.xcodeDefault.trim() === ''
        ? {}
        : { xcodeDefault: draft.xcodeDefault.trim() }),
      allowBeta: draft.allowBeta,
      simulators: listOf(draft.simulators),
      commandLineTools: draft.commandLineTools,
      rosetta: draft.rosetta,
      brew: { formulae: listOf(draft.formulae), casks: listOf(draft.casks) },
      apt: listOf(draft.apt),
      dnf: listOf(draft.dnf),
      docker: draft.docker,
      ...RUNTIMES.reduce(
        (all, field) => ({ ...all, ...version(field) }),
        {} as Record<string, string>,
      ),
      android: listOf(draft.android),
    },
    settings: {
      noSleep: draft.noSleep,
      devToolsSecurity: draft.devToolsSecurity,
      automationMode: draft.automationMode,
    },
    diskThresholdGb: Number(draft.diskThresholdGb.trim()),
    ...(adding ? { create: true } : {}),
  }
}

/** What the sheet edits: a type by name, or a new one. */
export interface Editing {
  name?: string
  type?: NodeType
}

/** A node type's editor, or a new one's, in a large sheet. */
function TypeSheet({
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
  const adding = editing != null && editing.name == null
  const key = editing == null ? null : `nodeType:${editing.name ?? '\u0000new'}`
  const initial = useMemo(
    () => typeDraft(editing?.name, editing?.type),
    [editing],
  )
  const draft = useDraft(key, initial)
  const [errors, setErrors] = useState<Errors>({})
  const [removing, setRemoving] = useState(false)
  const value = draft.value
  const text = (
    name: keyof TypeDraft,
  ): Pick<TextInputProps, 'value' | 'onChange' | 'error'> => ({
    value: value[name] as string,
    onChange: (next: string) => draft.set((was) => ({ ...was, [name]: next })),
    error: errors[name],
  })
  const flag = (
    name: keyof TypeDraft,
  ): { checked: boolean; onChange: (checked: boolean) => void } => ({
    checked: value[name] as boolean,
    onChange: (checked) => draft.set((was) => ({ ...was, [name]: checked })),
  })
  const close = (): void => {
    draft.clear()
    setErrors({})
    actions.clear()
    onClose()
  }
  const name = adding ? value.name.trim() : (editing?.name ?? '')
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong = typeErrors(value, adding)
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const ok = await actions.run('save', async () => {
      await client.put(nodeTypePath(name), asNodeTypeSettings, {
        body: typeBody(value, adding),
      })
    })
    if (!ok) return
    toast({
      text: `${name} ${adding ? 'added' : 'saved'}`,
      icon: 'check_circle',
    })
    close()
    onSaved()
  }
  const remove = async (): Promise<void> => {
    const ok = await actions.run('remove', async () => {
      await client.delete(nodeTypePath(name), asNodeTypeSettings)
    })
    setRemoving(false)
    if (!ok) return
    toast({ text: `${name} removed`, icon: 'delete' })
    close()
    onSaved()
  }
  const settingsWrong = errors.diskThresholdGb != null
  const formId = 'node-type-form'
  const version = (
    field: (typeof RUNTIMES)[number],
    label: string,
    placeholder: string,
    help: string,
  ): JSX.Element => (
    <TextInput
      label={label}
      {...text(field)}
      placeholder={placeholder}
      help={help}
      optional
      autoComplete="off"
      mono
      verbatim
    />
  )
  return (
    <LargeSheet
      open={editing != null}
      onClose={close}
      dirty={draft.dirty}
      title={
        adding ? (
          'Add a node type'
        ) : (
          <>
            Node type <span className="m-t-mono">{editing?.name}</span>
          </>
        )
      }
      footer={(requestClose) => (
        <>
          {!adding && (
            <Button
              variant="danger"
              icon="delete"
              className="m-settings__footstart"
              aria-haspopup="dialog"
              onClick={() => setRemoving(true)}
            >
              Remove type
            </Button>
          )}
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            icon={adding ? 'add' : 'check'}
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
            Your unsaved changes were restored.
          </p>
        )}
        {adding && (
          <FormSection legend="Type">
            <TextInput
              label="Name"
              {...text('name')}
              placeholder="macos-arm64"
              help="As the Masonfile and pools name it."
              maxLength={40}
              autoComplete="off"
              mono
              verbatim
              required
            />
          </FormSection>
        )}
        <FormSection legend="Software: Xcode">
          <TextInput
            label="Xcode versions"
            {...text('xcode')}
            placeholder="26.1, 16.4"
            help="Kept installed side by side. Comma-separated."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <TextInput
            label="Default Xcode"
            {...text('xcodeDefault')}
            placeholder="26.1"
            help="The Xcode a stage uses when it names none and the repository has no .xcode-version; one of the versions above."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <TextInput
            label="Simulator runtimes"
            {...text('simulators')}
            placeholder="iOS 26.1"
            help="Runtimes to keep, such as iOS 26.1. Comma-separated."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <CheckboxInput
            label="Allow beta Xcodes"
            {...flag('allowBeta')}
            help="Whether latest-beta may pick a beta."
          />
          <CheckboxInput
            label="Command Line Tools"
            {...flag('commandLineTools')}
            help="Apple’s command line developer tools."
          />
          <CheckboxInput
            label="Rosetta"
            {...flag('rosetta')}
            help="Runs Intel binaries on Apple silicon."
          />
        </FormSection>
        <FormSection legend="Software: packages">
          <TextInput
            label="Homebrew formulae"
            {...text('formulae')}
            help="Installed with brew install. Comma-separated."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <TextInput
            label="Homebrew casks"
            {...text('casks')}
            help="Installed with brew install --cask. Comma-separated."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <TextInput
            label="apt packages"
            {...text('apt')}
            placeholder="jq, zip"
            help="On Debian and Ubuntu nodes. Comma-separated."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <TextInput
            label="dnf packages"
            {...text('dnf')}
            help="On Fedora and Red Hat nodes. Comma-separated."
            optional
            autoComplete="off"
            mono
            verbatim
          />
          <CheckboxInput
            label="Docker"
            {...flag('docker')}
            help="Docker Engine, for stages that run containers."
          />
        </FormSection>
        <FormSection legend="Software: runtimes">
          {version(
            'node',
            'Node.js version',
            '24',
            'Empty: Node.js is not managed.',
          )}
          {version('java', 'Java version', '21', 'Empty: Java is not managed.')}
          {version(
            'rust',
            'Rust version',
            'stable',
            'Empty: Rust is not managed.',
          )}
          {version(
            'python',
            'Python version',
            '3.12',
            'Empty: Python is not managed.',
          )}
          {version('go', 'Go version', '1.23', 'Empty: Go is not managed.')}
          {version(
            'ruby',
            'Ruby version',
            '3.3',
            'Empty: Ruby is not managed. Built from source once per node.',
          )}
          <TextInput
            label="Android SDK packages"
            {...text('android')}
            placeholder="platforms;android-35"
            help="sdkmanager package names, comma-separated. Their licences are accepted on a node’s page."
            optional
            autoComplete="off"
            mono
            verbatim
          />
        </FormSection>
        <FormDisclosure summary="Settings" open={adding || settingsWrong}>
          <CheckboxInput
            label="Keep awake"
            {...flag('noSleep')}
            help="The node never sleeps while Mason runs."
          />
          <CheckboxInput
            label="Developer tools security"
            {...flag('devToolsSecurity')}
            help="Lets tools debug and automate apps without a password prompt (macOS)."
          />
          <CheckboxInput
            label="Automation mode"
            {...flag('automationMode')}
            help="Lets UI tests drive the Mac without prompts (macOS)."
          />
          <TextInput
            label="Disk threshold (GB)"
            {...text('diskThresholdGb')}
            help="Unused Xcodes and runtimes are removed when free disk falls below this."
            inputMode="numeric"
            autoComplete="off"
            mono
            required
          />
        </FormDisclosure>
        <Failure actions={actions} name="save" />
        <Failure actions={actions} name="remove" />
      </form>
      <Alert
        open={removing}
        title={`Remove the node type ${name}?`}
        message={`Nodes of type ${name} keep their software; Mason stops managing it.`}
        confirm="Remove"
        tone="danger"
        busy={actions.busy === 'remove'}
        onCancel={() => setRemoving(false)}
        onConfirm={() => void remove()}
      />
    </LargeSheet>
  )
}

/** The card: a row per type, and its editor. */
export function NodeTypesCard(): JSX.Element {
  const read = useResource(settingsPath('nodeTypes'), asNodeTypeSettings)
  const [editing, setEditing] = useState<Editing | undefined>()
  const types = read.data == null ? undefined : Object.entries(read.data)
  return (
    <SettingsCard
      id="nodeTypes"
      icon="tune"
      title="Node types"
      count={types == null ? undefined : <Count count={types.length} />}
      actions={
        <Button
          variant="tinted"
          size="sm"
          icon="add"
          aria-haspopup="dialog"
          onClick={() => setEditing({})}
        >
          Add a node type
        </Button>
      }
    >
      <div className="m-card__body">
        <p className="m-t-callout m-secondary">
          The software and settings every node of a type keeps. Mason installs
          what is missing and reports what needs a person on the node’s page.
        </p>
      </div>
      <Read read={read} what="The node types">
        {(data) =>
          Object.keys(data).length === 0 ? (
            <EmptyState icon="tune" title="None yet." />
          ) : (
            <ul className="m-list m-settings__types">
              {Object.entries(data).map(([name, type]) => (
                <li
                  key={name}
                  className="m-list__row"
                  id={`node-type-${name}`}
                  data-type={name}
                >
                  <span className="m-list__main">
                    <span className="m-t-mono m-settings__typename">
                      {name}
                    </span>
                    <span className="m-list__sub">{typeSummary(type)}</span>
                    {type.androidLicensesAccepted != null && (
                      <span className="m-list__sub">
                        Android SDK licences accepted by{' '}
                        {type.androidLicensesAccepted.by} on{' '}
                        {day(type.androidLicensesAccepted.at)}.
                      </span>
                    )}
                  </span>
                  <span className="m-list__end">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="edit"
                      aria-haspopup="dialog"
                      aria-label={`Edit ${name}`}
                      onClick={() => setEditing({ name, type })}
                    >
                      Edit
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Read>
      <TypeSheet
        editing={editing}
        onClose={() => setEditing(undefined)}
        onSaved={read.reload}
      />
    </SettingsCard>
  )
}
