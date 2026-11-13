// A branch on Install apps (screen-16-install, 16c-install-results): its
// builds for the chosen platform, newest first, a run's variants grouped
// as one build, each row with what the viewer can do with it: Install
// (an iOS grant is a direct `itms-services` link, so Safari keeps the
// tap's gesture), Download, Register device, Prepare for device, or Install
// on the host. Pressing one that is not a direct link answers here: what
// the device needs first, the installer's link, or the build being
// prepared, and every refusal in the catalog's words.
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  asBranchData,
  asInstallAnswer,
  asPrepareAnswer,
  catalogBranchPath,
  installPath,
  preparePath,
  type BranchData,
  type CatalogBuild,
} from '../../../shared/api/index.js'
import { groupBuilds } from '../../../shared/catalog.js'
import { absoluteTime, bytes } from '../../../shared/format.js'
import type { ApiError } from '../../api/client.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { Button, ButtonLink, buttonClass } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import type { IconName } from '../../ui/icons.js'
import { platformLook } from '../../ui/platform.js'
import { useToast } from '../../ui/Toast.js'
import { Loading } from '../projects/project.js'
import { appIdOf } from './App.js'
import {
  asApiError,
  CatalogRefusal,
  CatalogState,
  catalogCrumbs,
  PlatformSwitch,
  usePlatform,
  withPlatform,
} from './catalog.js'

/** A master with neither its own public address nor a host's to send iOS installs to. */
export const NO_IOS_ADDRESS =
  'Installs on iPhone and iPad need a public address for this master, or a host with one.'
const HOST_INSTALLS =
  'Installs on iPhone and iPad go through the host until the master has a public address.'
const LINKS_LAST =
  'Installation links last up to one hour. Refresh this page if a link expires.'

/** What a build's row offers. */
type Action =
  /** A direct link: the installer, or the host's own page. */
  | { kind: 'link'; href: string; verb: string; long: string; icon: IconName }
  /** Install, answered here. */
  | { kind: 'install'; verb: string; long: string; icon: IconName }
  /** iOS with no address to install from. */
  | { kind: 'disabled' }

/** What a row's control is, for this build, viewer and node; `key` is the branch's in the address. */
export function actionFor(
  data: BranchData,
  build: CatalogBuild,
  key: string,
): Action {
  const ios = build.platform === 'ios' && build.download == null
  if (build.download != null)
    return {
      kind: 'install',
      verb: 'Download',
      long: 'Download',
      icon: 'download',
    }
  if (ios && data.ios?.via === 'host')
    return {
      kind: 'link',
      href: `${data.ios.host}/apps/${data.app.id}/branches/${key}?platform=ios`,
      verb: 'Install on the host',
      long: 'Install on the host',
      icon: 'open_in_new',
    }
  if (ios && data.ios?.via === 'none') return { kind: 'disabled' }
  if (build.eligible && build.installUrl != null)
    return {
      kind: 'link',
      href: build.installUrl,
      verb: 'Install',
      long: 'Install',
      icon: 'mobile_arrow_down',
    }
  if (build.eligible)
    return {
      kind: 'install',
      verb: 'Install',
      long: 'Install',
      icon: 'mobile_arrow_down',
    }
  if (!data.device)
    return {
      kind: 'install',
      verb: 'Register device',
      long: 'Register Device for',
      icon: 'mobile',
    }
  return {
    kind: 'install',
    verb: 'Prepare for device',
    long: 'Prepare for this device',
    icon: 'sync',
  }
}

/** What pressing a build's control answered. */
type Result =
  | { kind: 'register' }
  | { kind: 'prepare'; buildId: number }
  | { kind: 'itms'; build: CatalogBuild; url?: string; expiresAt?: number }
  | { kind: 'preparing' }
  | { kind: 'refused'; error: ApiError }

/** "4.18.3 (26110902)". */
function Version({
  label,
  number,
}: {
  label: string
  number: string
}): JSX.Element {
  return (
    <span className="m-t-headline">
      {label} <span className="m-t-mono m-tertiary">({number})</span>
    </span>
  )
}

