import { useState, type JSX } from 'react'
import { Link } from 'react-router'
import {
  asNotifications,
  NOTIFICATIONS_PATH,
  type NotificationItem,
} from '../../shared/api/index.js'
import { useResource } from '../hooks/useResource.js'
import { Badge } from '../ui/Badge.js'
import { buttonClass } from '../ui/Button.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Icon } from '../ui/Icon.js'
import { Popover } from '../ui/Popover.js'
import { SkeletonText } from '../ui/Skeleton.js'
import { StatusPill } from '../ui/StatusPill.js'

/** "Notifications, 2 need you": the button's name carries the count. */
export const notificationsName = (count: number): string =>
  count === 0
    ? 'Notifications, nothing needs you'
    : `Notifications, ${count} ${count === 1 ? 'needs' : 'need'} you`

function Row({ item }: { item: NotificationItem }): JSX.Element {
  const pill =
    item.kind === 'approval' ? (
      <StatusPill status="awaiting_approval" label="Approve" quiet />
    ) : (
      <StatusPill status="unconfirmed" label="Notice" quiet />
    )
  const main = (
    <span className="m-list__main">
      <span className="m-t-callout">{item.text}</span>
    </span>
  )
  return (
    <li>
      {item.href == null ? (
        <div className="m-list__row">
          {pill}
          {main}
        </div>
      ) : (
        <Link className="m-list__row" to={item.href}>
          {pill}
          {main}
        </Link>
      )}
    </li>
  )
}

/**
 * The top bar's notifications: a badge counting what needs the viewer, and
 * a popover (a sheet on narrow) listing it from `GET /api/v2/notifications`,
 * refreshed by the shell's live status and on every open.
 */
export function Notifications(): JSX.Element {
  const [open, setOpen] = useState(false)
  const { data, error, reload } = useResource(
    NOTIFICATIONS_PATH,
    asNotifications,
    {
      invalidatedBy: ['status'],
    },
  )
  const count = data?.length ?? 0
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      title="Notifications"
      aside={
        count > 0 ? (
          <Badge count={count} label={`${count} need you`} />
        ) : undefined
      }
      trigger={
        <button
          type="button"
          className={buttonClass({
            variant: 'plain',
            iconOnly: true,
            className: 'm-iconbadge',
          })}
          aria-label={notificationsName(count)}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => {
            if (!open) reload()
            setOpen(!open)
          }}
        >
          <Icon name="notifications" />
          {count > 0 && <Badge count={count} />}
        </button>
      }
    >
      {error != null && data == null ? (
        <EmptyState icon="error" tone="danger">
          {error.message}
        </EmptyState>
      ) : data == null ? (
        <div className="m-card__body">
          <SkeletonText lines={2} label="Loading notifications" />
        </div>
      ) : data.length === 0 ? (
        <EmptyState icon="check">Nothing needs you.</EmptyState>
      ) : (
        <ul className="m-list">
          {data.map((item, n) => (
            <Row key={`${n}-${item.text}`} item={item} />
          ))}
        </ul>
      )}
    </Popover>
  )
}
