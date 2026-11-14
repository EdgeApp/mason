// Add a project (screen-08-wizard), for those who may change projects, on
// the master: 1. the repository, checked with the master's GitHub
// credentials, which creates the project; 2. its Masonfile read on a worker
// (not read, reading, failed, and the app IDs it declares with the Apple
// team); 3. branch rules, the GitHub webhook and the Masonfile's triggers,
// read only. The address keeps the project (`?slug=`) and the step.
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { asUnknown } from 'cleaners'
import {
  asDiscovery,
  asProjectRecordView,
  asRepositoryCheck,
  asWebhookCreated,
  discoverPath,
  PROJECT_CHECK_PATH,
  projectPath,
  webhookPath,
  wizardPath,
  type Discovery,
  type ProjectRecordView,
} from '../../../shared/api/index.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { Banner } from '../../ui/Banner.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import type { IconName } from '../../ui/icons.js'
import { PlatformChip } from '../../ui/RunChip.js'
import { Spinner } from '../../ui/Spinner.js'
import { useToast } from '../../ui/Toast.js'
import { Failed, Loading, PROJECTS } from './project.js'

/** How often a reading Masonfile is asked about. */
export const DISCOVERY_POLL_MS = 2_000

const STEPS = ['Repository', 'Apps', 'Branches and triggers']

const wizardHref = (slug?: string, step?: number): string => {
  if (slug == null) return '/projects/new'
  const query = new URLSearchParams({ slug })
  if (step != null) query.set('step', String(step))
  return `/projects/new?${query.toString()}`
}

