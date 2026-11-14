import type { JSX } from 'react'
import type {
  Banner as StatusBanner,
  StatusInfo,
} from '../../shared/api/index.js'
import { absoluteTime, relativeTime } from '../../shared/format.js'
import { NARROW, useMedia } from '../hooks/useMedia.js'
import { useLiveState } from '../live/LiveProvider.js'
import { Banner, Banners, type BannerItem } from '../ui/Banner.js'
import { Button, ButtonLink } from '../ui/Button.js'
import { Chip } from '../ui/Chip.js'
import { useShell } from './ShellContext.js'

/** The status banners by importance, for banners of one tone. */
const KIND_ORDER: ReadonlyArray<StatusBanner['kind']> = [
  'offline',
  'backup',
  'testEndpoints',
]

/** One banner the status read names, drawn by its kind. */
function statusBanner(
  banner: StatusBanner,
  status: StatusInfo,
  retry: () => void,
  now: number,
): BannerItem {
  switch (banner.kind) {
    case 'offline': {
      const last = status.link?.lastContact
      return {
        key: 'offline',
        tone: 'warning',
        node: (
          <Banner
            tone="warning"
            announce
            title={
              <>
                The master is unreachable <Chip kind="mono">Read-only</Chip>
              </>
            }
            meta={
              last == null
                ? undefined
                : `Last reached ${absoluteTime(last, now)} · ${relativeTime(last, now)}`
            }
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                onClick={retry}
              >
                Retry
              </Button>
            }
          >
            {banner.text} Runs, approvals and account changes need the master.
          </Banner>
        ),
      }
    }
    case 'backup':
      return {
        key: 'backup',
        tone: 'warning',
        node: (
          <Banner
            tone="warning"
            icon="backup"
            title={banner.text}
            actions={
              <ButtonLink
                variant="secondary"
                size="sm"
                to={banner.href ?? '/backups'}
              >
                Open Backups
              </ButtonLink>
            }
          />
        ),
      }
    case 'testEndpoints':
      return {
        key: 'testEndpoints',
        tone: 'info',
        node: <Banner tone="info" icon="bolt" compact title={banner.text} />,
      }
  }
}

/**
 * The shell's banners above every page, from `GET /api/v2/status` (and its
 * live updates): master unreachable, the backup reminder, test endpoints;
 * live updates unavailable; on narrow, a degraded cluster.
 */
export function ShellBanners(): JSX.Element | null {
  const { status, reloadStatus, nav } = useShell()
  const live = useLiveState()
  const narrow = useMedia(NARROW)
  const now = Date.now()
  // Equal tones keep this order: the master unreachable before the reminder.
  const items: BannerItem[] = [...(status?.banners ?? [])]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((banner) => statusBanner(banner, status!, reloadStatus, now))
  if (live === 'unavailable')
    items.push({
      key: 'live',
      tone: 'warning',
      node: (
        <Banner
          tone="warning"
          title="Live updates are unavailable"
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          }
        >
          This page shows what it had when it loaded. Reload it to see changes.
        </Banner>
      ),
    })
  const cluster = status?.cluster
  if (narrow && cluster != null && !cluster.healthy)
    items.push({
      key: 'cluster',
      tone: 'warning',
      node: (
        <Banner
          tone="warning"
          title="The cluster is degraded"
          actions={
            nav.some((entry) => entry.key === 'nodes') ? (
              <ButtonLink variant="secondary" size="sm" to="/nodes">
                Nodes
              </ButtonLink>
            ) : undefined
          }
        >
          Not every worker is connected: {cluster.idle} of {cluster.total} idle.
        </Banner>
      ),
    })
  return <Banners items={items} />
}