/** When a build was published, and its commit. */
function Published({ build }: { build: CatalogBuild }): JSX.Element {
  const iso = new Date(build.publishedAt).toISOString()
  return (
    <>
      <time dateTime={iso} title={iso}>
        {absoluteTime(build.publishedAt, Date.now())}
      </time>
      {' · '}
      <span className="m-commit__sha" title={build.commit}>
        {build.commit.slice(0, 12)}
      </span>
    </>
  )
}

/** "84.1 MB", or "iPhone Simulator · 92.0 MB" for a build that only downloads. */
const sizeOf = (build: CatalogBuild): string =>
  build.download == null
    ? bytes(build.size)
    : `${build.download} · ${bytes(build.size)}`

/** One build's row: its version, facts and control. */
function BuildRow({
  data,
  branchKey,
  build,
  variant,
  primary,
  busy,
  onInstall,
}: {
  data: BranchData
  branchKey: string
  build: CatalogBuild
  /** The variant's name, in a run's group. */
  variant?: string
  primary: boolean
  busy: boolean
  onInstall: (build: CatalogBuild) => void
}): JSX.Element {
  const action = actionFor(data, build, branchKey)
  const heading =
    variant == null ? (
      <Version label={build.version} number={build.buildNumber} />
    ) : (
      <Version label={variant} number={build.buildNumber} />
    )
  if (action.kind === 'disabled')
    return (
      <li
        className="m-list__row m-catalog-build"
        id={`build-${build.id}`}
        aria-disabled="true"
      >
        <span className="m-list__main m-catalog-build--off">
          {heading}
          <span className="m-list__sub">{NO_IOS_ADDRESS}</span>
        </span>
        <button
          type="button"
          className={buttonClass({ variant: 'secondary' })}
          disabled
        >
          <Icon name="mobile_arrow_down" />
          Install
        </button>
      </li>
    )
  const label = `${action.long} ${build.version} build ${build.buildNumber}${variant == null ? '' : ` (${variant})`}${build.download == null ? '' : ` for the ${build.download}`}`
  const look = primary && action.verb === 'Install' ? 'primary' : 'secondary'
  return (
    <li className="m-list__row m-catalog-build" id={`build-${build.id}`}>
      <span className="m-list__main">
        {heading}
        <span className="m-list__sub">
          {variant == null ? (
            <>
              <Published build={build} /> · {sizeOf(build)}
            </>
          ) : (
            sizeOf(build)
          )}
        </span>
      </span>
      {action.kind === 'link' ? (
        // A plain link, never a script's navigation: the tap itself opens
        // the installer, so Safari keeps its gesture.
        <a
          className={buttonClass({ variant: look })}
          href={action.href}
          aria-label={label}
        >
          <Icon name={action.icon} />
          {action.verb}
        </a>
      ) : (
        <Button
          variant={look}
          icon={action.icon}
          aria-label={label}
          busy={busy}
          onClick={() => onInstall(build)}
        >
          {action.verb}
        </Button>
      )}
    </li>
  )
}

