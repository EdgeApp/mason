// What Install apps' pages share (screen-16-install, 16b, 16c): the platform
// a visit is for and the sticky switch that changes it (remembered in the
// `mason-platform` cookie the server reads too), the trail, and the words
// for every way the catalog can refuse or be unreachable.
import { useEffect, useMemo, type JSX, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  HOST_UNREACHABLE_ERROR,
  NO_HOST_ERROR,
  platformNames,
  TESTER_ACCESS_ERROR,
  type PlatformName,
} from '../../../shared/api/index.js'
import {
  choosePlatform,
  isPlatform,
  PLATFORM_COOKIE,
} from '../../../shared/catalog.js'
import { ApiError } from '../../api/client.js'
import type { Crumb } from '../../layout/Breadcrumbs.js'
import { useShell } from '../../layout/ShellContext.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import type { IconName } from '../../ui/icons.js'
import { platformLook } from '../../ui/platform.js'
import type { Tone } from '../../ui/status.js'

/** Install apps, the first crumb of every catalog page. */
export const INSTALL_APPS = 'Install apps'

/** An address with the platform it is for. */
export const withPlatform = (path: string, platform: PlatformName): string =>
  `${path}?platform=${platform}`

/** Install apps › …, each crumb keeping the platform. */
export function catalogCrumbs(
  platform: PlatformName,
  ...rest: Crumb[]
): Crumb[] {
  return [{ label: INSTALL_APPS, to: withPlatform('/apps', platform) }, ...rest]
}

/** The `mason-platform` cookie's value, if it names a platform. */
export function platformPreference(
  doc: Document = document,
): string | undefined {
  const value = doc.cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PLATFORM_COOKIE}=`))
  return value.length === 1
    ? value[0]!.slice(PLATFORM_COOKIE.length + 1)
    : undefined
}

/** Remembers a platform for every later visit, as the server reads it. */
export function rememberPlatform(
  platform: PlatformName,
  doc: Document = document,
): void {
  const secure = doc.location?.protocol === 'https:' ? '; Secure' : ''
  doc.cookie = `${PLATFORM_COOKIE}=${platform}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

/** An iPad that tells sites it is a Mac: touch gives it away. */
const ipadAsMac = (): boolean =>
  /Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1

/**
 * The platform this visit is for: the address's `?platform=`, else the
 * remembered one, else the browser's (an iPad posing as a Mac is iOS). An
 * address without one is rewritten in place to name it, so history and
 * shared links say which platform they show.
 */
export function usePlatform(): {
  platform: PlatformName
  /** The address for another platform; following it remembers the choice. */
  to: (platform: PlatformName) => string
} {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const query = params.get('platform')
  const platform = useMemo(() => {
    const preference = platformPreference()
    if (!isPlatform(query) && !isPlatform(preference) && ipadAsMac())
      return 'ios'
    return choosePlatform(query, preference, navigator.userAgent)
  }, [query])
  useEffect(() => {
    if (query === platform) return
    const next = new URLSearchParams(params)
    next.set('platform', platform)
    void navigate({ search: `?${next.toString()}` }, { replace: true })
  }, [query, platform, params, navigate])
  return {
    platform,
    to: (other): string => {
      const next = new URLSearchParams(params)
      next.set('platform', other)
      return `?${next.toString()}`
    },
  }
}

/**
 * The sticky platform switch: only the platforms the page's apps have a
 * channel for. Following one remembers it; the page keeps its scroll.
 */
export function PlatformSwitch({
  platforms,
  chosen,
  to,
}: {
  platforms: readonly PlatformName[]
  chosen: PlatformName
  to: (platform: PlatformName) => string
}): JSX.Element | null {
  if (platforms.length === 0) return null
  return (
    <nav className="m-catalog-platforms" aria-label="Build platform">
      <div className="m-seg">
        {platformNames
          .filter((platform) => platforms.includes(platform))
          .map((platform) => {
            const look = platformLook(platform)
            return (
              <Link
                key={platform}
                className="m-seg__opt"
                to={to(platform)}
                aria-current={platform === chosen ? 'true' : undefined}
                preventScrollReset
                onClick={() => rememberPlatform(platform)}
              >
                <Icon name={look.icon} />
                <span>{look.name}</span>
              </Link>
            )
          })}
      </div>
    </nav>
  )
}

