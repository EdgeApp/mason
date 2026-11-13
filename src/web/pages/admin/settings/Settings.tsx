// Settings, on the master for managers and administrators
// (screen-10-settings, screen-10b-settings-more): a section index beside
// the cards — Apple ID and signing, API keys, GitHub, Host, Storage,
// Sign-in, Cloud budget, Node types — and links to the other administration
// pages. Each card reads its own area and shows its own loading, empty and
// error states. Everyone here reads; settings.change edits GitHub, storage,
// the budget and node types; administrators (signIn.change) also change the
// host, the master address and the sign-in methods; apple.change signs the
// Apple ID in and sets signing up; keys.* create and revoke API keys.
import { useState, type JSX } from 'react'
import { asHostSetting, settingsPath } from '../../../../shared/api/settings.js'
import type { Permission } from '../../../../shared/permissions.js'
import { useResource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { ButtonLink } from '../../../ui/Button.js'
import type { IconName } from '../../../ui/icons.js'
import { StorageCard } from '../storage.js'
import { AppleCard } from './apple.js'
import { GithubCard } from './github.js'
import { BudgetCard, HostCard } from './host.js'
import { KeysCard } from './keys.js'
import { NodeTypesCard } from './nodeTypes.js'
import { SignInCard } from './signIn.js'

/** The sections, in the order the cards come. */
const SECTIONS: ReadonlyArray<{
  id: string
  label: string
  /** The permission that shows it; none: everyone here. */
  needs?: Permission
}> = [
  { id: 'apple-session', label: 'Apple ID' },
  { id: 'keys', label: 'API keys', needs: 'keys.read' },
  { id: 'github', label: 'GitHub', needs: 'settings.change' },
  { id: 'host', label: 'Host', needs: 'settings.change' },
  { id: 'storage', label: 'Storage', needs: 'settings.change' },
  { id: 'signIn', label: 'Sign-in', needs: 'settings.change' },
  { id: 'cloud', label: 'Cloud budget', needs: 'settings.change' },
  { id: 'nodeTypes', label: 'Node types', needs: 'settings.change' },
]

const RELATED: ReadonlyArray<{ to: string; label: string; icon: IconName }> = [
  { to: '/people', label: 'People', icon: 'person' },
  { to: '/groups', label: 'Groups', icon: 'group' },
  { to: '/backups', label: 'Backups', icon: 'backup' },
  { to: '/nodes', label: 'Nodes', icon: 'dns' },
]

/** The index: a link per card; the one chosen last is current. */
function SectionIndex({
  sections,
}: {
  sections: typeof SECTIONS
}): JSX.Element {
  const [current, setCurrent] = useState(sections[0]?.id)
  return (
    <nav className="m-sections__index" aria-label="Settings sections">
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={current === section.id ? 'true' : undefined}
          onClick={(event) => {
            event.preventDefault()
            setCurrent(section.id)
            const card = document.getElementById(section.id)
            card?.scrollIntoView?.({ block: 'start' })
            card?.querySelector<HTMLElement>('h2')?.focus({
              preventScroll: true,
            })
          }}
        >
          {section.label}
        </a>
      ))}
    </nav>
  )
}

/** `/settings`, the master only. */
export function SettingsPage(): JSX.Element {
  const { session } = useShell()
  const may = (permission: Permission): boolean =>
    session.permissions.includes(permission)
  const change = may('settings.change')
  const admin = may('signIn.change')
  const host = useResource(change ? settingsPath('host') : null, asHostSetting)
  const sections = SECTIONS.filter(
    (section) => section.needs == null || may(section.needs),
  )
  return (
    <Page
      crumbs={[{ label: 'Settings' }]}
      title="Settings"
      description="How this master signs people in, reaches GitHub and Apple, keeps its builds and runs its nodes."
    >
      <nav className="m-row m-settings__related" aria-label="Related pages">
        {RELATED.map((link) => (
          <ButtonLink
            key={link.to}
            to={link.to}
            variant="plain"
            size="sm"
            icon={link.icon}
          >
            {link.label}
          </ButtonLink>
        ))}
      </nav>
      <div className="m-sections m-settings">
        <SectionIndex sections={sections} />
        <div className="m-stack m-stack--lg">
          <AppleCard change={may('apple.change')} />
          {may('keys.read') && <KeysCard />}
          {change && (
            <>
              <GithubCard />
              <HostCard read={host} admin={admin} />
              <StorageCard />
              <SignInCard host={host} admin={admin} />
              <BudgetCard />
              <NodeTypesCard />
            </>
          )}
        </div>
      </div>
    </Page>
  )
}