/** Consecutive single builds share a card; a run's variants have their own. */
function Groups({
  data,
  branchKey,
  busy,
  onInstall,
}: {
  data: BranchData
  branchKey: string
  busy: number | undefined
  onInstall: (build: CatalogBuild) => void
}): JSX.Element {
  const groups = groupBuilds(data.builds)
  const first = data.builds[0]?.id
  const parts: ReactNode[] = []
  let singles: CatalogBuild[] = []
  const row = (build: CatalogBuild, variant?: string): JSX.Element => (
    <BuildRow
      key={build.id}
      data={data}
      branchKey={branchKey}
      build={build}
      {...(variant == null ? {} : { variant })}
      primary={build.id === first}
      busy={busy === build.id}
      onInstall={onInstall}
    />
  )
  const flush = (): void => {
    if (singles.length === 0) return
    parts.push(
      <section
        key={`builds-${singles[0]!.id}`}
        className="m-card"
        aria-label="Builds"
      >
        <ul className="m-list">{singles.map((build) => row(build))}</ul>
      </section>,
    )
    singles = []
  }
  for (const group of groups) {
    const head = group[0]!
    if (group.length === 1 && head.variant === '') {
      singles.push(head)
      continue
    }
    flush()
    const titleId = `run-${head.run ?? head.id}-title`
    parts.push(
      <section
        key={`run-${head.run ?? head.id}`}
        className="m-card"
        id={`run-${head.run ?? head.id}`}
        aria-labelledby={titleId}
      >
        <header className="m-card__header">
          <div className="m-list__main">
            <h2 className="m-t-title3" id={titleId}>
              {head.version}{' '}
              <span className="m-t-mono m-tertiary">({head.buildNumber})</span>
            </h2>
            <span className="m-list__sub">
              <Published build={head} /> · {group.length} variants
            </span>
          </div>
        </header>
        <ul className="m-list">
          {group.map((build) =>
            row(build, build.variant === '' ? 'Default' : build.variant),
          )}
        </ul>
      </section>,
    )
  }
  flush()
  return <>{parts}</>
}

/** What pressing a control answered, focused so it is read out. */
function ResultCard({
  result,
  appName,
  busy,
  onPrepare,
  onDismiss,
}: {
  result: Result
  appName: string
  busy: boolean
  onPrepare: (buildId: number) => void
  onDismiss: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('#install-result-title')?.focus()
  }, [result])
  const back = (
    <Button variant="plain" onClick={onDismiss}>
      Back to builds
    </Button>
  )
  const card = (
    icon: IconName,
    title: string,
    text: ReactNode,
    actions: ReactNode,
  ): JSX.Element => (
    <section className="m-card">
      <EmptyState
        icon={icon}
        title={title}
        titleAs="h2"
        titleId="install-result-title"
        actions={actions}
      >
        {text}
      </EmptyState>
    </section>
  )
  let content: JSX.Element
  if (result.kind === 'refused')
    content = <CatalogRefusal error={result.error} />
  else if (result.kind === 'register')
    content = card(
      'mobile',
      'Prepare your device',
      'Register or select your iPhone or iPad before installing this build.',
      <>
        <ButtonLink variant="primary" icon="mobile" to="/devices">
          Register device
        </ButtonLink>
        {back}
      </>,
    )
  else if (result.kind === 'prepare')
    content = card(
      'sync',
      'Prepare your device',
      'This build does not yet include your device. Mason can prepare a new build of this branch and commit.',
      <>
        <Button
          variant="primary"
          busy={busy}
          onClick={() => onPrepare(result.buildId)}
        >
          Prepare for this device
        </Button>
        {back}
      </>,
    )
  else if (result.kind === 'itms') {
    const until =
      result.expiresAt == null
        ? 'within one hour'
        : `at ${absoluteTime(result.expiresAt, Date.now()).replace(/^Today /, '')}`
    content =
      result.url == null
        ? card('mobile_arrow_down', 'Install app', NO_IOS_ADDRESS, back)
        : card(
            'mobile_arrow_down',
            'Install app',
            <>
              Tap Install on iOS, then confirm the installation on your device.
              This installation link expires {until}.
            </>,
            <>
              <a
                className={buttonClass({ variant: 'primary', size: 'lg' })}
                href={result.url}
                aria-label={`Install ${appName} ${result.build.version} on iOS`}
              >
                <Icon name="mobile_arrow_down" />
                Install on iOS
              </a>
              {back}
            </>,
          )
  } else
    content = card(
      'hourglass_top',
      'Preparing build',
      'Mason will prepare this branch and commit for your device. This can take several minutes; the new build will appear in the app’s build list.',
      <ButtonLink variant="secondary" to="/apps">
        Browse apps
      </ButtonLink>,
    )
  return (
    <div ref={ref} className="m-catalog-result">
      {content}
    </div>
  )
}