/** A catalog state in a card: a glyph, a title, a sentence and what to do. */
export function CatalogState({
  icon,
  tone,
  title,
  children,
  actions,
  live,
}: {
  icon: IconName
  tone?: Tone
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  /** Announced as it changes. */
  live?: boolean
}): JSX.Element {
  return (
    <section
      className="m-card"
      aria-live={live === true ? 'polite' : undefined}
    >
      <EmptyState
        icon={icon}
        {...(tone == null ? {} : { tone })}
        title={title}
        actions={actions}
      >
        {children}
      </EmptyState>
    </section>
  )
}

/** What a refusal or a failure reads as. */
interface Refusal {
  icon: IconName
  tone?: Tone
  title: string
  text: string
  /** Try the read again. */
  retry?: boolean
  /** Where to go instead. */
  go?: 'apps' | 'devices' | 'register' | 'nodes'
}

/** The catalog's words for an error the node answered. */
export function refusalOf(error: ApiError): Refusal {
  const { status, message } = error
  if (status === 503 && message === NO_HOST_ERROR)
    return {
      icon: 'dns',
      title: 'No host is linked yet',
      text: 'Install apps and Devices come from a Mason host. An administrator pairs one on Nodes.',
      go: 'nodes',
    }
  if (status === 503 && message === HOST_UNREACHABLE_ERROR)
    return {
      icon: 'warning',
      tone: 'warning',
      title: 'The host is unreachable',
      text: 'Install apps and Devices come from the Mason host, which the master cannot reach right now. Try again in a moment.',
      retry: true,
    }
  if (status === 503 && /catching up/.test(message))
    return {
      icon: 'hourglass_top',
      tone: 'warning',
      title: 'The host is catching up with the master',
      text: 'Try again shortly.',
      retry: true,
    }
  if (status === 403 && message === TESTER_ACCESS_ERROR)
    return {
      icon: 'lock',
      tone: 'warning',
      title: 'Waiting for tester access',
      text: 'Your account is signed in. A Mason administrator needs to grant you tester access before you can view or download builds.',
    }
  if (status === 403 && /not on the host yet/.test(message))
    return {
      icon: 'hourglass_top',
      tone: 'warning',
      title: 'This account is not on the host yet',
      text: 'The host has not received your account from the master. Try again shortly.',
      retry: true,
    }
  if (status === 404 && message === 'Build unavailable')
    return {
      icon: 'error',
      tone: 'danger',
      title: 'Build unavailable',
      text: 'This build is no longer retained, or no longer yours to install. Choose a newer one.',
      go: 'apps',
    }
  if (status === 404 && message === 'Device unavailable')
    return {
      icon: 'mobile',
      title: 'Device unavailable',
      text: 'This device is not on your account any more.',
      go: 'devices',
    }
  if (status === 404)
    return {
      icon: 'search',
      title: 'This app is unavailable',
      text: 'It may have been removed, or your groups no longer include it.',
      go: 'apps',
    }
  if (status === 410)
    return {
      icon: 'link',
      tone: 'danger',
      title: 'The registration link is unavailable',
      text: 'It expired or was already used. Return to Register device and start again.',
      go: 'register',
    }
  return {
    icon: 'error',
    tone: 'danger',
    title: 'The request could not be completed',
    text: message,
    retry: true,
  }
}

/** A refusal or a failure, in the catalog's words, with what to do next. */
export function CatalogRefusal({
  error,
  retry,
}: {
  error: ApiError
  retry?: () => void
}): JSX.Element {
  const { session } = useShell()
  const refusal = refusalOf(error)
  const action =
    refusal.retry === true && retry != null ? (
      <Button variant="secondary" icon="refresh" onClick={retry}>
        Try again
      </Button>
    ) : refusal.go === 'apps' ? (
      <ButtonLink variant="secondary" to="/apps">
        Browse apps
      </ButtonLink>
    ) : refusal.go === 'devices' ? (
      <ButtonLink variant="secondary" to="/devices">
        Your devices
      </ButtonLink>
    ) : refusal.go === 'register' ? (
      <ButtonLink variant="primary" icon="mobile" to="/devices">
        Register device
      </ButtonLink>
    ) : refusal.go === 'nodes' && session.permissions.includes('nodes.read') ? (
      <ButtonLink variant="secondary" icon="dns" to="/nodes">
        Nodes
      </ButtonLink>
    ) : undefined
  return (
    <CatalogState
      icon={refusal.icon}
      {...(refusal.tone == null ? {} : { tone: refusal.tone })}
      title={refusal.title}
      actions={action}
    >
      {refusal.text}
    </CatalogState>
  )
}

/** A read that failed, as an `ApiError` (a contract error is one too). */
export const asApiError = (error: unknown): ApiError =>
  error instanceof ApiError
    ? error
    : new ApiError(0, String((error as Error)?.message ?? error))
