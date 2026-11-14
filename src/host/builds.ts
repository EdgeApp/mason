import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from 'express'
import type { Accounts } from '../auth/accounts.js'
import { sessionContext } from '../auth/routes.js'
import { formatTypes } from '../catalog/install.js'
import type { Stream } from '../link/link.js'
import {
  creatorLimitedRole,
  digestMatches,
  tokenLookup,
} from '../master/keys.js'
import { allowRole, covers, scoped } from '../master/permissions.js'
import { shownLabel } from '../master/requesters.js'
import { asRole, Forbidden, type Role } from '../master/roles.js'
import {
  asFormat,
  asPlatform,
  asVariant,
  integer,
  text,
  type Format,
  type Platform,
} from '../validation.js'
import type { HostObjects } from './artifacts.js'
import type { HostCache } from './cache.js'
import type { BuildView as SharedBuildView } from '../shared/api/builds.js'

/** How long a signed Space URL for a download lasts. */
export const SIGNED_URL_SECONDS = 300

/**
 * Who reads builds: a key, a host session, or the caller the master relays
 * for. A tester sees its `account`'s groups' apps; developers and up see
 * every app; a key's scopes limit both.
 */
export interface BuildsViewer {
  role: Role
  /** The account whose groups a tester sees: the session's, or a key's creator. */
  account?: number
  /** A key's project and branch scopes; empty lists mean no limit. */
  scopes?: { projects: string[]; branches: string[] }
  /** For the download log: `account:<id>` or `key:<id>`. */
  label: string
}

/** A refusal with its HTTP status; its message is the answer's `error`. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const NO_SUCH_BUILD = 'No such build'
const OUT_OF_SCOPE = 'This key does not cover that project or branch'

/**
 * The status and message a thrown error answers with: a refusal's own, 403
 * for a role or scope, and 500 for anything the host did not expect, which
 * is not the caller's fault.
 */
export function refusal(error: unknown): { status: number; error: string } {
  if (error instanceof Refused)
    return { status: error.status, error: error.message }
  if (error instanceof Forbidden) return { status: 403, error: error.message }
  return { status: 500, error: 'The host could not answer the request' }
}

const strings = (value: unknown, field: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length > 200)
  )
    throw new Refused(400, `Invalid viewer ${field}`)
  return value as string[]
}

/** A viewer the master sends over the link, checked field by field; 400 when it is not one. */
export function asViewer(value: unknown): BuildsViewer {
  const input = (value ?? {}) as Record<string, unknown>
  let role: Role
  try {
    role = asRole(input.role)
  } catch {
    throw new Refused(400, 'Invalid viewer role')
  }
  const account = input.account
  if (
    account != null &&
    (!Number.isSafeInteger(account) || Number(account) < 1)
  )
    throw new Refused(400, 'Invalid viewer account')
  const label = input.label
  if (typeof label !== 'string' || label.length === 0 || label.length > 200)
    throw new Refused(400, 'Invalid viewer label')
  const scopes = input.scopes as
    | { projects?: unknown; branches?: unknown }
    | undefined
  return {
    role,
    label,
    ...(account == null ? {} : { account: Number(account) }),
    ...(scopes == null
      ? {}
      : {
          scopes: {
            projects: strings(scopes.projects, 'projects'),
            branches: strings(scopes.branches, 'branches'),
          },
        }),
  }
}

/** What a list asks for. */
export interface BuildsQuery {
  project?: string
  app?: string
  branch?: string
  platform?: Platform
  /** `''` is the default variant. */
  variant?: string
  /** The run that published it. */
  run?: string
  latest: boolean
  limit: number
}

