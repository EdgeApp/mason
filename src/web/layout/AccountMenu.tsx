import type { JSX } from 'react'
import { useHref } from 'react-router'
import { useApi } from '../api/context.js'
import {
  APPEARANCE_LABELS,
  useAppearance,
  type Appearance,
} from '../hooks/useAppearance.js'
import { NARROW, useMedia } from '../hooks/useMedia.js'
import { useProfile } from '../profile/NodeProfile.js'
import { Avatar } from '../ui/Avatar.js'
import { buttonClass } from '../ui/Button.js'
import { Menu, type MenuEntry } from '../ui/Menu.js'
import { StatusPill } from '../ui/StatusPill.js'
import { workersLabel } from './ClusterChips.js'
import { useShell } from './ShellContext.js'

const ROLE_WORDS = {
  tester: 'Tester',
  developer: 'Developer',
  manager: 'Manager',
  admin: 'Admin',
} as const

const APPEARANCES: Appearance[] = ['dark', 'light', 'system']

/**
 * The avatar's account menu: who and where (name, role, node; on narrow the
 * cluster's health too), Your account, Appearance and Sign out. Signing out
 * ends the session, then leaves for sign-in with a full load.
 */
export function AccountMenu(): JSX.Element {
  const { session, status } = useShell()
  const profile = useProfile()
  const client = useApi()
  const narrow = useMedia(NARROW)
  const [appearance, setAppearance] = useAppearance()
  const account = useHref('/account')
  const cluster = status?.cluster
  const entries: MenuEntry[] = [
    {
      kind: 'label',
      content: (
        <>
          <strong className="m-t-headline">{session.name}</strong>
          <br />
          <span className="m-t-subhead m-secondary">
            {ROLE_WORDS[session.role]} · {profile.name}
          </span>
          {narrow && cluster != null && profile.clusterChips && (
            <>
              <br />
              <StatusPill
                status={cluster.healthy ? 'healthy' : 'degraded'}
                label={`${cluster.healthy ? 'Cluster healthy' : 'Cluster degraded'} · ${workersLabel(cluster)}`}
                quiet
              />
            </>
          )}
        </>
      ),
    },
    { kind: 'separator' },
    // A password page: entered by a full load (`PASSWORD_PATHS`).
    {
      kind: 'item',
      label: 'Your account',
      icon: 'person',
      run: () => client.leave(account),
    },
    { kind: 'separator' },
    { kind: 'label', content: <p className="m-t-eyebrow">Appearance</p> },
    ...APPEARANCES.map(
      (value): MenuEntry => ({
        kind: 'item',
        label: APPEARANCE_LABELS[value],
        icon: 'tune',
        checked: appearance === value,
        run: () => setAppearance(value),
      }),
    ),
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Sign out',
      icon: 'logout',
      run: (): void => {
        void client
          .signOut()
          .catch(() => undefined)
          .then(() => client.leave(profile.signedOut))
      },
    },
  ]
  return (
    <Menu
      label="Account"
      entries={entries}
      triggerLabel="Your account"
      triggerClassName={buttonClass({ variant: 'plain', iconOnly: true })}
      trigger={<Avatar name={session.name} size="sm" />}
    />
  )
}
