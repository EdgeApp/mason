// A project's Overview (screen-02-project): its app IDs, each opening its
// pages; its branch rules with the default branch, webhook and signing
// label; and its build-number sequences with *Set where it stands* for
// managers on the master. The host shows the same from its copy, read only.
import { useState, type JSX } from 'react'
import { Link, useParams } from 'react-router'
import type { ProjectOverview } from '../../../shared/api/index.js'
import { Count } from '../../ui/Badge.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import { PlatformChip } from '../../ui/RunChip.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { platformLook } from '../../ui/platform.js'
import { LastIssued, scopeWords, SeedSheet } from './BuildNumbers.js'
import { appHref, ProjectPage } from './project.js'

/** The app IDs, each with its platforms, Apple team and pages. */
function AppIds({ overview }: { overview: ProjectOverview }): JSX.Element {
  const names = new Map(
    overview.appNames.map((entry) => [entry.bundleId, entry.name]),
  )
  return (
    <section className="m-card" aria-labelledby="app-ids-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="apps" />
          <h2 className="m-t-title3" id="app-ids-title">
            App IDs
          </h2>
          <Count count={overview.apps.length} />
        </div>
      </header>
      {overview.apps.length === 0 ? (
        <EmptyState icon="apps" title="None." />
      ) : (
        <div className="m-table-wrap">
          <table className="m-table m-table--stack m-appids">
            <thead>
              <tr>
                <th scope="col">App ID</th>
                <th scope="col">Platforms</th>
                <th scope="col">Apple team</th>
                <th scope="col">
                  <span className="m-sr">Pages</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.apps.map((app) => {
                const href = appHref(overview.slug, app.bundleId)
                const look = platformLook(app.platforms[0] ?? '')
                return (
                  <tr key={app.bundleId} data-app={app.bundleId}>
                    <td data-primary data-label="App ID">
                      <span className="m-row m-appids__id">
                        <span className="m-glyphbox m-appids__glyph">
                          <Icon name={look.icon} />
                        </span>
                        <span className="m-list__main">
                          <Link
                            to={href}
                            className="m-t-mono m-appids__link m-wrap-any"
                          >
                            {app.bundleId}
                          </Link>
                          <span className="m-t-subhead m-secondary">
                            {names.get(app.bundleId) ?? app.bundleId}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td data-label="Platforms">
                      <span className="m-row m-appids__platforms">
                        {app.platforms.map((platform) => (
                          <PlatformChip key={platform} platform={platform} />
                        ))}
                      </span>
                    </td>
                    <td data-label="Apple team" className="m-t-mono-sm">
                      {app.apple?.team ?? <span className="m-tertiary">—</span>}
                    </td>
                    <td data-actions>
                      <div className="m-table__actions">
                        <ButtonLink variant="plain" size="sm" to={href}>
                          Runs and builds
                        </ButtonLink>
                        <ButtonLink
                          variant="plain"
                          size="sm"
                          iconOnly
                          icon="label"
                          label={`Build numbers of ${app.bundleId}`}
                          to={appHref(
                            overview.slug,
                            app.bundleId,
                            'build-numbers',
                          )}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** A branch rule's mode as a plain chip. */
function ModeChip({ mode }: { mode: string }): JSX.Element {
  return mode === 'automatic' ? (
    <Chip icon="bolt">Automatic</Chip>
  ) : mode === 'request' ? (
    <Chip icon="play_arrow">On request</Chip>
  ) : (
    <Chip>{mode}</Chip>
  )
}

/** The branch rules, the first match winning, and how the project builds. */
function BranchRules({ overview }: { overview: ProjectOverview }): JSX.Element {
  return (
    <section className="m-card" aria-labelledby="rules-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="fork_right" />
          <h2 className="m-t-title3" id="rules-title">
            Branch rules
          </h2>
        </div>
      </header>
      {overview.rules.length === 0 ? (
        <EmptyState icon="fork_right" title="No rules: nothing builds." />
      ) : (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th scope="col">Pattern</th>
                <th scope="col">Mode</th>
              </tr>
            </thead>
            <tbody>
              {overview.rules.map((rule, index) => (
                <tr key={`${rule.pattern}-${index}`}>
                  <td className="m-t-mono m-wrap-any">{rule.pattern}</td>
                  <td>
                    <ModeChip mode={rule.mode} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer className="m-card__footer">
        <dl className="m-kv m-kv--sm">
          <dt>Default branch</dt>
          <dd className="m-t-mono">{overview.defaultBranch}</dd>
          <dt>Masonfile</dt>
          <dd>{overview.format === 'script' ? 'Script' : 'Pipeline'}</dd>
          <dt>Webhook</dt>
          <dd>
            {overview.webhook ? (
              <StatusPill quiet status="ok" label="Set up" />
            ) : (
              <StatusPill quiet status="not_set_up" label="Not set up" />
            )}
          </dd>
          {overview.signingLabel != null && (
            <>
              <dt>Signs on</dt>
              <dd>
                nodes labelled <Chip kind="mono">{overview.signingLabel}</Chip>
              </dd>
            </>
          )}
        </dl>
      </footer>
    </section>
  )
}

/** The Masonfile's build-number sequences and where each stands. */
function BuildNumbers({
  overview,
  onSet,
}: {
  overview: ProjectOverview
  onSet: () => void
}): JSX.Element {
  const [seeding, setSeeding] = useState(false)
  const sequences = overview.buildNumbers
  const canSeed = overview.canSeed && sequences.length > 0
  return (
    <section className="m-card" aria-labelledby="build-numbers-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="label" />
          <h2 className="m-t-title3" id="build-numbers-title">
            Build numbers
          </h2>
        </div>
        {canSeed && (
          <Button
            variant="secondary"
            size="sm"
            icon="edit"
            aria-haspopup="dialog"
            onClick={() => setSeeding(true)}
          >
            Set where it stands
          </Button>
        )}
      </header>
      {sequences.length === 0 ? (
        <EmptyState icon="label">
          The Masonfile declares no build numbers yet, or setup has not run.
        </EmptyState>
      ) : (
        <div className="m-table-wrap">
          <table className="m-table m-table--stack">
            <thead>
              <tr>
                <th scope="col">Sequence</th>
                <th scope="col">Format</th>
                <th scope="col">Scope</th>
                <th scope="col">Last issued</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((sequence) => (
                <tr key={sequence.key}>
                  <td data-primary data-label="Sequence" className="m-t-mono">
                    {sequence.key}
                  </td>
                  <td data-label="Format" className="m-t-mono">
                    {sequence.format}
                  </td>
                  <td data-label="Scope">{scopeWords(sequence.scope)}</td>
                  <td data-label="Last issued">
                    <LastIssued sequence={sequence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canSeed && (
        <SeedSheet
          project={overview.slug}
          sequences={sequences}
          open={seeding}
          onClose={() => setSeeding(false)}
          onSet={onSet}
        />
      )}
    </section>
  )
}

/** `/projects/:slug`, both nodes. */
export function ProjectOverviewPage(): JSX.Element {
  const { slug = '' } = useParams()
  return (
    <ProjectPage slug={slug} tab="overview" title="Overview">
      {(overview, reload) => (
        <>
          <AppIds overview={overview} />
          <div className="m-grid-2 m-grid--start">
            <BranchRules overview={overview} />
            <BuildNumbers overview={overview} onSet={reload} />
          </div>
        </>
      )}
    </ProjectPage>
  )
}
