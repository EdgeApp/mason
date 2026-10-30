import type express from 'express'
import { cookie } from '../auth/routes.js'
import {
  masterContentSecurityPolicy,
  testBanner,
  type WebAppContext,
} from '../node/webApp.js'
import { escape } from '../view/html.js'
import {
  masonfileView,
  nodesView,
  peopleView,
  projectRunsView,
  projectView,
  secretsView,
  cloudView,
  settingsView,
  type SignInMethodView,
  wizardView,
  type NodeRow,
} from '../view/admin.js'
import { artifactsView, runsTable } from '../view/artifacts.js'
import { fqdn } from './cloud/hosts.js'
import { DEFAULT_MONTHLY_BUDGET } from './cloud/pools.js'
import { methodsOf } from './hostSettings.js'
import { storedNodeType } from './nodeTypes.js'
import {
  dashboardData,
  dashboardView,
  type DashboardSource,
} from '../view/dashboard.js'
import {
  approvalNotifications,
  notificationsFor,
} from '../view/notifications.js'
import { graphFromJson, runData, runView } from '../view/run.js'
import { search } from '../view/search.js'
import { runLog } from './runsApi.js'
import { discovery } from './wizard.js'
import { shell, type Viewer } from '../view/shell.js'
import { MASTER_SESSION_COOKIE, type MasterSession } from './auth.js'
import { can } from './permissions.js'
import { sessionActor } from './auth.js'
import type { Master } from './runtime.js'
import { repository, version } from '../version.js'
import { clientAddress } from './forward.js'
import { ProjectNotFound } from './projects.js'

/** The signed-in person as the views see them. */
function viewerOf(session: MasterSession): Viewer {
  return {
    name: session.name,
    role: session.role,
    node: 'master',
    signOut:
      '<form method="post" data-mason="sign-out"><button class="secondary">Sign out</button></form>',
  }
}

/** Worker capacity and health for the top bar, and the nodes for the dashboard. */
function cluster(master: Master): {
  status: { idle: number; total: number; healthy: boolean }
  nodes: NonNullable<DashboardSource['nodes']>
} {
  const workers = master.registry
    .list()
    .filter((node) => node.role === 'worker')
  const nodes = workers.map((node) => {
    const busy = node.connected && master.scheduler.busy(node.fingerprint)
    const inventory = master.scheduler.inventoryOf(node.fingerprint)
    return {
      name: node.name,
      status: (!node.connected ? 'offline' : busy ? 'busy' : 'idle') as
        | 'offline'
        | 'busy'
        | 'idle',
      detail: [
        node.type,
        inventory == null ? undefined : `${inventory.os} ${inventory.arch}`,
        `${node.slots} slot${node.slots === 1 ? '' : 's'}`,
      ]
        .filter((part) => part != null && part !== '')
        .join(' · '),
    }
  })
  return {
    status: {
      idle: nodes.filter((node) => node.status === 'idle').length,
      total: nodes.length,
      healthy: nodes.every((node) => node.status !== 'offline'),
    },
    nodes,
  }
}

/** A master page: the shell, the forms script, and the banners that apply. */
function masterPage(
  context: WebAppContext,
  master: Master,
  title: string,
  content: string,
  session?: MasterSession,
  active?: string,
  scripts: string[] = [],
): string {
  // The backup reminder is for those who may configure backups; an
  // administrator who skipped confirming the key is reminded of it too.
  const notice =
    master.configured() &&
    session != null &&
    can(sessionActor(session), 'settings.read')
      ? (master.backups.notice() ??
        (can(sessionActor(session), 'backups.key') &&
        master.backups.needsConfirmation(session.accountId)
          ? 'The backup key is not confirmed as stored'
          : undefined))
      : undefined
  const banner =
    notice == null
      ? ''
      : `<p class="notice" role="alert">${escape(notice)}. <a href="/backups">Backups</a></p>`
  const viewer = session == null ? undefined : viewerOf(session)
  return shell({
    title,
    body: content.startsWith('<div class="page-head')
      ? content
      : `<h1>${escape(title)}</h1>${content}`,
    ...(viewer == null
      ? {}
      : {
          viewer,
          status: cluster(master).status,
          notifications: notificationsFor(
            viewer,
            approvalNotifications(master.database.db, viewer, (job, stage) =>
              master.scheduler.approvalRoles(job, stage),
            ),
            master.notices(),
          ),
          head: `<meta name="mason-csrf" content="${escape(session!.csrf)}">`,
        }),
    ...(active == null ? {} : { active }),
    banners: testBanner(context) + banner,
    scripts: ['/assets/master.js', '/assets/run.js', ...scripts],
  })
}