/** `/apps/:appId/branches/:branchKey`. */
export function BranchPage(): JSX.Element {
  const params = useParams()
  const client = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const { platform, to } = usePlatform()
  const id = appIdOf(params.appId)
  const key = params.branchKey ?? ''
  const read = useResource(
    id == null || key === ''
      ? null
      : withPlatform(catalogBranchPath(id, key), platform),
    asBranchData,
  )
  const [result, setResult] = useState<Result>()
  const [busy, setBusy] = useState<number>()
  const [preparing, setPreparing] = useState(false)
  const data = read.data
  const look = platformLook(platform)
  const unavailable = id == null || key === '' || read.error?.status === 404
  const appName = data?.app.name ?? 'App'
  const branch = data?.branch ?? (unavailable ? 'App unavailable' : 'Branch')
  const crumbs = catalogCrumbs(
    platform,
    { label: appName, to: withPlatform(`/apps/${id}`, platform) },
    { label: branch },
  )
  // Another platform's builds are another list: what was answered goes.
  useEffect(() => setResult(undefined), [platform])

  const install = async (build: CatalogBuild): Promise<void> => {
    setBusy(build.id)
    try {
      const answer = await client.post(installPath(build.id), asInstallAnswer)
      if (answer.kind === 'download' && answer.url != null) {
        toast({ text: `Downloading ${build.version}`, icon: 'download' })
        client.leave(answer.url)
      } else if (answer.kind === 'itms')
        setResult({
          kind: 'itms',
          build,
          ...(answer.url == null ? {} : { url: answer.url }),
          ...(answer.expiresAt == null ? {} : { expiresAt: answer.expiresAt }),
        })
      else if (answer.kind === 'prepare')
        setResult({ kind: 'prepare', buildId: answer.buildId ?? build.id })
      else setResult({ kind: 'register' })
    } catch (error) {
      setResult({ kind: 'refused', error: asApiError(error) })
    } finally {
      setBusy(undefined)
    }
  }
  const prepare = async (buildId: number): Promise<void> => {
    setPreparing(true)
    try {
      const answer = await client.post(preparePath(buildId), asPrepareAnswer)
      // Without a device of the viewer's selected there is nothing to prepare for.
      if (answer.prepared) setResult({ kind: 'preparing' })
      else void navigate('/devices')
    } catch (error) {
      setResult({ kind: 'refused', error: asApiError(error) })
    } finally {
      setPreparing(false)
    }
  }

  const ios = platform === 'ios' && (data?.builds.length ?? 0) > 0
  const note =
    !ios || data?.ios == null || data.ios.via === 'none'
      ? undefined
      : data.ios.via === 'host'
        ? HOST_INSTALLS
        : LINKS_LAST
  return (
    <Page
      crumbs={crumbs}
      title={branch}
      heading={
        data == null ? undefined : (
          <span className="m-catalog-branch">{branch}</span>
        )
      }
      description={
        data == null ? undefined : (
          <>
            {`${look.name} builds · newest first`}
            {note != null && (
              <>
                <br />
                {note}
              </>
            )}
          </>
        )
      }
    >
      {data != null && (
        <PlatformSwitch platforms={data.platforms} chosen={platform} to={to} />
      )}
      {result != null && (
        <ResultCard
          result={result}
          appName={appName}
          busy={preparing}
          onPrepare={(buildId) => void prepare(buildId)}
          onDismiss={() => setResult(undefined)}
        />
      )}
      {id == null || key === '' ? (
        <CatalogState icon="search" title="This app is unavailable">
          It may have been removed, or your groups no longer include it.
        </CatalogState>
      ) : data != null ? (
        data.builds.length === 0 ? (
          <CatalogState icon="inventory_2" title={`No ${look.name} builds`}>
            This branch has no retained builds for the selected platform. Choose
            another platform or publish a new build.
          </CatalogState>
        ) : (
          <Groups
            data={data}
            branchKey={key}
            busy={busy}
            onInstall={(build) => void install(build)}
          />
        )
      ) : read.error != null ? (
        <CatalogRefusal error={read.error} retry={read.reload} />
      ) : (
        <Loading label="Loading the branch’s builds" />
      )}
    </Page>
  )
}