/** The list's query: each field once, as text; anything else is 400. */
export function asBuildsQuery(value: unknown): BuildsQuery {
  const input = (value ?? {}) as Record<string, unknown>
  const field = <T>(name: string, clean: (raw: string) => T): T | undefined => {
    const raw = input[name]
    if (raw == null) return undefined
    if (typeof raw !== 'string')
      throw new Refused(400, `Give ${name} once, as text`)
    try {
      return clean(raw)
    } catch {
      throw new Refused(400, `Invalid ${name}`)
    }
  }
  const project = field('project', text(160))
  const app = field('app', text(160))
  const branch = field('branch', text(256))
  const platform = field('platform', asPlatform)
  const variant = field('variant', asVariant)
  const run = field('run', text(64))
  const latest = field('latest', (raw) => {
    if (raw === '1' || raw === 'true') return true
    if (raw === '0' || raw === 'false') return false
    throw new Error('latest')
  })
  const limit = field('limit', (raw) =>
    integer(1, 500)(/^\d+$/.test(raw) ? Number(raw) : NaN),
  )
  return {
    ...(project == null ? {} : { project }),
    ...(app == null ? {} : { app }),
    ...(branch == null ? {} : { branch }),
    ...(platform == null ? {} : { platform }),
    ...(variant == null ? {} : { variant }),
    ...(run == null ? {} : { run }),
    latest: latest ?? false,
    limit: limit ?? 50,
  }
}

/** A published build as the API answers it: the shared contract's, with its format typed. */
export interface BuildView extends SharedBuildView {
  format: Format
}

interface Row {
  id: number
  app_id: number
  app_slug: string
  app_name: string
  project_slug: string | null
  branch: string
  platform: string
  variant: string | null
  version: string
  build_number: string
  commit_hash: string
  bundle_id: string
  format: string
  size: number
  digest: string
  file_key: string
  published_at: number
  expires_at: number
  run: string | null
}

function view(row: Row): BuildView {
  return {
    id: Number(row.id),
    app: row.app_slug,
    appName: row.app_name,
    project: row.project_slug ?? null,
    branch: row.branch,
    platform: asPlatform(row.platform),
    variant: row.variant ?? '',
    version: row.version,
    buildNumber: row.build_number,
    commit: row.commit_hash,
    bundleId: row.bundle_id,
    format: asFormat(row.format),
    size: Number(row.size),
    digest: row.digest,
    publishedAt: Number(row.published_at),
    expiresAt: Number(row.expires_at),
    run: row.run ?? null,
    download: `/api/v2/builds/${row.id}/download`,
  }
}

/** The file name a download is saved as: app, version, build number and variant. */
export function fileName(build: BuildView): string {
  return `${build.app}-${build.version}-${build.buildNumber}${build.variant === '' ? '' : `-${build.variant}`}.${build.format}`.replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  )
}

/** What a download answers: its status, its headers, and its bytes or JSON. */
export interface Delivery {
  status: number
  headers: Record<string, string>
  json?: unknown
  open?: () => Promise<Readable>
}

const JSON_TYPE = 'application/json; charset=utf-8'

function refusedDelivery(error: unknown): Delivery {
  const { status, error: message } = refusal(error)
  return {
    status,
    headers: { 'Content-Type': JSON_TYPE },
    json: { error: message },
  }
}

export interface HostBuildsOptions {
  cache: HostCache
  objects: HostObjects
  now: () => number
  /** Past the grace window the host serves nothing. */
  maintenance: () => boolean
  log?: (line: string) => void
}

/**
 * The builds API on the host: lists, single builds and downloads from the
 * cache and storage, for keys (verified against the digests the master
 * replicates), host sessions, and callers the master relays for.
 */
export class HostBuilds {
  constructor(private readonly options: HostBuildsOptions) {}

  private get db(): HostCache['db'] {
    return this.options.cache.db
  }

  /** 503 before the first sync and past the grace window. */
  ready(): void {
    if (this.options.cache.host() == null)
      throw new Refused(503, 'This Mason host is waiting for its master')
    if (this.options.maintenance())
      throw new Refused(
        503,
        'This Mason host has not reached its master for too long to serve builds',
      )
  }

