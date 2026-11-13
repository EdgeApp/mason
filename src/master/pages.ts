import { locationsWithUsage } from './storageApi.js'
import type express from 'express'
import { cookie } from '../auth/routes.js'
import {
  masterContentSecurityPolicy,
  testBanner,
  type WebAppContext,
} from '../node/webApp.js'
import { escape } from '../view/html.js'
import {
  groupsView,
  groupView,
  head,
  nodesView,
  accountView,
  peopleView,
  type PersonRow,
  cloudView,
  settingsView,
  type SignInMethodView,
  type NodeRow,
} from '../view/admin.js'
import { fqdn } from './cloud/hosts.js'
import { DEFAULT_MONTHLY_BUDGET } from './cloud/pools.js'
import { methodsOf } from './hostSettings.js'
import { nodeTypesView } from './nodeTypes.js'
import {
  approvalNotifications,
  notificationsFor,
} from '../view/notifications.js'
import { search } from '../view/search.js'
import { shell, type Viewer } from '../view/shell.js'
import { apps } from './adminApi.js'
import { MASTER_SESSION_COOKIE, type MasterSession } from './auth.js'
import { can } from './permissions.js'
import type { Person } from './people.js'
import { sessionActor } from './auth.js'
import type { Master } from './runtime.js'
import { repository, version } from '../version.js'
import { ProjectNotFound, type Project } from './projects.js'
import { masterCatalogPages } from './catalogPages.js'
import {
  appleSigning,
  appVisibleTo,
  backupNotice,
  cluster,
  runningStage,
  workerStatus,
} from './reads.js'
import { sendShell } from '../node/webRoutes.js'

/** A person as the People page and Your account draw them. */
function personRow(person: Person): PersonRow {
  return {
    id: person.id,
    name: person.name,
    role: person.role,
    emails: person.emails,
    ...(person.username == null ? {} : { username: person.username }),
    disabled: person.disabled,
    password: person.password,
    ...(person.invitation == null ? {} : { invitation: person.invitation }),
  }
}

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
  const notice =
    session == null ? undefined : backupNotice(master, sessionActor(session))
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
  return appVisibleTo(master, sessionActor(session))
}