/** Whether the viewer may see an app ID: developers and up see every one, testers their groups'. */
function appVisible(
  master: Master,
  session: MasterSession,
): (appId: number) => boolean {
  if (session.role !== 'tester') return () => true
  const allowed = new Set(
    (
      master.database.db
        .prepare(
          'SELECT ga.app_id FROM group_apps ga JOIN group_members gm ON gm.group_id=ga.group_id WHERE gm.account_id=?',
        )
        .all(session.accountId) as Array<{ app_id: number }>
    ).map((row) => row.app_id),
  )
  return (appId) => allowed.has(appId)
}

const status = '<p class="notice" role="status" data-field="status" hidden></p>'

const setupPage = `<section class="card"><h2>Create the first account</h2><p>Enter the six-digit setup code this master printed in its terminal when it started. The first account is an administrator.</p><form data-mason="setup"><label for="code">Setup code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required><p><button>Create account</button></p>${status}</form></section><section class="card"><h2>Restore from a backup</h2><p>Rebuild this master from its encrypted git backup instead. It comes back as the same master, so its nodes reconnect: stop the master the backup came from first.</p><form data-mason="restore"><label for="restore-code">Setup code</label><input id="restore-code" name="code" inputmode="numeric" pattern="[0-9]{6}" required><label for="repository">Backup repository</label><input id="repository" name="repository" placeholder="git@github.com:owner/mason-backup.git" required><label for="key">Backup key file</label><input id="key" name="key" type="file" required><label for="date">Date (optional, YYYY-MM-DD)</label><input id="date" name="date" pattern="\\d{4}-\\d{2}-\\d{2}"><p><button class="secondary">Restore</button></p>${status}</form></section>`

const signInPage = `<section class="card"><form data-mason="sign-in"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><p><button>Sign in</button></p>${status}</form></section>`

function backupsPage(master: Master, session: MasterSession): string {
  const actor = sessionActor(session)
  const backups = master.backups.status()
  const value = (master.settings.value('backup') ?? {}) as {
    repository?: string
    branch?: string
    deployKey?: { publicKey: string }
  }
  const state = backups.backedUp
    ? `<p>Last backup ${escape(new Date(backups.lastSuccess!.at).toISOString())} (${escape(backups.lastSuccess!.commit.slice(0, 12))})${backups.lastSuccess!.auth == null ? '' : `, pushed with ${backups.lastSuccess!.auth === 'github' ? 'the GitHub connection' : 'the deploy key'}`}.</p>`
    : backups.lastFailure != null
      ? `<p>The last backup failed: ${escape(backups.lastFailure.error)}</p>`
      : '<p>No backup has run yet.</p>'
  const key =
    backups.configured && can(actor, 'backups.key')
      ? `<section class="card"><h2>Backup key</h2><p>Store this key somewhere safe outside this master. Without it no backup can be restored.</p><pre data-field="backupKey">${escape(master.backups.keyText())}</pre>${
          master.backups.needsConfirmation(session.accountId)
            ? `<form data-mason="backup-confirm"><p><button>I have stored the backup key</button></p>${status}</form>`
            : '<p>You confirmed you stored this key.</p>'
        }</section>`
      : ''
  return `<section class="card"><p>Every hour the master encrypts a snapshot of its database and pushes it to a git repository. Add the deploy key below to that repository with write access.</p>${state}<form data-mason="backup"><label for="repository">Repository</label><input id="repository" name="repository" value="${escape(value.repository ?? '')}" placeholder="git@github.com:owner/mason-backup.git" required><label for="branch">Branch</label><input id="branch" name="branch" value="${escape(value.branch ?? 'master')}" required><p><button>Save</button></p><p>Deploy key</p><pre data-field="deployKey"${value.deployKey == null ? ' hidden' : ''}>${escape(value.deployKey?.publicKey ?? '')}</pre><pre data-field="backupKey" hidden></pre>${status}</form><p><a href="/?later=backups">Skip for now</a></p></section>${key}`
}

