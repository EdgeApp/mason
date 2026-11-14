// An app on Install apps (screen-16b-install-app): its branches with builds
// for the chosen platform, master first, each with when it was last built;
// when that platform has none, the platforms that do; and the app with no
// retained builds at all.
import type { JSX } from 'react'
import { Link, useParams } from 'react-router'
import {
  asAppData,
  catalogAppPath,
  platformNames,
} from '../../../shared/api/index.js'
import { branchKey } from '../../../shared/catalog.js'
import { absoluteTime } from '../../../shared/format.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { Icon } from '../../ui/Icon.js'
import { platformLook } from '../../ui/platform.js'
import { Loading } from '../projects/project.js'
import {
  CatalogRefusal,
  CatalogState,
  catalogCrumbs,
  PlatformSwitch,
  rememberPlatform,
  usePlatform,
  withPlatform,
} from './catalog.js'

/** A valid app id from the address, or none. */
export const appIdOf = (value: string | undefined): number | undefined =>
  value != null && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : undefined

/** "Last built Today 1431 PT". */
function LastBuilt({ at }: { at: number }): JSX.Element {
  const iso = new Date(at).toISOString()
  return (
    <span className="m-list__sub">
      Last built{' '}
      <time dateTime={iso} title={iso}>
        {absoluteTime(at, Date.now())}
      </time>
    </span>
  )
}

/** `/apps/:appId`. */
export function AppPage(): JSX.Element {
  const params = useParams()
  const { platform, to } = usePlatform()
  const id = appIdOf(params.appId)
  const read = useResource(
    id == null ? null : withPlatform(catalogAppPath(id), platform),
    asAppData,
  )
  const look = platformLook(platform)
  const data = read.data
  const unavailable = id == null || read.error?.status === 404
  const name = data?.app.name ?? (unavailable ? 'App unavailable' : 'App')
  const crumbs = catalogCrumbs(platform, { label: name })
  const appPath = `/apps/${id}`
  return (
    <Page
      crumbs={crumbs}
      title={name}
      description={
        data == null ? undefined : `Branches with builds for ${look.name}.`
      }
    >
      {data != null && (
        <PlatformSwitch platforms={data.platforms} chosen={platform} to={to} />
      )}
      {id == null ? (
        <CatalogState icon="search" title="This app is unavailable">
          It may have been removed, or your groups no longer include it.
        </CatalogState>
      ) : data != null ? (
        data.branches.length === 0 ? (
          <CatalogState icon="inventory_2" title="No retained builds yet.">
            Builds appear here once a run of this app publishes one.
          </CatalogState>
        ) : data.latest[platform] != null ? (
          <section className="m-card" aria-label="Branches">
            <ul className="m-list">
              {data.branches.map((branch) => (
                <li key={branch.name}>
                  <Link
                    className="m-list__row"
                    to={withPlatform(
                      `${appPath}/branches/${branchKey(branch.name)}`,
                      platform,
                    )}
                  >
                    <span className="m-glyphbox">
                      <Icon name="fork_right" />
                    </span>
                    <span className="m-list__main">
                      <span className="m-t-mono m-catalog-branch">
                        {branch.name}
                      </span>
                      <LastBuilt at={branch.time} />
                    </span>
                    <Icon name="chevron_right" className="m-chev" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="m-card" aria-label="No builds for this platform">
            <div className="m-card__body m-stack">
              <p className="m-row m-t-callout">
                <Icon name="info" className="m-tertiary" />
                <span>{`There are currently no builds for ${look.name}. Select one of these other platforms:`}</span>
              </p>
            </div>
            <ul className="m-list">
              {platformNames
                .filter((other) => (data.latest[other] ?? 0) > 0)
                .map((other) => {
                  const otherLook = platformLook(other)
                  return (
                    <li key={other}>
                      <Link
                        className="m-list__row"
                        to={to(other)}
                        onClick={() => rememberPlatform(other)}
                      >
                        <span className="m-glyphbox">
                          <Icon name={otherLook.icon} />
                        </span>
                        <span className="m-list__main">
                          <span className="m-t-headline">{otherLook.name}</span>
                          <LastBuilt at={data.latest[other]!} />
                        </span>
                        <Icon name="chevron_right" className="m-chev" />
                      </Link>
                    </li>
                  )
                })}
            </ul>
          </section>
        )
      ) : read.error != null ? (
        <CatalogRefusal error={read.error} retry={read.reload} />
      ) : (
        <Loading label="Loading the app’s branches" />
      )}
    </Page>
  )
}