const status = '<p class="notice" role="status" data-field="status" hidden></p>'

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
  return `${head(viewerOf(session), 'Backups', 'Encrypted copies of this master, kept in a git repository.', [{ label: 'Backups', href: '/backups' }])}<section class="card"><p>Every hour the master encrypts a snapshot of its database and pushes it to a git repository. Add the deploy key below to that repository with write access.</p>${state}<form data-mason="backup"><label for="repository">Repository</label><input id="repository" name="repository" value="${escape(value.repository ?? '')}" placeholder="git@github.com:owner/mason-backup.git" required><label for="branch">Branch</label><input id="branch" name="branch" value="${escape(value.branch ?? 'master')}" required><p><button>Save</button></p><p>Deploy key</p><pre data-field="deployKey"${value.deployKey == null ? ' hidden' : ''}>${escape(value.deployKey?.publicKey ?? '')}</pre><pre data-field="backupKey" hidden></pre>${status}</form><p><a href="/?later=backups">Skip for now</a></p></section>${key}`
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
  app.get('/', (req, res, next) => {
    // First-run setup and restore are the web app's.
    if (!master.configured()) {
      sendShell(res)
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
    // The master opens on Projects & apps for developers and up; a tester's
    // home is Install apps, from the host.
    if (current.role !== 'tester') {
      sendShell(res)
      return
    }
    next()
  })
  // Projects are for developers and up: to a tester they do not exist.
  app.use('/projects', (req, res, next) => {
    const current = session(req)
    if (current?.role !== 'tester') {
      next()
      return
    }
    send(
      res,
      'Not found',
      '<p class="empty-state">There is no such page.</p>',
      current,
      404,
      'catalog',
    )
  })
  // Projects & apps and Artifacts are the web app's; a tester reads the
  // 403 inside it on Artifacts (and the 404 above on Projects).
  app.get(['/projects', '/artifacts'], (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    sendShell(res, current.role === 'tester' ? { status: 403 } : {})
  })
  // The run page is the web app's: a tester reads its 403 inside it, and a
  // run that does not exist its unknown-run state, each with that status.
  app.get('/runs/:id', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), 'runs.read')) {
      sendShell(res, { status: 403 })
      return
    }
    sendShell(
      res,
      master.jobs.job(String(req.params.id)) == null ? { status: 404 } : {},
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
    /** Whether the page hashes passwords in the browser. */
    passwords = false,
    /** The page's own scripts, beside the shell's. */
    scripts: string[] = [],
  ): void => {
    app.get(path, (req, res) => {
      if (passwords) hashing(res)
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
          send(res, title, content, current, 200, active, scripts)
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
    return nodesView({
      nodes: master.registry.list().map((node) => {
        const details = master.nodeDetails(node.fingerprint) as {
          checklist?: NodeRow['checklist']
          inventory?: NodeRow['inventory'] & { version?: string }
        }
        const stage = runningStage(master, node.fingerprint)
        return {
          name: node.name,
          fingerprint: node.fingerprint,
          role: node.role,
          type: node.type,
          labels: node.labels,
          slots: node.slots,
          status: workerStatus(master, node),
          ...(stage == null ? {} : { stage }),
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
      storage: {
        ...((): {
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
        locations: await locationsWithUsage(master),
      },
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
              adminKeyed: account.adminKeyed === true,
            }
          } catch (error) {
            return {
              id: account.id,
              name: account.name,
              error: `Could not list ${account.name}'s regions and sizes: ${(error as Error).message}`,
              adminKeyed: account.adminKeyed === true,
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
      canChangeHosts: can(sessionActor(current), 'hosts.change'),
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
      return settingsView({
        apple: await appleSigning(master),
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
        ...(await (async (): Promise<
          Partial<Parameters<typeof settingsView>[0]>
        > => {
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
            storage: {
              ...(storage?.driver === 's3'
                ? {
                    driver: 's3' as const,
                    ...(storage.s3?.bucket == null
                      ? {}
                      : { bucket: storage.s3.bucket }),
                    ...(storage.s3?.endpoint == null
                      ? {}
                      : { endpoint: storage.s3.endpoint }),
                  }
                : { driver: 'disk' as const }),
              locations: await locationsWithUsage(master),
            },
            storageAccounts: master.cloudAccounts.all().map((account) => ({
              id: account.id,
              name: account.name,
              provider: account.provider === 'nomac' ? 'nomac' : 'digitalocean',
            })),
            master: (master.settings.value('master') ?? {}) as {
              origin?: string
            },
            signIn: methodsOf(master.settings.value('signIn')).map((method) => {
              const view = { ...method } as Record<string, unknown>
              delete view.clientSecret
              return view as unknown as SignInMethodView
            }),
            nodeTypes: nodeTypesView(
              (master.settings.value('nodeTypes') ?? {}) as Record<
                string,
                unknown
              >,
            ),
            monthlyBudget: Number(
              (
                master.settings.value('cloud') as
                  | { monthlyBudget?: number }
                  | undefined
              )?.monthlyBudget ?? DEFAULT_MONTHLY_BUDGET,
            ),
          }
        })()),
        canChange: can(actor, 'settings.change'),
        canChangeSignIn: can(actor, 'signIn.change'),
        canCreate: can(actor, 'keys.create'),
        canRevoke: can(actor, 'keys.revoke'),
      })
    },
  )
  // Your account: everyone's own record, behind the top-right account icon.
  app.get('/account', (req, res) => {
    hashing(res)
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    const actor = sessionActor(current)
    send(
      res,
      'Your account',
      accountView({
        viewer: viewerOf(current),
        person: personRow(master.people.get(actor, actor.accountId!)),
        signOut: viewerOf(current).signOut,
        editable: true,
      }),
      current,
      200,
      'account',
      ['/assets/people.js'],
    )
  })
  guarded(
    '/people',
    'people.read',
    'People',
    'people',
    (current) => {
      const actor = sessionActor(current)
      return peopleView({
        people: master.people.list(actor).map(personRow),
        now: master.database.now(),
        canChange: can(actor, 'people.change'),
        ...(actor.accountId == null ? {} : { viewerId: actor.accountId }),
      })
    },
    true,
    ['/assets/people.js'],
  )
  guarded('/groups', 'groups.read', 'Groups', 'groups', (current) => {
    const actor = sessionActor(current)
    return groupsView({
      groups: master.people
        .groups(actor)
        .map((group) => ({ id: group.id, name: group.name })),
      canChange: can(actor, 'groups.change'),
    })
  })
  // Not `guarded`: an unknown group answers 404, where `guarded` answers 400.
  app.get('/groups/:id', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    const actor = sessionActor(current)
    if (!can(actor, 'groups.read')) {
      send(
        res,
        'Groups',
        '<p>Groups is for those whose role allows it.</p>',
        current,
        403,
        'groups',
      )
      return
    }
    const id = String(req.params.id)
    const group = /^[1-9]\d{0,15}$/.test(id)
      ? master.people.group(Number(id))
      : undefined
    if (group == null) {
      send(
        res,
        'Groups',
        '<p class="empty-state">No such group</p>',
        current,
        404,
        'groups',
      )
      return
    }
    send(
      res,
      group.name,
      groupView({
        group: {
          id: group.id,
          name: group.name,
          apps: group.apps.map((app) => app.id),
          members: group.members,
        },
        apps: apps(master),
        people: master.people.list(actor).map((person) => ({
          id: person.id,
          name: person.name,
          emails: person.emails.map((entry) => entry.email),
        })),
        canChange: can(actor, 'groups.change'),
      }),
      current,
      200,
      'groups',
      ['/assets/groups.js'],
    )
  })
  // A project's pages are the web app's: a role without projects.read reads
  // their 403 inside it, and a project (or one of its app IDs) that does not
  // exist its unknown state, each with that status. The add-project wizard
  // is for those who may change projects.
  const projectShell = (
    req: express.Request,
    res: express.Response,
    action: 'projects.read' | 'projects.change',
    exists: () => boolean,
  ): void => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), action)) {
      sendShell(res, { status: 403 })
      return
    }
    sendShell(res, exists() ? {} : { status: 404 })
  }
  /** The enabled project at `:slug`, if any. */
  const projectAt = (req: express.Request): Project | undefined => {
    try {
      return master.projects.get(String(req.params.slug))
    } catch (error) {
      if (!(error instanceof ProjectNotFound)) throw error
      return undefined
    }
  }
  app.get('/projects/new', (req, res) => {
    projectShell(req, res, 'projects.change', () => true)
  })
  app.get(
    [
      '/projects/:slug',
      '/projects/:slug/runs',
      '/projects/:slug/masonfile',
      '/projects/:slug/secrets',
    ],
    (req, res) => {
      projectShell(req, res, 'projects.read', () => projectAt(req) != null)
    },
  )
  app.get(
    [
      '/projects/:slug/apps/:appId',
      '/projects/:slug/apps/:appId/build-numbers',
    ],
    (req, res) => {
      projectShell(req, res, 'projects.read', () => {
        const project = projectAt(req)
        const app = project?.apps.find(
          (entry) => entry.bundleId === String(req.params.appId),
        )
        const current = session(req)!
        return (
          app != null &&
          master.database.db
            .prepare('SELECT 1 FROM apps WHERE id=? AND enabled=1')
            .get(app.id) != null &&
          appVisible(master, current)(app.id)
        )
      })
    },
  )
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
  // Install apps and Devices, from the host over the link.
  masterCatalogPages(app, master, session, send)
  app.get('/sign-in', (req, res) => {
    if (!master.configured()) {
      res.redirect(303, '/')
      return
    }
    if (session(req) != null) {
      res.redirect(303, '/')
      return
    }
    sendShell(res)
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