  /**
   * The viewer a bearer token is: its key's role, no higher than its
   * creator's, with its scopes; refused like the master refuses it.
   */
  keyViewer(header: string): BuildsViewer {
    const lookup = tokenLookup(/^Bearer (\S+)$/.exec(header)?.[1])
    const unknown = new Refused(401, 'An API key is required')
    if (lookup == null) throw unknown
    const row = (
      lookup.by === 'id'
        ? this.db
            .prepare("SELECT * FROM host_keys WHERE id=? AND format='v1'")
            .get(lookup.id)
        : this.db
            .prepare(
              "SELECT * FROM host_keys WHERE hash=? AND format='builder'",
            )
            .get(lookup.digest)
    ) as
      | {
          id: string
          hash: string
          role: string
          projects: string
          branches: string
          creator: number | null
          expires_at: number | null
        }
      | undefined
    const matches = digestMatches(lookup.digest, row?.hash)
    if (row == null || !matches) {
      // Upgraded to a cache that keeps keys, the host has none until its
      // first sync since: it is waiting, not refusing the key.
      if (!this.options.cache.keysSynced())
        throw new Refused(503, 'This Mason host is waiting for its master')
      throw unknown
    }
    if (row.expires_at != null && row.expires_at <= this.options.now())
      throw unknown
    const role = creatorLimitedRole(
      asRole(row.role),
      row.creator,
      row.creator == null
        ? undefined
        : (this.db
            .prepare('SELECT role,disabled FROM accounts WHERE id=?')
            .get(row.creator) as
            | { role: string; disabled: number }
            | undefined),
    )
    return {
      role,
      label: `key:${row.id}`,
      ...(row.creator == null ? {} : { account: Number(row.creator) }),
      scopes: {
        projects: JSON.parse(row.projects) as string[],
        branches: JSON.parse(row.branches) as string[],
      },
    }
  }

  /** The caller of a request on the host: a key, else its host session. */
  viewer(req: Request, accounts: Accounts): BuildsViewer {
    const header = req.get('authorization')
    if (header != null) return this.keyViewer(header)
    const context = sessionContext(req, accounts)
    if (context == null) throw new Refused(401, 'Sign in or use an API key')
    const row = this.db
      .prepare('SELECT role FROM accounts WHERE id=?')
      .get(context.account.id) as { role: string } | undefined
    return {
      role: asRole(row?.role),
      account: context.account.id,
      label: `account:${context.account.id}`,
    }
  }

  private rows(
    filter: Partial<
      Pick<
        BuildsQuery,
        'project' | 'app' | 'branch' | 'platform' | 'variant' | 'run'
      >
    > & {
      id?: number
    },
  ): IterableIterator<Row> {
    const optional = (
      value: string | number | undefined,
    ): string | number | null => value ?? null
    return this.db
      .prepare(
        `SELECT b.id,b.app_id,a.slug AS app_slug,a.name AS app_name,p.slug AS project_slug,b.branch,b.platform,b.variant,b.version,b.build_number,b.commit_hash,b.bundle_id,b.format,b.size,b.digest,b.file_key,b.published_at,b.expires_at,b.run
        FROM builds b JOIN apps a ON a.id=b.app_id JOIN channels c ON c.id=b.channel_id
        LEFT JOIN project_apps pa ON pa.app_id=b.app_id LEFT JOIN projects p ON p.id=pa.project_id
        WHERE b.state='ready' AND b.expires_at>?7 AND a.enabled=1 AND c.enabled=1
        AND (?1 IS NULL OR b.id=?1) AND (?2 IS NULL OR p.slug=?2) AND (?3 IS NULL OR a.slug=?3)
        AND (?4 IS NULL OR b.branch=?4) AND (?5 IS NULL OR b.platform=?5) AND (?6 IS NULL OR COALESCE(b.variant,'')=?6) AND (?8 IS NULL OR b.run=?8)
        ORDER BY b.published_at DESC,b.id DESC`,
      )
      .iterate(
        optional(filter.id),
        optional(filter.project),
        optional(filter.app),
        optional(filter.branch),
        optional(filter.platform),
        optional(filter.variant),
        this.options.now(),
        optional(filter.run),
      ) as unknown as IterableIterator<Row>
  }