/** A tester's apps on the master: installs happen on the host. */
function testerApps(master: Master, session: MasterSession): string {
  const visible = appVisible(master, session)
  const origin = ((master.settings.value('host') ?? {}) as { origin?: string })
    .origin
  const apps = (
    master.database.db
      .prepare(
        'SELECT id,name,slug FROM apps WHERE enabled=1 ORDER BY position,id',
      )
      .all() as Array<{ id: number; name: string; slug: string }>
  ).filter((app) => visible(app.id))
  return `<p class="intro">Install builds from ${origin == null ? 'the Mason host' : `<a href="${escape(origin)}">${escape(new URL(origin).host)}</a>`}.</p><div class="app-list">${
    apps
      .map(
        (app) =>
          `<a class="app-card" href="${escape(origin == null ? '#' : `${origin}/apps/${app.id}`)}"><div><h2>${escape(app.name)}</h2><small>${escape(app.slug)}</small></div><span aria-hidden="true">→</span></a>`,
      )
      .join('') || '<p class="empty-state">No apps are shared with you yet.</p>'
  }</div>`
}

/** Set by "Skip for now": the dashboard stops sending an administrator to Backups for this browser session. */
const BACKUP_LATER_COOKIE = 'mason-backups-later'

/** The master's pages: setup until the first account exists, then sign-in, home and backups. */
export function masterPages(
  app: express.Express,
  context: WebAppContext,
  master: Master,
): void {
  const session = (req: express.Request): MasterSession | undefined =>
    master.auth.session(cookie(req, MASTER_SESSION_COOKIE))
  const send = (
    res: express.Response,
    title: string,
    content: string,
    current?: MasterSession,
    code = 200,
    active?: string,
    scripts: string[] = [],
  ): void => {
    res
      .status(code)
      .send(
        masterPage(context, master, title, content, current, active, scripts),
      )
  }
  // Only the pages that hash a password run the Argon2id WebAssembly.
  const hashing = (res: express.Response): void => {
    res.set('Content-Security-Policy', masterContentSecurityPolicy)
  }
  app.get('/', (req, res) => {
    if (!master.configured()) {
      hashing(res)
      send(res, 'Set up this master', setupPage)
      return
    }
    const current = session(req)
    if (current == null) {
      res.redirect(303, '/sign-in')
      return
    }
    // An administrator who has not confirmed the backup key is sent to the
    // Backups page once per browser session; after that, or after "Skip for
    // now", the dashboard opens and the banner on every page reminds them.
    const later = (): void => {
      res.cookie(BACKUP_LATER_COOKIE, '1', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: req.secure,
      })
    }
    if (req.query.later === 'backups') {
      later()
      res.redirect(303, '/')
      return
    }
    if (
      can(sessionActor(current), 'backups.key') &&
      master.backups.needsConfirmation(current.accountId) &&
      // The session-token reader takes only tokens; this cookie holds a flag.
      !new RegExp(`(?:^|;\\s*)${BACKUP_LATER_COOKIE}=1(?:;|$)`).test(
        req.headers.cookie ?? '',
      )
    ) {
      later()
      res.redirect(303, '/backups')
      return
    }
    const now = master.database.now()
    if (current.role === 'tester') {
      send(res, 'Your apps', testerApps(master, current), current)
      return
    }
    const platform =
      typeof req.query.platform === 'string' ? req.query.platform : undefined
    const project =
      typeof req.query.project === 'string' ? req.query.project : undefined
    const repositories = new Map(
      (
        master.database.db
          .prepare(
            'SELECT id,repository,webhook_secret IS NOT NULL AS webhook FROM projects',
          )
          .all() as Array<{ id: number; repository: string; webhook: number }>
      ).map((row) => [
        row.id,
        { repository: row.repository, webhook: row.webhook === 1 },
      ]),
    )
    const data = dashboardData(
      {
        db: master.database.db,
        viewer: viewerOf(current),
        now,
        appVisible: appVisible(master, current),
        nodes: cluster(master).nodes,
        repositories,
      },
      {
        ...(platform == null ? {} : { platform }),
        ...(project == null ? {} : { project }),
      },
    )
    send(
      res,
      'Projects & apps',
      dashboardView(data, viewerOf(current), now),
      current,
      200,
      'dashboard',
    )
  })
  app.get('/artifacts', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (current.role === 'tester') {
      send(
        res,
        'Artifacts',
        '<p>Artifacts are for developers and up.</p>',
        current,
        403,
      )
      return
    }
    const origin = (
      (master.settings.value('host') ?? {}) as { origin?: string }
    ).origin
    const filter = (name: string): string | undefined =>
      typeof req.query[name] === 'string'
        ? (req.query[name] as string)
        : undefined
    const run = filter('run')
    const project = filter('project')
    const branch = filter('branch')
    send(
      res,
      'Artifacts',
      artifactsView(
        {
          db: master.database.db,
          viewer: viewerOf(current),
          now: master.database.now(),
          appVisible: appVisible(master, current),
          artifactBase: origin ?? '',
        },
        {
          ...(run == null ? {} : { run }),
          ...(project == null ? {} : { project }),
          ...(branch == null ? {} : { branch }),
        },
      ),
      current,
      200,
      'artifacts',
    )
  })
  app.get('/runs/:id', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    const actor = sessionActor(current)
    if (!can(actor, 'runs.read')) {
      send(res, 'Run', '<p>Runs are for developers and up.</p>', current, 403)
      return
    }
    const id = String(req.params.id)
    const db = master.database.db
    const run = runData(
      db,
      id,
      (job) => {
        const row = db
          .prepare(
            'SELECT j.workflow,g.graph FROM jobs j LEFT JOIN graphs g ON g.key=j.graph_key WHERE j.id=?',
          )
          .get(job) as { workflow: string; graph: string | null } | undefined
        return row == null ? undefined : graphFromJson(row.graph, row.workflow)
      },
      {
        repository: (project) =>
          (
            db
              .prepare('SELECT repository FROM projects WHERE id=?')
              .get(project) as { repository: string } | undefined
          )?.repository,
        nodeName: (fingerprint) => master.registry.get(fingerprint)?.name,
      },
    )
    if (run == null) {
      send(
        res,
        'Run unavailable',
        '<p class="empty-state">There is no such run.</p>',
        current,
        404,
      )
      return
    }
    const query = (name: string): string | undefined =>
      typeof req.query[name] === 'string'
        ? (req.query[name] as string)
        : undefined
    const stage = run.stages.some((entry) => entry.name === query('stage'))
      ? query('stage')
      : undefined
    const step =
      stage == null || query('step') == null ? undefined : Number(query('step'))
    let log: { text: string; first: number } | { unavailable: string }
    try {
      log = runLog(master, id, {
        ...(stage == null ? {} : { stage }),
        ...(step == null || !Number.isSafeInteger(step) ? {} : { step }),
      }) ?? { unavailable: 'This run has no log.' }
    } catch {
      log = { unavailable: 'There is no such step.' }
    }
    const requester = can(actor, 'runs.request')
    send(
      res,
      `${run.workflow} #${run.number}`,
      runView(run, {
        ...(stage == null ? {} : { selected: stage }),
        ...(step == null || !Number.isSafeInteger(step) ? {} : { step }),
        ...(stage != null && step == null && 'text' in log
          ? { logOffset: Buffer.byteLength(log.text) }
          : {}),
        tab: query('tab') === 'timeline' ? 'timeline' : 'graph',
        now: master.database.now(),
        log,
        can: {
          cancel: requester,
          restart: requester,
          request: requester,
          approve: (name) =>
            can(actor, 'runs.approve') &&
            (current.role === 'admin' ||
              (
                run.graph?.approvals[name]?.roles ?? ['admin', 'manager']
              ).includes(current.role)),
        },
        base: '',
      }),
      current,
      200,
      'dashboard',
    )
  })
  /** A page for those whose role allows an action; others get a 403 page. */
  const guarded = (
    path: string,
    action: Parameters<typeof can>[1],
    title: string,
    active: string,
    body: (
      current: MasterSession,
      req: express.Request,
    ) => Promise<string> | string,
  ): void => {
    app.get(path, (req, res) => {
      const current = session(req)
      if (current == null) {
        res.redirect(303, master.configured() ? '/sign-in' : '/')
        return
      }
      if (!can(sessionActor(current), action)) {
        send(
          res,
          title,
          `<p>${escape(title)} is for those whose role allows it.</p>`,
          current,
          403,
          active,
        )
        return
      }
      void Promise.resolve(body(current, req)).then(
        (content) => {
          send(res, title, content, current, 200, active)
        },
        (error: unknown) => {
          send(
            res,
            title,
            `<p class="state-failed">${escape((error as Error).message)}</p>`,
            current,
            400,
            active,
          )
        },
      )
    })
  }
  guarded('/nodes', 'nodes.read', 'Nodes', 'nodes', async (current) => {
    const busy = cluster(master).nodes
    return nodesView({
      nodes: master.registry.list().map((node) => {
        const details = master.nodeDetails(node.fingerprint) as {
          checklist?: NodeRow['checklist']
          inventory?: NodeRow['inventory'] & { version?: string }
        }
        const stage = master.database.db
          .prepare(
            "SELECT job_id||' '||name AS name FROM job_stages WHERE worker=? AND status='running' LIMIT 1",
          )
          .get(node.fingerprint) as { name: string } | undefined
        return {
          name: node.name,
          fingerprint: node.fingerprint,
          role: node.role,
          type: node.type,
          labels: node.labels,
          slots: node.slots,
          status:
            node.role === 'host'
              ? node.connected
                ? 'idle'
                : 'offline'
              : (busy.find((entry) => entry.name === node.name)?.status ??
                'offline'),
          ...(stage == null ? {} : { stage: stage.name }),
          ...(details.inventory == null
            ? {}
            : { inventory: details.inventory }),
          checklist: details.checklist ?? [],
          ...(node.version == null ? {} : { version: node.version }),
        }
      }),
      types: (master.settings.value('nodeTypes') ?? {}) as Record<
        string,
        unknown
      >,
      pools: master.pools.pools().map((pool) => ({
        ...pool,
        machines: master.pools.machines(pool.name).map((row) => ({
          id: row.id,
          state: row.state,
          address: row.address,
        })),
      })),
      cloudHosts: master.cloudHosts.list().map((row) => ({
        name: row.name,
        state: row.state,
        account: row.account,
        region: row.region,
        size: row.size,
        address: row.address,
        origin: row.origin,
        ...(fqdn(row) == null
          ? {}
          : {
              dnsName: fqdn(row)!,
              certificate:
                row.certificate_at == null
                  ? ('waiting' as const)
                  : ('trusted' as const),
            }),
        error: row.error,
        version: row.version,
        ...(row.space_bucket == null || row.space_region == null
          ? {}
          : { space: { bucket: row.space_bucket, region: row.space_region } }),
      })),
      cloudNodes: master.cloudHosts.list('worker').map((row) => ({
        name: row.name,
        state: row.state,
        account: row.account,
        region: row.region,
        size: row.size,
        address: row.address,
        origin: null,
        error: row.error,
        version: row.version,
        nodeType: row.node_type,
        labels: JSON.parse(row.labels) as string[],
      })),
      storage: ((): {
        driver: 'disk' | 's3'
        bucket?: string
        endpoint?: string
      } => {
        const value = master.settings.value('storage') as
          | { driver?: string; s3?: { bucket: string; endpoint: string } }
          | undefined
        return value?.driver === 's3' && value.s3 != null
          ? {
              driver: 's3',
              bucket: value.s3.bucket,
              endpoint: value.s3.endpoint,
            }
          : { driver: 'disk' }
      })(),
      poolAccounts: await Promise.all(
        master.cloudAccounts.all().map(async (account) => {
          // NoMac has no catalog or DNS: its pools take no region or size.
          if (account.provider === 'nomac')
            return {
              id: account.id,
              name: account.name,
              provider: 'nomac' as const,
            }
          try {
            const catalog = await master.pools.catalog(account.id)
            // A DNS listing that fails leaves the form without domains.
            const domains = await (
              master.cloudHosts.provider(account.id)?.domains?.() ??
              Promise.resolve([])
            ).catch((): string[] => [])
            return {
              id: account.id,
              name: account.name,
              provider: 'digitalocean' as const,
              ...(catalog == null ? {} : { catalog }),
              domains,
            }
          } catch (error) {
            return {
              id: account.id,
              name: account.name,
              error: `Could not list ${account.name}'s regions and sizes: ${(error as Error).message}`,
            }
          }
        }),
      ),
      budget: {
        monthly: Number(
          ((master.settings.value('cloud') ?? {}) as { monthlyBudget?: number })
            .monthlyBudget ?? DEFAULT_MONTHLY_BUDGET,
        ),
        ...(master.pools.notice() == null
          ? {}
          : { notice: master.pools.notice()! }),
      },
      ...(((master.settings.value('host') ?? {}) as { origin?: string })
        .origin == null
        ? {}
        : {
            host: ((master.settings.value('host') ?? {}) as { origin: string })
              .origin,
          }),
      ...(repository == null ? {} : { release: { repository, version } }),
      canChange: can(sessionActor(current), 'nodes.change'),
    })
  })
  guarded('/cloud', 'settings.read', 'Cloud', 'cloud', async (current) => {
    const actor = sessionActor(current)
    return cloudView({
      accounts: await master.cloudAccounts.checked(actor),
      canChange: can(actor, 'settings.change'),
      now: master.database.now(),
    })
  })
  guarded(
    '/settings',
    'settings.read',
    'Settings',
    'settings',
    async (current) => {
      const actor = sessionActor(current)
      const apple = master.apple.status()
      // With the Apple ID signed in, the teams it can set up signing for.
      const stored = (
        (master.settings.value('apple') ?? {}) as {
          teams?: Record<string, { keyId: string; name?: string }>
        }
      ).teams
      const configured = Object.entries(stored ?? {}).map(([id, key]) => {
        const certificate = master.appleSigning.certificates.current(
          id,
          'distribution',
        )
        return {
          id,
          name: key.name ?? id,
          keyId: key.keyId,
          ...(certificate == null
            ? {}
            : {
                certificate: {
                  name: certificate.name,
                  expiresAt: certificate.expiresAt,
                },
              }),
        }
      })
      const setup =
        apple.state !== 'signedIn'
          ? undefined
          : await master.appleSetup.teams().then(
              (teams) => ({
                keyName: master.appleSetup.keyName,
                teams,
                configured,
              }),
              (error: unknown) => ({
                keyName: master.appleSetup.keyName,
                teams: [],
                configured,
                error: (error as Error).message,
              }),
            )
      return settingsView({
        apple: {
          signedIn: apple.state === 'signedIn',
          needsCode: apple.state === 'needsCode',
          ...(apple.appleId == null ? {} : { appleId: apple.appleId }),
          ...(apple.notice == null ? {} : { notice: apple.notice }),
          ...(setup == null ? {} : { setup }),
        },
        keys: can(actor, 'keys.read')
          ? master.keys.list().map((key) => ({
              id: key.id,
              name: key.name,
              role: key.role,
              createdAt: key.createdAt,
              revoked: key.revoked,
              format: key.format,
            }))
          : [],
        ...((): Partial<Parameters<typeof settingsView>[0]> => {
          if (!can(actor, 'settings.change')) return {}
          const github = master.settings.get(actor, 'github')
          const host = master.settings.value('host') as
            | {
                origin?: string
                workerOrigin?: string
                offlineGraceHours?: number
              }
            | undefined
          const storage = master.settings.value('storage') as
            | { driver?: string; s3?: { bucket?: string; endpoint?: string } }
            | undefined
          return {
            github: {
              ...(typeof github.kind === 'string' ? { kind: github.kind } : {}),
              ...(typeof github.appId === 'number'
                ? { appId: github.appId }
                : {}),
              ...(typeof github.installationId === 'number'
                ? { installationId: github.installationId }
                : {}),
              ...(typeof github.publicKey === 'string'
                ? { publicKey: github.publicKey }
                : {}),
            },
            ...(host == null ? {} : { host }),
            storage:
              storage?.driver === 's3'
                ? {
                    driver: 's3',
                    ...(storage.s3?.bucket == null
                      ? {}
                      : { bucket: storage.s3.bucket }),
                    ...(storage.s3?.endpoint == null
                      ? {}
                      : { endpoint: storage.s3.endpoint }),
                  }
                : { driver: 'disk' },
            storageAccounts: master.cloudAccounts.all().map((account) => ({
              id: account.id,
              name: account.name,
              provider: account.provider === 'nomac' ? 'nomac' : 'digitalocean',
            })),
            signIn: methodsOf(master.settings.value('signIn')).map((method) => {
              const view = { ...method } as Record<string, unknown>
              delete view.clientSecret
              return view as unknown as SignInMethodView
            }),
            nodeTypes: Object.fromEntries(
              Object.entries(
                (master.settings.value('nodeTypes') ?? {}) as Record<
                  string,
                  unknown
                >,
              ).flatMap(([name, value]) => {
                const type = storedNodeType(value)
                return type == null ? [] : [[name, type]]
              }),
            ),
            monthlyBudget: Number(
              (
                master.settings.value('cloud') as
                  | { monthlyBudget?: number }
                  | undefined
              )?.monthlyBudget ?? DEFAULT_MONTHLY_BUDGET,
            ),
          }
        })(),
        canChange: can(actor, 'settings.change'),
        canCreate: can(actor, 'keys.create'),
        canRevoke: can(actor, 'keys.revoke'),
      })
    },
  )
  guarded('/people', 'people.read', 'People', 'people', (current) => {
    const actor = sessionActor(current)
    return peopleView({
      people: master.people.list(actor).map((person) => ({
        id: person.id,
        name: person.name,
        role: person.role,
        ...(person.email == null ? {} : { email: person.email }),
        addresses: person.addresses,
        ...(person.username == null ? {} : { username: person.username }),
      })),
      groups: can(actor, 'groups.read') ? master.people.groups(actor) : [],
      canChange: can(actor, 'people.change'),
      canChangeGroups: can(actor, 'groups.change'),
    })
  })
  guarded(
    '/projects/new',
    'projects.change',
    'Add a project',
    'dashboard',
    (_current, req) => {
      const slug =
        typeof req.query.slug === 'string' ? req.query.slug : undefined
      if (slug == null)
        return wizardView({ owned: [], rules: [], webhook: false })
      const project = master.projects.get(slug)
      const found = discovery(master, project.id)
      return wizardView({
        slug,
        repository: project.repository,
        defaultBranch: project.defaultBranch,
        ...(found == null ? {} : { discovery: found }),
        owned: project.apps.map((entry) => entry.bundleId),
        rules: project.rules.map((rule) => ({
          pattern: rule.pattern,
          mode: rule.mode,
        })),
        webhook: project.webhookSecret.set,
      })
    },
  )
  /**
   * The project a project page is about, for a signed-in developer or more;
   * otherwise the page answers (sign-in, 403 or 404) and this returns nothing.
   */
  const projectFor = (
    req: express.Request,
    res: express.Response,
    title: string,
  ):
    | {
        current: MasterSession
        actor: ReturnType<typeof sessionActor>
        project: ReturnType<Master['projects']['get']>
      }
    | undefined => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return undefined
    }
    const actor = sessionActor(current)
    if (!can(actor, 'projects.read')) {
      send(
        res,
        title,
        '<p>Projects are for developers and up.</p>',
        current,
        403,
      )
      return undefined
    }
    try {
      return {
        current,
        actor,
        project: master.projects.get(String(req.params.slug)),
      }
    } catch (error) {
      if (!(error instanceof ProjectNotFound)) throw error
      send(
        res,
        title,
        '<p class="empty-state">There is no such project.</p>',
        current,
        404,
      )
      return undefined
    }
  }
  app.get('/projects/:slug', (req, res, next) => {
    if (req.params.slug === 'new') {
      next()
      return
    }
    const found = projectFor(req, res, 'Project')
    if (found == null) return
    const { current, actor, project } = found
    send(
      res,
      project.name,
      projectView({
        slug: project.slug,
        name: project.name,
        repository: project.repository,
        defaultBranch: project.defaultBranch,
        format: project.format,
        apps: project.apps.map((entry) => ({
          bundleId: entry.bundleId,
          platforms: entry.platforms,
          ...(entry.apple == null ? {} : { apple: { team: entry.apple.team } }),
        })),
        rules: project.rules.map((rule) => ({
          pattern: rule.pattern,
          mode: rule.mode,
        })),
        webhook: project.webhookSecret.set,
        ...(project.signingLabel == null
          ? {}
          : { signingLabel: project.signingLabel }),
        buildNumbers: master.buildNumbers
          .sequences(project.id)
          .map((sequence) => ({
            key: sequence.key,
            format: sequence.scheme.format,
            scope: sequence.scheme.scope,
            last: sequence.last,
          })),
        canSeed: can(actor, 'buildNumbers.seed'),
      }),
      current,
      200,
      'dashboard',
    )
  })
  app.get('/projects/:slug/runs', (req, res) => {
    const found = projectFor(req, res, 'Runs and builds')
    if (found == null) return
    const { current, project } = found
    const branch =
      typeof req.query.branch === 'string' && req.query.branch !== ''
        ? req.query.branch
        : undefined
    const origin = (
      (master.settings.value('host') ?? {}) as { origin?: string }
    ).origin
    send(
      res,
      `${project.name} · Runs and builds`,
      projectRunsView(
        {
          slug: project.slug,
          name: project.name,
          ...(branch == null ? {} : { branch }),
        },
        runsTable(
          {
            db: master.database.db,
            viewer: viewerOf(current),
            now: master.database.now(),
            appVisible: appVisible(master, current),
            artifactBase: origin ?? '',
          },
          { project: project.slug, ...(branch == null ? {} : { branch }) },
        ),
      ),
      current,
      200,
      'dashboard',
    )
  })
  app.get('/projects/:slug/secrets', (req, res) => {
    const found = projectFor(req, res, 'Secrets')
    if (found == null) return
    const { current, actor, project } = found
    const caller = { actor, address: clientAddress(req) }
    send(
      res,
      `${project.name} · Secrets`,
      secretsView({
        slug: project.slug,
        name: project.name,
        format: project.format,
        secrets: project.secrets,
        canChange: can(actor, 'secrets.change'),
        backups: master.backups.status().configured,
        ...(can(actor, 'secrets.read')
          ? { audit: master.secrets.audit(caller, project.slug) }
          : {}),
      }),
      current,
      200,
      'dashboard',
      // The tab's script is for those who may view and change secrets.
      can(actor, 'secrets.read') ? ['/assets/secrets.js'] : [],
    )
  })
  app.get('/projects/:slug/masonfile', (req, res, next) => {
    // The wizard's path is not a project.
    if (req.params.slug === 'new') {
      next()
      return
    }
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), 'projects.read')) {
      send(
        res,
        'Masonfile',
        '<p>The Masonfile is for developers and up.</p>',
        current,
        403,
      )
      return
    }
    const slug = String(req.params.slug)
    let project
    try {
      project = master.projects.get(slug)
    } catch {
      send(
        res,
        'Masonfile',
        '<p class="empty-state">There is no such project.</p>',
        current,
        404,
      )
      return
    }
    const commits = master.database.db
      .prepare(
        'SELECT commit_sha AS sha,branch FROM (SELECT commit_sha,branch,ROW_NUMBER() OVER (PARTITION BY commit_sha ORDER BY created DESC) AS place,created FROM jobs WHERE project_id=? AND commit_sha IS NOT NULL) WHERE place=1 ORDER BY created DESC LIMIT 30',
      )
      .all(project.id) as Array<{ sha: string; branch: string }>
    const commit =
      typeof req.query.commit === 'string' ? req.query.commit : commits[0]?.sha
    const file = project.entrypoint ?? 'Masonfile.ts'
    const render = (extra: { text?: string; error?: string }): void => {
      send(
        res,
        `${project.name} · Masonfile`,
        masonfileView({
          slug,
          name: project.name,
          commits,
          ...(commit == null ? {} : { commit }),
          file,
          ...extra,
        }),
        current,
        200,
        'dashboard',
      )
    }
    if (commit == null) {
      render({ error: 'No run has a commit yet.' })
      return
    }
    master.mirrors.show(slug, project.repository, commit, file).then(
      (text) => {
        render(
          text == null ? { error: `${file} is not in that commit.` } : { text },
        )
      },
      (error: unknown) => {
        render({ error: (error as Error).message })
      },
    )
  })
  app.get('/search', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.status(401).json([])
      return
    }
    res.json(
      search(
        {
          db: master.database.db,
          viewer: viewerOf(current),
          appVisible: appVisible(master, current),
        },
        typeof req.query.q === 'string' ? req.query.q : '',
      ),
    )
  })
  app.get('/sign-in', (req, res) => {
    if (!master.configured()) {
      res.redirect(303, '/')
      return
    }
    if (session(req) != null) {
      res.redirect(303, '/')
      return
    }
    hashing(res)
    send(res, 'Sign in', signInPage)
  })
  app.get('/backups', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), 'settings.read')) {
      send(
        res,
        'Backups',
        '<p>Backups are for managers and administrators.</p>',
        current,
        403,
      )
      return
    }
    send(res, 'Backups', backupsPage(master, current), current, 200, 'backups')
  })
  // Every other page needs a signed-in user once the master is set up.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next()
      return
    }
    if (!master.configured()) {
      next()
      return
    }
    if (session(req) == null) {
      res.redirect(303, '/sign-in')
      return
    }
    next()
  })
}
