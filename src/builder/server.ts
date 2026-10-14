import express, { type Express } from 'express'
import { readFileSync } from 'node:fs'
import { reverse } from 'node:dns/promises'
import { isIP } from 'node:net'
import { BuilderStore, publicJob, type Job } from './store.js'
import { readLogPath, Worker } from './worker.js'
import { noSymlinks } from '../config.js'
import type { Server } from 'node:http'
import { AutomaticPoller, AUTOMATIC_POLL_MS } from './automatic.js'
import { randomBytes } from 'node:crypto'
import { statusPage } from './status.js'
import { builderAdminRoutes } from './admin.js'

export function clientAddress(
  remote: string | undefined,
): string | undefined {
  if (remote == null) return undefined
  const address = remote.startsWith('::ffff:')
    ? remote.slice('::ffff:'.length)
    : remote
  return isIP(address) === 0 ? undefined : address
}
export async function clientName(
  address: string,
  lookup: (ip: string) => Promise<string[]> = reverse,
  timeoutMs = 300,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const names = await Promise.race([
      lookup(address),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    return names.find(
      (name) =>
        name.length > 0 &&
        name.length <= 253 &&
        !/[\u0000-\u001f\u007f\s]/.test(name) &&
        isIP(name) === 0,
    )
  } catch {
    return undefined
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}
export type QueueEntry = Omit<
  ReturnType<typeof publicJob>,
  | 'started'
  | 'finished'
  | 'commit_sha'
  | 'requested_commit'
  | 'exit_code'
  | 'cleanup_error'
  | 'quarantine_reason'
  | 'client_ip'
> & {
  started: number | null
  finished: number | null
  commit_sha: string | null
  requested_commit: string | null
  exit_code: number | null
  cleanup_error: string | null
  quarantine_reason: string | null
  client_ip: string | null
  client_name: string | null
  trigger: 'poll' | 'api'
}
async function queueEntries(
  store: BuilderStore,
  lookup: (ip: string) => Promise<string[]>,
  jobs: Job[] = store.pending(),
): Promise<QueueEntry[]> {
  const addresses = [
    ...new Set(
      jobs.flatMap((job) => (job.client_ip == null ? [] : [job.client_ip])),
    ),
  ]
  const names = new Map(
    await Promise.all(
      addresses.map(
        async (ip): Promise<[string, string | undefined]> => [
          ip,
          await clientName(ip, lookup),
        ],
      ),
    ),
  )
  return jobs.map((job) =>
    queueEntry(
      job,
      job.client_ip == null ? undefined : names.get(job.client_ip),
    ),
  )
}
function queueEntry(job: Job, name: string | undefined): QueueEntry {
  const pub = publicJob(job)
  return {
    ...pub,
    started: pub.started ?? null,
    finished: pub.finished ?? null,
    commit_sha: pub.commit_sha ?? null,
    requested_commit: pub.requested_commit ?? null,
    exit_code: pub.exit_code ?? null,
    cleanup_error: pub.cleanup_error ?? null,
    quarantine_reason: pub.quarantine_reason ?? null,
    client_ip: pub.client_ip ?? null,
    client_name: name ?? null,
    trigger: pub.automatic === 1 ? 'poll' : 'api',
  }
}

export function builderApp(
  store: BuilderStore,
  options?: { lookup?: (ip: string) => Promise<string[]> },
): Express {
  const app = express()
  app.disable('x-powered-by')
  let window = Date.now(),
    count = 0
  const lookup = options?.lookup ?? reverse
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (Date.now() - window > 60000) {
      window = Date.now()
      count = 0
    }
    if (++count > 1200) {
      res.status(429).json({ error: 'Request limit exceeded' })
      return
    }
    next()
  })
  // The status page is the one read without a key: it is opened in a
  // browser on the builder's trusted network.
  app.get('/', async (_req, res) => {
    const nonce = randomBytes(16).toString('base64')
    const names = new Map(store.apps().map((a) => [a.slug, a.name]))
    const [jobs, recent] = await Promise.all([
      queueEntries(store, lookup),
      queueEntries(store, lookup, store.recent()),
    ])
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    )
    res
      .type('html')
      .send(
        statusPage(jobs, names, Date.now(), nonce, recent),
      )
  })
  app.use((req, res, next) => {
    const key = store.authenticate(
      (req.headers.authorization ?? '').replace(/^Bearer /, ''),
    )
    if (
      !req.headers.authorization?.startsWith('Bearer ') ||
      key == null
    ) {
      res.status(401).json({ error: 'Builder API key required' })
      return
    }
    res.locals.key = key
    next()
  })
  app.use(builderAdminRoutes(store))
  app.use(express.json({ limit: '8kb', strict: true }))
  app.get('/api/apps', (_req, res) => {
    res.json(
      store.apps().map(({ slug, name, enabled, platforms }) => ({
        slug,
        name,
        enabled,
        platforms,
        ...store.buildSettings(slug),
        pollIntervalMs: AUTOMATIC_POLL_MS,
      })),
    )
  })
  app.get('/api/apps/:slug/build-settings', (req, res) => {
    try {
      res.json({
        ...store.buildSettings(req.params.slug),
        pollIntervalMs: AUTOMATIC_POLL_MS,
      })
    } catch {
      res.status(404).json({ error: 'App not found' })
    }
  })
  app.put('/api/apps/:slug/build-settings', (req, res) => {
    try {
      store.configureBuilds(req.params.slug, req.body)
      res.json({
        ...store.buildSettings(req.params.slug),
        pollIntervalMs: AUTOMATIC_POLL_MS,
      })
    } catch {
      res.status(400).json({ error: 'Invalid app build settings' })
    }
  })
  app.get('/api/queue', async (_req, res) => {
    res.json(await queueEntries(store, lookup))
  })
  app.post('/api/jobs', (req, res) => {
    try {
      res.status(202).json(
        publicJob(
          store.enqueue(
            req.body,
            res.locals.key,
            clientAddress(req.socket.remoteAddress),
          ),
        ),
      )
    } catch {
      res.status(400).json({
        error: 'Invalid job, idempotency conflict, or queue full',
      })
    }
  })
  app.get('/api/jobs/:id', (req, res) => {
    const job = /^[a-f0-9-]{36}$/.test(req.params.id)
      ? store.job(req.params.id)
      : undefined
    if (job == null) {
      res.status(404).json({ error: 'Job not found' })
      return
    }
    res.json(publicJob(job))
  })
  app.get('/api/jobs/:id/log', (req, res) => {
    const file = /^[a-f0-9-]{36}$/.test(req.params.id)
      ? readLogPath(store, req.params.id)
      : undefined
    if (file == null) {
      res.status(404).end()
      return
    }
    noSymlinks(file)
    res.type('text/plain').send(readFileSync(file, 'utf8'))
  })
  app.post('/api/jobs/:id/cancel', (req, res) => {
    if (
      !/^[a-f0-9-]{36}$/.test(req.params.id) ||
      !store.cancel(req.params.id)
    ) {
      res.status(409).json({ error: 'Job is not active' })
      return
    }
    res.json({ cancelled: true })
  })
  app.get('/api/jobs/:id/logs', (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) {
      res.status(404).json({ error: 'Build log not found' })
      return
    }
    const full = readLogPath(store, req.params.id, true)
    const file = full ?? readLogPath(store, req.params.id)
    if (file == null) {
      res.status(404).json({ error: 'Build log not found' })
      return
    }
    noSymlinks(file)
    res.set('X-Mason-Log-Capture', full == null ? 'legacy' : 'full')
    res.type('text/plain')
    res.download(
      file,
      `mason-build-${req.params.id}.log`,
      { cacheControl: false, lastModified: false },
      (error) => {
        if (error == null || res.headersSent) return
        if ((error as Error & { status?: number }).status === 416) {
          res.status(416).end()
        } else
          res.status(500).json({ error: 'Build log unavailable' })
      },
    )
  })
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: 'Invalid request' })
    },
  )
  return app
}
export function serveBuilder(store: BuilderStore): {
  server: Server
  worker: Worker
  automatic: AutomaticPoller
  close: () => Promise<void>
} {
  const worker = new Worker(store)
  const automatic = new AutomaticPoller(store)
  const server = builderApp(store).listen(
    store.config.port,
    store.config.listenHost,
  )
  const close = async (): Promise<void> => {
    server.close()
    await automatic.close()
    await worker.close()
    store.close()
  }
  return { server, worker, automatic, close }
}