  private visible(viewer: BuildsViewer): (row: Row) => boolean {
    const apps = this.options.cache.appsFor(viewer.role, viewer.account)
    return (row) => apps === 'all' || apps.has(Number(row.app_id))
  }

  private covered(viewer: BuildsViewer, row: Row): boolean {
    return covers(viewer, {
      ...(row.project_slug == null ? {} : { project: row.project_slug }),
      branch: row.branch,
    })
  }

  /** The builds a viewer may see, newest first, filtered, at most `limit`. */
  list(viewer: BuildsViewer, value: unknown): BuildView[] {
    allowRole(viewer, 'builds.read')
    const query = asBuildsQuery(value)
    if (
      query.project != null &&
      scoped(viewer) &&
      !covers(viewer, {
        project: query.project,
        ...(query.branch == null ? {} : { branch: query.branch }),
      })
    )
      throw new Forbidden(OUT_OF_SCOPE)
    const visible = this.visible(viewer)
    const seen = new Set<string>()
    const out: BuildView[] = []
    for (const row of this.rows(query)) {
      if (!visible(row) || !this.covered(viewer, row)) continue
      if (query.latest) {
        const group = JSON.stringify([
          row.app_id,
          row.branch,
          row.platform,
          row.variant ?? '',
        ])
        if (seen.has(group)) continue
        seen.add(group)
      }
      out.push(view(row))
      if (out.length >= query.limit) break
    }
    return out
  }

  private find(viewer: BuildsViewer, id: unknown): Row {
    allowRole(viewer, 'builds.read')
    const number =
      typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id
    if (!Number.isSafeInteger(number) || Number(number) < 1)
      throw new Refused(404, NO_SUCH_BUILD)
    const [row] = this.rows({ id: Number(number) })
    if (row == null || !this.visible(viewer)(row))
      throw new Refused(404, NO_SUCH_BUILD)
    if (!this.covered(viewer, row)) throw new Forbidden(OUT_OF_SCOPE)
    return row
  }

  /** One build the viewer may see; 404 for one it may not, 403 outside a key's scopes. */
  get(viewer: BuildsViewer, id: unknown): BuildView {
    return view(this.find(viewer, id))
  }

