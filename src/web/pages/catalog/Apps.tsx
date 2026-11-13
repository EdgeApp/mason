// Install apps (screen-16-install, the catalog home): the apps the viewer
// may install, each opening its branches for the chosen platform. It is
// `/apps`, and `/` for a tester on the master and for everyone on the host.
import type { JSX } from 'react'
import { Link } from 'react-router'
import { asAppsData, CATALOG_APPS_PATH } from '../../../shared/api/index.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { Count } from '../../ui/Badge.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import { Loading } from '../projects/project.js'
import {
  CatalogRefusal,
  catalogCrumbs,
  INSTALL_APPS,
  PlatformSwitch,
  usePlatform,
  withPlatform,
} from './catalog.js'

/** An app's tile: the initials of its first two words. */
export const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '?'

/** `/apps`: Install apps. */
export function AppsPage(): JSX.Element {
  const { platform, to } = usePlatform()
  const read = useResource(CATALOG_APPS_PATH, asAppsData)
  const crumbs = catalogCrumbs(platform)
  return (
    <Page
      crumbs={crumbs}
      title={INSTALL_APPS}
      description="Choose an app to browse recent builds."
    >
      {read.data != null && (
        <PlatformSwitch
          platforms={read.data.platforms}
          chosen={platform}
          to={to}
        />
      )}
      {read.data != null ? (
        <section className="m-card" aria-labelledby="apps-title">
          <header className="m-card__header">
            <div className="m-card__title">
              <Icon name="apps" />
              <h2 className="m-t-title3" id="apps-title">
                Apps
              </h2>
              <Count count={read.data.apps.length} />
            </div>
          </header>
          {read.data.apps.length === 0 ? (
            <EmptyState icon="apps" title="No apps have been configured yet.">
              Apps appear here once a project with app IDs publishes a build
              your groups can see.
            </EmptyState>
          ) : (
            <ul className="m-list">
              {read.data.apps.map((app) => (
                <li key={app.id}>
                  <Link
                    className="m-list__row"
                    to={withPlatform(`/apps/${app.id}`, platform)}
                  >
                    <span
                      className="m-appicon m-appicon--sm"
                      aria-hidden="true"
                    >
                      {initials(app.name)}
                    </span>
                    <span className="m-list__main">
                      <span className="m-t-headline">{app.name}</span>
                      <span className="m-list__sub m-t-mono-sm">
                        {app.slug}
                      </span>
                    </span>
                    <Icon name="chevron_right" className="m-chev" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : read.error != null ? (
        <CatalogRefusal error={read.error} retry={read.reload} />
      ) : (
        <Loading label="Loading your apps" />
      )}
    </Page>
  )
}
