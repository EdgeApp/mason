// Build numbers (screen-02b-app-id): the sequences a project's Masonfile
// declares, where each stands, and *Set where it stands*, a form sheet for
// managers on the master. On a project's overview the sheet starts with a
// sequence to choose; on an app ID page that sequence is fixed. An app ID's
// Build numbers tab shows its sequence's facts, the app IDs sharing it, or
// the default scheme it takes when no sequence names it.
import { useRef, useState, type FormEvent, type JSX } from 'react'
import { useParams } from 'react-router'
import { asUnknown } from 'cleaners'
import {
  asProjectApp,
  projectAppPath,
  SEED_PATH,
  type BuildNumberSequence,
  type SeedRequest,
} from '../../../shared/api/index.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { Button } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { Sheet } from '../../ui/Sheet.js'
import { useToast } from '../../ui/Toast.js'
import {
  AppHeading,
  AppTabs,
  appCrumbs,
  Failed,
  Loading,
  PROJECTS,
  projectCrumb,
  Unknown,
} from './project.js'

/** A sequence's scope in words. */
export const scopeWords = (scope: string): string =>
  scope === 'branch' ? 'Per branch' : 'Across branches'

/** Where a sequence stands: one line per branch, or "None yet". */
export function LastIssued({
  sequence,
}: {
  sequence: BuildNumberSequence
}): JSX.Element {
  if (sequence.last.length === 0)
    return <span className="m-tertiary">None yet</span>
  return (
    <ul className="m-list m-buildnumbers__last">
      {sequence.last.map((entry) => (
        <li key={entry.branch} className="m-row">
          {entry.branch !== '' && (
            <span className="m-t-mono-sm m-secondary">{entry.branch}</span>
          )}
          <span className="m-t-mono">{entry.value}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * *Set where it stands*: the sequence (a choice on the overview, fixed on an
 * app ID), its branch when it numbers per branch, and the last number issued.
 * The next build of that sequence gets the number after it; nothing is lowered.
 */
export function SeedSheet({
  project,
  sequences,
  open,
  onClose,
  onSet,
}: {
  project: string
  /** One sequence: fixed; more: chosen. */
  sequences: BuildNumberSequence[]
  open: boolean
  onClose: () => void
  onSet: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const first = sequences[0]?.key ?? ''
  const [key, setKey] = useState(first)
  const [branch, setBranch] = useState('')
  const [last, setLast] = useState('')
  const [errors, setErrors] = useState<{ branch?: string; last?: string }>({})
  const [failed, setFailed] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const error = useRef<HTMLParagraphElement>(null)
  const sequence = sequences.find((entry) => entry.key === key) ?? sequences[0]
  const perBranch = sequence?.scope === 'branch'
  const dirty = key !== first || branch !== '' || last !== ''
  const close = (): void => {
    setKey(first)
    setBranch('')
    setLast('')
    setErrors({})
    setFailed(undefined)
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (sequence == null) return
    const wrong = {
      ...(perBranch && branch.trim() === ''
        ? { branch: 'Enter the branch this sequence numbers.' }
        : {}),
      ...(last.trim() === '' ? { last: 'Enter the last number issued.' } : {}),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    setBusy(true)
    setFailed(undefined)
    const body: SeedRequest = {
      project,
      key: sequence.key,
      ...(perBranch ? { branch: branch.trim() } : {}),
      last: last.trim(),
    }
    try {
      await client.post(SEED_PATH, asUnknown, { body })
      toast({
        text: `${sequence.key} stands at ${body.last}`,
        icon: 'check_circle',
      })
      close()
      onSet()
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => error.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  const formId = `seed-${project}`
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={dirty}
      title={
        <>
          Set where{' '}
          <span className="m-t-mono">
            {sequences.length === 1 ? sequence?.key : 'a sequence'}
          </span>{' '}
          stands
        </>
      }
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={busy}>
            Set
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="seed"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        {sequences.length > 1 && (
          <div className="m-field">
            <label className="m-field__label" htmlFor={`${formId}-key`}>
              Sequence
            </label>
            <select
              id={`${formId}-key`}
              name="key"
              className="m-select m-input--mono"
              value={key}
              onChange={(event) => {
                setKey(event.target.value)
                setErrors({})
              }}
            >
              {sequences.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.key}
                </option>
              ))}
            </select>
          </div>
        )}
        {perBranch && (
          <TextInput
            label="Branch"
            name="branch"
            value={branch}
            onChange={setBranch}
            error={errors.branch}
            help="This sequence numbers each branch on its own."
            mono
            verbatim
            required
          />
        )}
        <TextInput
          label="Last number issued"
          name="last"
          value={last}
          onChange={setLast}
          error={errors.last}
          placeholder={sequence?.format}
          help={`In the sequence's format, ${sequence?.format ?? 'N'}.`}
          inputMode="numeric"
          mono
          verbatim
          required
        />
        <div className="m-callout">
          <Icon name="info" />
          <span>
            The next build of that sequence gets the number after it. Nothing is
            lowered.
          </span>
        </div>
        {failed != null && <FormError ref={error}>{failed}</FormError>}
      </form>
    </Sheet>
  )
}

/** An app ID's Build numbers tab, on both nodes; only the master's managers may set one. */
export function AppBuildNumbersPage(): JSX.Element {
  const { slug = '', appId = '' } = useParams()
  const read = useResource(projectAppPath(slug, appId), asProjectApp)
  const [seeding, setSeeding] = useState(false)
  const data = read.data
  if (data == null && read.error?.status === 404)
    return (
      <Unknown
        crumbs={[
          PROJECTS,
          projectCrumb(slug, slug),
          { label: 'App ID unavailable' },
        ]}
        title="App ID unavailable"
        text="There is no such app ID in this project."
      />
    )
  const crumbs = appCrumbs(slug, data?.name ?? slug, appId, 'build-numbers')
  const sequence = data?.sequence
  return (
    <Page
      crumbs={crumbs}
      title={`${appId} · Build numbers`}
      heading={
        <span className="m-t-mono m-wrap-any m-title-mono">{appId}</span>
      }
      description={
        data == null ? undefined : (
          <AppHeading name={data.app.name} platforms={data.app.platforms} />
        )
      }
    >
      <AppTabs slug={slug} appId={appId} current="build-numbers" />
      {data == null ? (
        read.error != null ? (
          <Failed
            what="The app ID"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <Loading label="Loading the build numbers" />
        )
      ) : sequence == null ? (
        <section className="m-card m-card--narrow" aria-label="Build numbers">
          <div className="m-card__body m-row m-buildnumbers__default">
            <Icon name="info" />
            <p className="m-t-callout m-flush">
              No sequence in the Masonfile names{' '}
              <span className="m-t-mono-sm">{appId}</span>, so it takes the
              default scheme:{' '}
              <span className="m-t-mono-sm">{data.defaultScheme.format}</span>,{' '}
              {scopeWords(data.defaultScheme.scope).toLowerCase()}.
            </p>
          </div>
        </section>
      ) : (
        <section
          className="m-card m-card--narrow"
          aria-labelledby="build-numbers-title"
        >
          <header className="m-card__header">
            <div className="m-card__title">
              <Icon name="label" />
              <h2 className="m-t-title3" id="build-numbers-title">
                Build numbers
              </h2>
            </div>
            {data.canSeed && (
              <Button
                variant="secondary"
                size="sm"
                icon="edit"
                aria-haspopup="dialog"
                onClick={() => setSeeding(true)}
              >
                Set where it stands
              </Button>
            )}
          </header>
          <div className="m-card__body m-stack">
            <dl className="m-kv">
              <dt>Sequence</dt>
              <dd className="m-t-mono">{sequence.key}</dd>
              <dt>Format</dt>
              <dd className="m-t-mono">{sequence.format}</dd>
              <dt>Scope</dt>
              <dd>{scopeWords(sequence.scope)}</dd>
              <dt>Last issued</dt>
              <dd>
                <LastIssued sequence={sequence} />
              </dd>
            </dl>
            {data.shared.length > 0 && (
              <p className="m-t-callout m-secondary m-row" data-shared="">
                Shared with
                {data.shared.map((app) => (
                  <Chip key={app} kind="mono">
                    {app}
                  </Chip>
                ))}
              </p>
            )}
          </div>
          {data.canSeed && (
            <SeedSheet
              project={slug}
              sequences={[sequence]}
              open={seeding}
              onClose={() => setSeeding(false)}
              onSet={read.reload}
            />
          )}
        </section>
      )}
    </Page>
  )
}