  /**
   * A build's file: a redirect to a signed URL when it is in a Space, else
   * its bytes from the host's disk; a refusal as JSON. Never throws.
   */
  async deliver(
    viewer: BuildsViewer,
    id: unknown,
    through: 'host' | 'master',
    head = false,
  ): Promise<Delivery> {
    try {
      const row = this.find(viewer, id)
      const build = view(row)
      const objects = this.options.objects
      let stored: { size: number } | undefined
      try {
        stored = await objects.head(row.file_key)
      } catch {
        throw new Refused(502, 'The build’s storage is unreachable')
      }
      if (stored?.size !== build.size)
        throw new Refused(404, 'The build’s file is no longer available')
      const disposition = `attachment; filename="${fileName(build)}"`
      const digests = {
        'Repr-Digest': `sha-256=:${Buffer.from(build.digest, 'hex').toString('base64')}:`,
        ETag: `"${build.digest}"`,
      }
      const contentType = formatTypes[build.format]
      const signed = objects.signedUrl(row.file_key, SIGNED_URL_SECONDS, {
        disposition,
        contentType,
      })
      // Logged once the file is under way: a redirect as a redirect, a
      // stream once its file opened, and a HEAD not at all.
      const who = `${shownLabel(viewer.label)} through the ${through}`
      if (signed != null) {
        if (!head)
          this.options.log?.(
            `Build ${build.id} redirected to its Space for ${who}`,
          )
        return {
          status: 302,
          headers: {
            Location: signed,
            'Cache-Control': 'no-store',
            ...digests,
          },
        }
      }
      return {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': disposition,
          'Content-Length': String(build.size),
          ...digests,
        },
        open: async (): Promise<Readable> => {
          const found = await objects.get(row.file_key).catch(() => undefined)
          if (found == null)
            throw new Refused(502, 'The build’s storage is unreachable')
          this.options.log?.(`Build ${build.id} downloaded by ${who}`)
          return found.stream
        },
      }
    } catch (error) {
      return refusedDelivery(error)
    }
  }

  /** The host's own routes: `GET /api/v2/builds`, `/:id` and `/:id/download`. */
  routes(accounts: Accounts): Router {
    const router = Router()
    const handle =
      (
        route: (req: Request, viewer: BuildsViewer) => Promise<Delivery>,
      ): RequestHandler =>
      (req, res, next) => {
        void (async (): Promise<void> => {
          this.ready()
          const answer = await route(req, this.viewer(req, accounts))
          let body: Readable | undefined
          let delivery = answer
          if (answer.open != null && req.method !== 'HEAD')
            try {
              body = await answer.open()
            } catch (error) {
              delivery = refusedDelivery(error)
            }
          res.status(delivery.status).set(delivery.headers)
          if (delivery.json !== undefined) {
            res.json(delivery.json)
            return
          }
          if (body == null) {
            res.end()
            return
          }
          await pipeline(body, res).catch(() => {
            res.destroy()
          })
        })().catch(next)
      }
    const json = (body: unknown): Delivery => ({
      status: 200,
      headers: {},
      json: body,
    })
    router.get(
      '/api/v2/builds',
      handle(async (req, viewer) => json(this.list(viewer, req.query))),
    )
    router.get(
      '/api/v2/builds/:id',
      handle(async (req, viewer) => json(this.get(viewer, req.params.id))),
    )
    router.get(
      '/api/v2/builds/:id/download',
      handle(
        async (req, viewer) =>
          await this.deliver(
            viewer,
            req.params.id,
            'host',
            req.method === 'HEAD',
          ),
      ),
    )
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
      const { status, error: message } = refusal(error)
      if (res.headersSent) res.destroy()
      else res.status(status).json({ error: message })
    }
    router.use('/api/v2/builds', errors)
    return router
  }

  /** `builds.request` from the master: a list or one build, as `{ status, body }`. */
  request(params: unknown): { status: number; body: unknown } {
    try {
      this.ready()
      const input = (params ?? {}) as Record<string, unknown>
      const viewer = asViewer(input.viewer)
      if (input.op === 'list')
        return { status: 200, body: this.list(viewer, input.query) }
      if (input.op === 'get')
        return { status: 200, body: this.get(viewer, input.id) }
      throw new Refused(400, 'Unknown builds request')
    } catch (error) {
      const { status, error: message } = refusal(error)
      return { status, body: { error: message } }
    }
  }

  /**
   * `builds.download` from the master: one JSON line `{ status, headers }`,
   * then the file or the refusal's JSON, each chunk paced by the master's
   * credit. An abort from the master stops the read.
   */
  async stream(stream: Stream, params: unknown): Promise<void> {
    let source: Readable | undefined
    stream.once('abort', () => source?.destroy())
    try {
      const input = (params ?? {}) as Record<string, unknown>
      const head = input.head === true
      let delivery: Delivery
      try {
        this.ready()
        delivery = await this.deliver(
          asViewer(input.viewer),
          input.id,
          'master',
          head,
        )
      } catch (error) {
        delivery = refusedDelivery(error)
      }
      if (delivery.open != null && !head)
        try {
          source = await delivery.open()
        } catch (error) {
          delivery = refusedDelivery(error)
        }
      await stream.write(
        Buffer.from(
          JSON.stringify({
            status: delivery.status,
            headers: delivery.headers,
          }) + '\n',
        ),
      )
      if (delivery.json !== undefined)
        await stream.write(Buffer.from(JSON.stringify(delivery.json)))
      if (source != null)
        for await (const chunk of source) await stream.write(chunk as Buffer)
      stream.end()
    } catch (error) {
      source?.destroy()
      stream.abort((error as Error).message)
    }
  }
}