/** The step indicator: done, current, to come. */
function Steps({ step }: { step: number }): JSX.Element {
  return (
    <div className="m-stack m-stack--tight">
      <p className="m-t-eyebrow">
        Step {step} of {STEPS.length}
      </p>
      <ol className="m-steps" aria-label="Steps">
        {STEPS.map((name, index) => (
          <li
            key={name}
            className={index + 1 < step ? 'done' : undefined}
            aria-current={index + 1 === step ? 'step' : undefined}
          >
            {name}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** One step's card. */
function StepCard({
  title,
  icon,
  footer,
  children,
}: {
  title: string
  icon: IconName
  footer?: JSX.Element
  children: ReactNode
}): JSX.Element {
  return (
    <section className="m-card m-card--narrow" aria-labelledby="wizard-step">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name={icon} />
          <h2 className="m-t-title3" id="wizard-step">
            {title}
          </h2>
        </div>
      </header>
      <div className="m-card__body m-stack">{children}</div>
      {footer != null && <footer className="m-card__footer">{footer}</footer>}
    </section>
  )
}

/** Step 1: the repository; the master checks it, then the project is made. */
function RepositoryStep(): JSX.Element {
  const client = useApi()
  const navigate = useNavigate()
  const [repository, setRepository] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const failure = useRef<HTMLParagraphElement>(null)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (repository.trim() === '') {
      setError('Enter the repository.')
      return
    }
    setError(undefined)
    setFailed(undefined)
    setBusy(true)
    try {
      const checked = await client.post(PROJECT_CHECK_PATH, asRepositoryCheck, {
        body: { repository: repository.trim() },
      })
      await client.put(projectPath(checked.slug), asUnknown, {
        body: {
          name: checked.slug,
          repository: checked.repository,
          defaultBranch: checked.defaultBranch,
          format: 'pipeline',
        },
      })
      navigate(wizardHref(checked.slug))
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => failure.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      name="wizard-repository"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <StepCard
        title="Repository"
        icon="link"
        footer={
          <>
            <span />
            <Button variant="primary" icon="search" type="submit" busy={busy}>
              Check with the master’s GitHub credentials
            </Button>
          </>
        }
      >
        <TextInput
          label="GitHub repository"
          name="repository"
          value={repository}
          onChange={setRepository}
          error={error}
          placeholder="git@github.com:owner/repo.git"
          help="SSH or HTTPS. Mason checks it with the master’s GitHub credentials."
          inputMode="url"
          autoComplete="off"
          mono
          verbatim
          required
        />
        {failed != null && <FormError ref={failure}>{failed}</FormError>}
      </StepCard>
    </form>
  )
}

/** Step 2's app IDs: the Masonfile's, those the project owns checked, and the Apple team. */
function AppsChoice({
  project,
  discovery,
}: {
  project: ProjectRecordView
  discovery: Discovery
}): JSX.Element {
  const client = useApi()
  const navigate = useNavigate()
  const declared = discovery.apps ?? []
  const [chosen, setChosen] = useState<string[]>(() => {
    const owned = project.apps.map((app) => app.bundleId)
    return declared
      .map((app) => app.bundleId)
      .filter((id) => owned.includes(id))
  })
  const [team, setTeam] = useState('')
  const [teamError, setTeamError] = useState<string | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const failure = useRef<HTMLParagraphElement>(null)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const wrong =
      team.trim() !== '' && !/^[A-Z0-9]{10}$/.test(team.trim())
        ? 'Ten capital letters and digits.'
        : undefined
    setTeamError(wrong)
    if (wrong != null) return
    setBusy(true)
    setFailed(undefined)
    try {
      await client.post(wizardPath(project.slug, 'apps'), asUnknown, {
        body: { apps: chosen.join(','), team: team.trim() },
      })
      navigate(wizardHref(project.slug, 3))
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => failure.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      name="wizard-apps"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <StepCard
        title="Apps"
        icon="apps"
        footer={
          <>
            <ButtonLink variant="plain" icon="chevron_left" to={wizardHref()}>
              Repository
            </ButtonLink>
            <Button variant="primary" icon="check" type="submit" busy={busy}>
              These app IDs are this project’s
            </Button>
          </>
        }
      >
        <p className="m-t-callout m-secondary m-flush">
          {declared.length === 0
            ? 'It declares none.'
            : 'The Masonfile declares these app IDs. Choose the ones this project owns.'}
        </p>
        {declared.length > 0 ? (
          <fieldset className="m-fieldset m-wizard__apps">
            <legend className="m-sr">App IDs</legend>
            {declared.map((app) => (
              <label key={app.bundleId} className="m-check m-wizard__app">
                <input
                  type="checkbox"
                  name="app"
                  value={app.bundleId}
                  checked={chosen.includes(app.bundleId)}
                  onChange={(event) =>
                    setChosen((was) =>
                      event.target.checked
                        ? [...was, app.bundleId]
                        : was.filter((id) => id !== app.bundleId),
                    )
                  }
                />
                <span className="m-list__main">
                  <span className="m-t-mono m-wrap-any m-wizard__id">
                    {app.bundleId}
                  </span>
                  <span className="m-row">
                    {app.platforms.map((platform) => (
                      <PlatformChip key={platform} platform={platform} />
                    ))}
                    {app.bundleIds != null && (
                      <span className="m-t-subhead m-secondary">
                        signs {app.bundleIds.join(', ')}
                      </span>
                    )}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="m-wizard__team">
          <TextInput
            label="Apple team ID"
            name="team"
            value={team}
            onChange={setTeam}
            error={teamError}
            help="For iOS and macOS app IDs: ten capital letters and digits."
            pattern="[A-Z0-9]{10}"
            maxLength={10}
            autoComplete="off"
            optional
            mono
            verbatim
          />
        </div>
        {failed != null && <FormError ref={failure}>{failed}</FormError>}
      </StepCard>
    </form>
  )
}

/** Step 2: the Masonfile read on a worker, by its state. */
function AppsStep({ project }: { project: ProjectRecordView }): JSX.Element {
  const client = useApi()
  const read = useResource(discoverPath(project.slug), asDiscovery)
  const [failed, setFailed] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const discovery = read.data
  const reading =
    discovery != null &&
    (discovery.status === 'queued' || discovery.status === 'running')
  const { reload } = read
  useEffect(() => {
    if (!reading) return undefined
    const timer = setTimeout(reload, DISCOVERY_POLL_MS)
    return (): void => clearTimeout(timer)
  }, [reading, reload, discovery])
  const start = async (): Promise<void> => {
    setBusy(true)
    setFailed(undefined)
    try {
      await client.post(discoverPath(project.slug), asUnknown)
      reload()
    } catch (reason) {
      setFailed((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (read.data === undefined)
    return read.error != null ? (
      <Failed
        what="The Masonfile’s state"
        message={read.error.message}
        retry={read.reload}
      />
    ) : (
      <Loading label="Loading the Masonfile’s state" />
    )
  if (discovery == null)
    return (
      <StepCard title="Apps" icon="apps">
        <p className="m-t-callout m-secondary m-flush">
          Mason reads the Masonfile on a worker to learn which app IDs it
          declares.
        </p>
        <div>
          <Button
            variant="primary"
            icon="play_arrow"
            busy={busy}
            onClick={() => void start()}
          >
            Read the Masonfile on {project.defaultBranch}
          </Button>
        </div>
        {failed != null && <FormError>{failed}</FormError>}
      </StepCard>
    )
  if (reading)
    return (
      <StepCard title="Apps" icon="apps">
        <div className="m-row m-wizard__reading">
          <Spinner />
          <span className="m-list__main">
            <span className="m-t-headline" role="status">
              Reading the Masonfile on a worker…
            </span>
            <span className="m-t-subhead m-secondary">
              This page updates when the worker answers.
            </span>
          </span>
        </div>
      </StepCard>
    )
  if (discovery.status !== 'succeeded')
    return (
      <StepCard title="Apps" icon="apps">
        <Banner
          tone="danger"
          title={`Reading the Masonfile ${discovery.status === 'cancelled' ? 'was cancelled' : 'failed'}`}
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              busy={busy}
              onClick={() => void start()}
            >
              Try again
            </Button>
          }
        >
          {discovery.reason ?? ''}
        </Banner>
        {failed != null && <FormError>{failed}</FormError>}
      </StepCard>
    )
  return <AppsChoice project={project} discovery={discovery} />
}

/** Step 3: branch rules, the webhook and the Masonfile's triggers. */
function BranchesStep({
  project,
  reload,
}: {
  project: ProjectRecordView
  reload: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const discovery = useResource(discoverPath(project.slug), asDiscovery)
  const [rules, setRules] = useState(() =>
    (project.rules.length === 0
      ? [
          { pattern: project.defaultBranch, mode: 'automatic' },
          { pattern: '*', mode: 'request' },
        ]
      : project.rules
    )
      .map((rule) => `${rule.pattern} ${rule.mode}`)
      .join('\n'),
  )
  const [busy, setBusy] = useState<'rules' | 'webhook' | undefined>()
  const [failed, setFailed] = useState<{ rules?: string; webhook?: string }>({})
  const saveRules = async (): Promise<void> => {
    setBusy('rules')
    setFailed({})
    try {
      await client.post(wizardPath(project.slug, 'rules'), asUnknown, {
        body: { rules },
      })
      toast({ text: 'Branch rules saved', icon: 'check_circle' })
      reload()
    } catch (reason) {
      setFailed({ rules: (reason as Error).message })
    } finally {
      setBusy(undefined)
    }
  }
  const webhook = async (): Promise<void> => {
    setBusy('webhook')
    setFailed({})
    try {
      const made = await client.post(
        webhookPath(project.slug),
        asWebhookCreated,
      )
      toast({ text: `GitHub posts pushes to ${made.url}`, icon: 'link' })
      reload()
    } catch (reason) {
      setFailed({ webhook: (reason as Error).message })
    } finally {
      setBusy(undefined)
    }
  }
  const triggers = Object.entries(discovery.data?.triggers ?? {})
  return (
    <StepCard
      title="Branches and triggers"
      icon="fork_right"
      footer={
        <>
          <ButtonLink
            variant="plain"
            icon="chevron_left"
            to={wizardHref(project.slug, 2)}
          >
            Apps
          </ButtonLink>
          <ButtonLink
            variant="primary"
            icon="check"
            to={`/projects?project=${encodeURIComponent(project.slug)}`}
          >
            Done
          </ButtonLink>
        </>
      }
    >
      <div className="m-field">
        <label className="m-field__label" htmlFor="wizard-rules">
          Branch rules
        </label>
        <textarea
          id="wizard-rules"
          name="rules"
          className="m-textarea m-textarea--mono"
          rows={5}
          value={rules}
          spellCheck={false}
          aria-describedby="wizard-rules-help"
          onChange={(event) => setRules(event.target.value)}
        />
        <p className="m-field__help" id="wizard-rules-help">
          One rule per line: a branch pattern, then{' '}
          <code className="m-t-mono-sm">automatic</code> (build on push) or{' '}
          <code className="m-t-mono-sm">request</code>. The first match wins.
        </p>
      </div>
      <div className="m-row">
        <Button
          variant="secondary"
          busy={busy === 'rules'}
          onClick={() => void saveRules()}
        >
          Save rules
        </Button>
      </div>
      {failed.rules != null && <FormError>{failed.rules}</FormError>}
      <hr className="m-divider" />
      <div className="m-row m-row--between">
        <span className="m-list__main">
          <span className="m-t-headline">Webhook</span>
          <span className="m-t-subhead m-secondary">
            {project.webhookSecret.set
              ? 'The project has a webhook secret.'
              : 'No webhook yet. Pushes are not seen until it exists.'}
          </span>
        </span>
        <Button
          variant="secondary"
          icon="link"
          busy={busy === 'webhook'}
          onClick={() => void webhook()}
        >
          Create the GitHub webhook
        </Button>
      </div>
      {failed.webhook != null && <FormError>{failed.webhook}</FormError>}
      <hr className="m-divider" />
      <span className="m-t-headline">
        Triggers{' '}
        <span className="m-t-subhead m-tertiary">
          from the Masonfile, read only
        </span>
      </span>
      {triggers.length === 0 ? (
        <p className="m-t-callout m-secondary m-flush">
          Read the Masonfile first.
        </p>
      ) : (
        <pre className="m-code m-flush" aria-label="Triggers">
          {triggers.map(([workflow, list]) => (
            <span key={workflow}>
              {workflow} {JSON.stringify(list)}
            </span>
          ))}
        </pre>
      )}
    </StepCard>
  )
}

/** Steps 2 and 3, once the project exists, under its repository. */
function ProjectSteps({
  slug,
  step,
}: {
  slug: string
  step: number | undefined
}): JSX.Element {
  const read = useResource(projectPath(slug), asProjectRecordView)
  const project = read.data
  const current = step ?? (project == null || project.apps.length === 0 ? 2 : 3)
  return (
    <Page
      crumbs={[PROJECTS, { label: 'Add a project' }]}
      title="Add a project"
      description={
        project == null ? undefined : (
          <span className="m-t-mono m-wrap-any">{project.repository}</span>
        )
      }
    >
      <Steps step={current} />
      {project == null ? (
        read.error != null ? (
          <Failed
            what="The project"
            message={read.error.message}
            retry={read.reload}
          />
        ) : (
          <Loading label="Loading the project" />
        )
      ) : current === 2 ? (
        <AppsStep project={project} />
      ) : (
        <BranchesStep project={project} reload={read.reload} />
      )}
    </Page>
  )
}

/** `/projects/new`, the master's managers and administrators. */
export function WizardPage(): JSX.Element {
  const [params] = useSearchParams()
  const slug = params.get('slug') ?? undefined
  const asked = Number(params.get('step'))
  const step = asked === 2 || asked === 3 ? asked : undefined
  if (slug != null) return <ProjectSteps key={slug} slug={slug} step={step} />
  return (
    <Page
      crumbs={[PROJECTS, { label: 'Add a project' }]}
      title="Add a project"
      description="A GitHub repository with a Masonfile."
    >
      <Steps step={1} />
      <RepositoryStep />
    </Page>
  )
}
