import type { JSX } from 'react'
import { Link, useLocation } from 'react-router'
import { asDashboardData, DASHBOARD_PATH } from '../../shared/api/index.js'
import { useResource } from '../hooks/useResource.js'
import { useProfile } from '../profile/NodeProfile.js'
import { currentNav, navSections, type NavItem } from '../profile/navigation.js'
import { Chip } from '../ui/Chip.js'
import { Icon } from '../ui/Icon.js'
import { Skeleton } from '../ui/Skeleton.js'
import { LiveFooter } from './LiveFooter.js'
import { useShell } from './ShellContext.js'

/** The sidebar's projects, from the dashboard read: name, link and whether a run is running. */
function Projects({ pathname }: { pathname: string }): JSX.Element {
  const { data } = useResource(DASHBOARD_PATH, asDashboardData, {
    invalidatedBy: ['status', 'queue'],
  })
  return (
    <div className="m-sidebar__section">
      <p className="m-t-eyebrow m-sidebar__label" id="sidebar-projects">
        Projects
      </p>
      {data == null ? (
        <Skeleton height="2.5rem" />
      ) : (
        <ul className="m-list" aria-labelledby="sidebar-projects">
          {data.projects.map((project, n) => {
            const href = `/projects/${project.slug}`
            const running = project.runs.filter(
              (run) => run.status === 'running',
            ).length
            const current = pathname === href || pathname.startsWith(`${href}/`)
            return (
              <li key={project.slug}>
                <Link
                  className="m-navitem m-navitem--project"
                  to={href}
                  aria-current={current ? 'page' : undefined}
                >
                  <span
                    className="m-navitem__mark"
                    style={{ background: `var(--m-cat-${(n % 6) + 1})` }}
                    aria-hidden="true"
                  >
                    {project.name.charAt(0).toUpperCase()}
                  </span>
                  <span>{project.name}</span>
                  {running > 0 && (
                    <span className="m-navitem__count">
                      <span
                        className="m-dot m-dot--live"
                        style={{
                          ['--solid' as string]: 'var(--m-running-solid)',
                        }}
                        role="img"
                        aria-label={`${running} ${running === 1 ? 'run' : 'runs'} running`}
                        title={`${running} ${running === 1 ? 'run' : 'runs'} running`}
                      />
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * The wide shell's sidebar: the logo, Mason, the version and the node's
 * pill; the viewer's destinations by section; the projects (for those who
 * read them); and the footer with the live connection and the node version.
 */
export function Sidebar({ nav }: { nav: NavItem[] }): JSX.Element {
  const profile = useProfile()
  const { status } = useShell()
  const { pathname } = useLocation()
  const projects = nav.some((entry) => entry.key === 'dashboard')
  const inProject = projects && /^\/projects\/(?!new$)[^/]+/.test(pathname)
  const current = inProject ? undefined : currentNav(pathname, nav)
  return (
    <aside className="m-app__side m-sidebar m-glass" aria-label="Main">
      <div className="m-sidebar__brand">
        <img
          src="/assets/logo/mason-logo-64.png"
          alt=""
          width="28"
          height="28"
        />
        <strong>Mason</strong>
        <Chip kind="mono">v{profile.version}</Chip>
      </div>
      <span className="m-node-pill m-sidebar__node">
        <Icon name="lan" size="sm" />
        {profile.short}
      </span>
      <nav aria-label="Destinations">
        {navSections(nav).map((section) => (
          <div className="m-sidebar__section" key={section.section}>
            <p className="m-t-eyebrow m-sidebar__label">{section.section}</p>
            {section.items.map((entry) => (
              <Link
                key={entry.key}
                className="m-navitem"
                to={entry.href}
                aria-current={entry === current ? 'page' : undefined}
              >
                <Icon name={entry.icon} />
                <span>{entry.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      {projects && <Projects pathname={pathname} />}
      <div className="m-sidebar__foot">
        <LiveFooter masterUnreachable={status?.link?.online === false} />
        <span className="m-t-mono-sm m-tertiary">
          {profile.role} {profile.version}
        </span>
      </div>
    </aside>
  )
}
