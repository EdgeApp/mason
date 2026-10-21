import { randomBytes } from 'node:crypto'
import express, { Router } from 'express'
import type { Graph } from '../pipeline/graph.js'
import { actorOf, apiErrors, authenticate, json, NotFound } from './api.js'
import { allowRole } from './permissions.js'
import { repositoryName } from './mirrors.js'
import type { Master } from './runtime.js'
import { DISCOVER } from './scheduler.js'

/** An app ID a Masonfile declares, with the platforms its stages build it for. */
export interface DeclaredApp {
  bundleId: string
  platforms: string[]
  /** The Apple bundle IDs its stages sign, when they name them. */
  bundleIds?: string[]
}

const applePlatform: Record<string, string> = {
  development: 'ios',
  adHoc: 'ios',
  appStore: 'ios',
  developerId: 'macos',
  macAppStore: 'macos',
}

/**
 * The app IDs a graph's stages publish or sign, across every workflow, and
 * the platforms they build them for: Apple distributions name iOS or macOS,
 * a stage that installs the Android SDK builds Android, a stage on Windows
 * builds Windows.
 */
export function declaredApps(graph: Graph): DeclaredApp[] {
  const apps = new Map<
    string,
    { platforms: Set<string>; bundleIds: Set<string> }
  >()
  const entry = (
    id: string,
  ): { platforms: Set<string>; bundleIds: Set<string> } => {
    const found = apps.get(id) ?? { platforms: new Set(), bundleIds: new Set() }
    apps.set(id, found)
    return found
  }
  for (const workflow of graph.workflows)
    for (const stage of [...workflow.stages, ...workflow.post]) {
      const platforms = new Set<string>()
      if (stage.apple != null)
        platforms.add(applePlatform[stage.apple.distribution] ?? 'ios')
      if ((stage.tools?.android?.length ?? 0) > 0) platforms.add('android')
      const os = typeof stage.on === 'object' ? stage.on?.os : undefined
      if (os === 'windows') platforms.add('windows')
      const ids = new Set([
        ...stage.publishes,
        ...(stage.apple?.app == null ? [] : [stage.apple.app]),
      ])
      for (const id of ids) {
        const found = entry(id)
        for (const platform of platforms) found.platforms.add(platform)
        if (stage.apple?.app === id)
          for (const bundleId of stage.apple.bundleIds ?? [])
            found.bundleIds.add(bundleId)
      }
    }
  // A sequence keyed by an app ID (`m.buildNumber('app.example.phone')`) names it too.
  const looksLikeApp = (key: string): boolean =>
    /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(key)
  for (const key of Object.keys(graph.buildNumbers))
    if (looksLikeApp(key)) entry(key)
  for (const workflow of graph.workflows)
    for (const stage of [...workflow.stages, ...workflow.post])
      for (const key of stage.buildNumbers) if (looksLikeApp(key)) entry(key)
  return [...apps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bundleId, found]) => ({
      bundleId,
      platforms: [...found.platforms].sort(),
      ...(found.bundleIds.size === 0
        ? {}
        : { bundleIds: [...found.bundleIds].sort() }),
    }))
}

/** A project slug from a repository: its name, lower case. */
export function slugFor(repository: string): string {
  return repositoryName(repository)
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** The latest discovery run of a project, and what its graph declares. */
export function discovery(
  master: Master,
  projectId: number,
):
  | {
      run: string
      status: string
      reason: string | null
      apps?: DeclaredApp[]
      triggers?: Record<string, unknown[]>
    }
  | undefined {
  const row = master.database.db
    .prepare(
      'SELECT j.id,j.status,j.reason,g.graph FROM jobs j LEFT JOIN graphs g ON g.key=j.graph_key WHERE j.project_id=? AND j.workflow=? ORDER BY j.created DESC LIMIT 1',
    )
    .get(projectId, DISCOVER) as
    | {
        id: string
        status: string
        reason: string | null
        graph: string | null
      }
    | undefined
  if (row == null) return undefined
  const graph = row.graph == null ? undefined : (JSON.parse(row.graph) as Graph)
  return {
    run: row.id,
    status: row.status,
    reason: row.reason,
    ...(graph == null
      ? {}
      : {
          apps: declaredApps(graph),
          triggers: Object.fromEntries(
            graph.workflows.map((workflow) => [
              workflow.name,
              workflow.triggers,
            ]),
          ),
        }),
  }
}

/** The add-project wizard's API and a project's Masonfile at a commit, for managers and administrators. */
export function wizardApi(master: Master): Router {
  const router = Router()
  router.use(
    ['/api/v2/projects'],
    express.json({ limit: '64kb', strict: true }),
    authenticate(master),
  )
  const project = (
    slug: string,
  ): { id: number; repository: string; defaultBranch: string } => {
    const row = master.database.db
      .prepare('SELECT id,repository,default_branch FROM projects WHERE slug=?')
      .get(slug) as
      | { id: number; repository: string; default_branch: string }
      | undefined
    if (row == null) throw new NotFound('No such project')
    return {
      id: row.id,
      repository: row.repository,
      defaultBranch: row.default_branch,
    }
  }
  // 1. Repository: the master reads it with its own credentials.
  router.post(
    '/api/v2/projects/check',
    json(async (req, res) => {
      allowRole(actorOf(res), 'projects.change')
      const repository = String(
        (req.body as { repository?: unknown }).repository ?? '',
      ).trim()
      repositoryName(repository)
      return {
        repository,
        slug: slugFor(repository),
        defaultBranch: await master.mirrors.defaultBranch(repository),
      }
    }),
  )
  // 2. Apps: a discovery run reads the Masonfile on the default branch.
  router.post(
    '/api/v2/projects/:slug/discover',
    json((req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'projects.change')
      const found = project(String(req.params.slug))
      const job = master.jobs.create(
        master.projects.get(String(req.params.slug)),
        found.defaultBranch,
        'request',
        {
          workflow: DISCOVER,
        },
      )
      master.scheduler.poke()
      master.database.audit(actor, 'project.discover', String(req.params.slug))
      res.status(202)
      return { run: job.id }
    }),
  )
  router.get(
    '/api/v2/projects/:slug/discover',
    json((req, res) => {
      allowRole(actorOf(res), 'projects.change')
      return discovery(master, project(String(req.params.slug)).id) ?? null
    }),
  )
  router.post(
    '/api/v2/projects/:slug/wizard/apps',
    json((req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'projects.change')
      const slug = String(req.params.slug)
      const body = req.body as { apps?: unknown; team?: unknown }
      const chosen = String(body.apps ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      const team =
        typeof body.team === 'string' && body.team.trim() !== ''
          ? body.team.trim()
          : undefined
      const declared = discovery(master, project(slug).id)?.apps ?? []
      for (const bundleId of chosen) {
        const app = declared.find((entry) => entry.bundleId === bundleId)
        if (app == null)
          throw new Error(`The Masonfile does not declare ${bundleId}`)
        const apple = app.platforms.some(
          (platform) => platform === 'ios' || platform === 'macos',
        )
        master.projects.addApp(actor, slug, {
          bundleId,
          name: bundleId,
          platforms: app.platforms.length === 0 ? ['ios'] : app.platforms,
          ...(apple && team != null
            ? {
                apple: {
                  team,
                  ...(app.bundleIds == null
                    ? {}
                    : { bundleIds: app.bundleIds }),
                },
              }
            : {}),
        })
      }
      return master.projects.get(slug)
    }),
  )
  // 3. Branches and triggers: rules as lines of "pattern automatic|request".
  router.post(
    '/api/v2/projects/:slug/wizard/rules',
    json((req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'projects.change')
      const rules = String((req.body as { rules?: unknown }).rules ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [pattern, mode = 'request'] = line.split(/\s+/)
          return { pattern: pattern!, mode }
        })
      master.projects.setRules(actor, String(req.params.slug), rules)
      return master.projects.get(String(req.params.slug))
    }),
  )
  router.post(
    '/api/v2/projects/:slug/webhook',
    json(async (req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'projects.change')
      const slug = String(req.params.slug)
      const found = project(slug)
      const origin = (
        (master.settings.value('host') ?? {}) as { origin?: string }
      ).origin
      if (origin == null)
        throw new Error('Set the host’s origin first: GitHub posts to the host')
      let secret = master.projects.webhookSecret(found.id)
      if (secret == null) {
        secret = randomBytes(24).toString('hex')
        master.projects.save(actor, slug, { webhookSecret: secret })
      }
      const url = `${origin}/api/webhooks/github/${encodeURIComponent(slug)}`
      const created = await master.github.createWebhook(
        found.repository,
        url,
        secret,
      )
      master.database.audit(actor, 'project.webhook', slug)
      return { created, url }
    }),
  )
  router.get(
    '/api/v2/projects/:slug/masonfile',
    json(async (req, res) => {
      allowRole(actorOf(res), 'projects.read')
      const slug = String(req.params.slug)
      const found = project(slug)
      const commit = String(req.query.commit ?? '')
      const entry = master.projects.get(slug).entrypoint ?? 'Masonfile.ts'
      const text = await master.mirrors.show(
        slug,
        found.repository,
        commit,
        entry,
      )
      if (text == null) throw new NotFound(`${entry} is not in that commit`)
      return { commit, file: entry, text }
    }),
  )
  router.use('/api/v2/projects', apiErrors)
  return router
}
