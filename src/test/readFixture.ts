import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Cleaner } from 'cleaners'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { SESSION_COOKIE } from '../auth/routes.js'
import { MASTER_SESSION_COOKIE } from '../master/auth.js'
import { localOperator } from '../master/roles.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import type { Role } from '../shared/permissions.js'
import { insertBuild } from '../store.js'
import { cluster, type Cluster } from './cluster.js'
import { proofLog } from './proofLog.js'

export const ALPHA = 'com.example.alpha'
export const BETA = 'com.example.beta'
/** The master's public origin, which iOS installers from the master name. */
export const MASTER_ORIGIN = 'https://master.example.test'

/** Alpha's sequence numbers beta too; `build` publishes alpha. */
const masonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('${ALPHA}', { format: 'N', apps: ['${BETA}'] })
  m.workflow('build', { triggers: [{ request: true }] }, (w) => {
    w.stage('compile', { on: 'master', publishes: ['${ALPHA}'], run: compile })
  })
  m.workflow('release', { triggers: [{ request: true }] }, (w) => {
    const approved = w.approval('approve', { roles: ['manager'] })
    w.stage('ship', { needs: [approved], on: 'master', run: compile })
  })
}
export async function compile(ctx: Stage) {
  ctx.log.info('compiled')
}
`

/** The answer is the cleaner's: it keeps every field the route sent. */
export function shape<T>(cleaner: Cleaner<T>, json: unknown): T {
  assert.deepEqual(JSON.parse(JSON.stringify(cleaner(json))), json)
  return json as T
}

export interface Reply {
  status: number
  // Answers are read field by field in assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  text: string
  headers: { get(name: string): string | null; getSetCookie(): string[] }
}

/** Who a request is from: a person on a node, or an API key. */
export type Who =
  | { cookie: string; csrf: string }
  | { key: string }
  | Record<string, never>

/**
 * A master and a host with what every read route shows: a project with two
 * app IDs and a shared build-number sequence, a finished run that published
 * an Android build and saved an artifact and test results, a run waiting
 * for an approval, a person for each role (the tester in a group with
 * alpha), and API keys.
 */
export interface ReadFixture {
  c: Cluster
  host: RunningNode
  people: Record<Role, number>
  /** The finished run, and the run waiting for an approval. */
  runs: { built: string; waiting: string }
  build: number
  /** API keys: `scoped` to another project, `release` to this one's release branch. */
  keys: { developer: string; manager: string; scoped: string; release: string }
  /**
   * Publishes another build of alpha on master (an iOS build provisioned
   * for the devices named by UDID), and waits until the host has it.
   */
  publish(
    platform: 'android' | 'ios',
    number: string,
    devices?: string[],
  ): Promise<number>
  /** A request to a node, written to the proof log. */
  request(
    node: RunningNode,
    method: string,
    route: string,
    who?: Who,
    body?: unknown,
  ): Promise<Reply>
  /** A session for a person on the master or the host. */
  on(node: 'master' | 'host', role: Role): { cookie: string; csrf: string }
  origin(node: RunningNode): string
}

/** Starts the cluster and waits until the host holds everything the master shows. */
export async function readFixture(root: string): Promise<ReadFixture> {
  const c = await cluster(path.join(root, 'cluster'), {
    coWorker: true,
    master: { testEndpoints: true },
  })
  const host = await c.startHost('host', { testEndpoints: true })
  const master = c.master.master!
  const origin = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  await master.settings.set(localOperator, 'host', {
    origin: origin(host),
    workerOrigin: host.web!.url,
  })
  await master.settings.set(localOperator, 'master', { origin: MASTER_ORIGIN })
  const repo = c.repo('fixtures/reads')
  repo.commit({ 'Masonfile.ts': masonfile }, 'master', 'Reads fixture')
  repo.commit({ 'release.txt': 'release\n' }, 'release', 'Release')
  master.saveProject(localOperator, 'reads', {
    name: 'Reads',
    repository: repo.url,
    rules: [{ pattern: '**', mode: 'request' }],
    apps: [
      { bundleId: ALPHA, name: 'Alpha', platforms: ['ios', 'android'] },
      { bundleId: BETA, name: 'Beta', platforms: ['android'] },
    ],
  })
  const db = master.database.db
  const appId = (slug: string): number =>
    Number(db.prepare('SELECT id FROM apps WHERE slug=?').get(slug)!.id)
  const people = {} as Record<Role, number>
  for (const role of ['tester', 'developer', 'manager', 'admin'] as const)
    people[role] = (
      await master.people.create(localOperator, {
        name: `Read ${role}`,
        emails: [`read.${role}@example.test`],
        role,
      })
    ).id
  master.people.createGroup(localOperator, {
    name: 'Alpha testers',
    apps: [appId(ALPHA)],
    members: [people.tester],
  })
  const keys = {
    developer: master.keys.create(localOperator, {
      role: 'developer',
      name: 'reads developer',
    }).token,
    manager: master.keys.create(localOperator, {
      role: 'manager',
      name: 'reads manager',
    }).token,
    scoped: master.keys.create(localOperator, {
      role: 'developer',
      name: 'reads scoped',
      projects: ['elsewhere'],
    }).token,
    release: master.keys.create(localOperator, {
      role: 'developer',
      name: 'reads release',
      projects: ['reads'],
      branches: ['release'],
    }).token,
  }
  // A real run on the co-worker: its graph, steps, history and kept Masonfile.
  const created = await c.api('POST', '/api/v2/runs', {
    project: 'reads',
    branch: 'master',
    workflow: 'build',
  })
  assert.equal(created.status, 202, created.text)
  const built = String(created.json.id)
  await c.until(
    () => (master.run(built) as { status: string }).status === 'succeeded',
    120_000,
    'the build run',
  )
  // What the run published and saved.
  const bytes = Buffer.from('alpha android package '.repeat(20))
  const sha = createHash('sha256').update(bytes).digest('hex')
  const channel = Number(
    db
      .prepare("SELECT id FROM channels WHERE app_id=? AND platform='android'")
      .get(appId(ALPHA))!.id,
  )
  const commit = String(
    (master.run(built) as { commit_sha: string }).commit_sha,
  )
  const key = sha.slice(0, 32) + '.apk'
  const build = insertBuild(
    db,
    {
      channelId: channel,
      branch: 'master',
      commit,
      version: '1.2',
      buildNumber: '7',
      bundleId: ALPHA,
      format: 'apk',
      size: bytes.length,
      digest: sha,
      changelog: '',
      source: 'test',
      customFields: '{}',
      run: built,
    } as Parameters<typeof insertBuild>[1],
    key,
    { now: Date.now(), retentionDays: 14 },
  ).id
  const file = path.join(root, 'alpha.apk')
  writeFileSync(file, bytes)
  await host.host!.objects.put(key, file, sha)
  master.database.change('build', build)
  const now = master.database.now()
  db.prepare(
    "INSERT INTO run_artifacts(job_id,stage,name,kind,size,digest,storage_key,created_at) VALUES(?,'compile','report.html','report',42,?,'reads/report',?)",
  ).run(built, 'd'.repeat(64), now)
  db.prepare(
    'INSERT INTO run_tests(job_id,stage,attempt,summary) VALUES(?,\'compile\',1,\'{"passed":3,"failed":1,"skipped":2}\')',
  ).run(built)
  master.database.change('job', built)
  // A run waiting at its approval, which managers decide.
  const release = await c.api('POST', '/api/v2/runs', {
    project: 'reads',
    branch: 'release',
    workflow: 'release',
  })
  assert.equal(release.status, 202, release.text)
  const waiting = String(release.json.id)
  await c.until(
    () =>
      db
        .prepare(
          "SELECT 1 FROM job_stages WHERE job_id=? AND name='approve' AND status='awaiting_approval'",
        )
        .get(waiting) != null,
    60_000,
    'the release run at its approval',
  )
  const cache = host.host!.cache.db
  const present = (sql: string, ...args: Array<string | number>): boolean =>
    cache.prepare(sql).get(...args) != null
  const copied: Record<string, () => boolean> = {
    build: () => present('SELECT 1 FROM builds WHERE id=?', build),
    artifact: () =>
      present(
        "SELECT 1 FROM run_artifacts WHERE job_id=? AND name='report.html'",
        built,
      ),
    approval: () =>
      present(
        "SELECT 1 FROM job_stages WHERE job_id=? AND status='awaiting_approval'",
        waiting,
      ),
    masonfile: () => present('SELECT 1 FROM masonfiles WHERE text IS NOT NULL'),
    details: () =>
      present(
        "SELECT 1 FROM projects WHERE slug='reads' AND details IS NOT NULL",
      ),
    group: () =>
      present('SELECT 1 FROM group_members WHERE account_id=?', people.tester),
    keys: () =>
      Object.values(keys).every((token) =>
        present(
          'SELECT 1 FROM host_keys WHERE id=?',
          /^mason_v1_([a-f0-9]{32})\./.exec(token)![1]!,
        ),
      ),
  }
  let missing: string[] = []
  await c
    .until(
      () => {
        missing = Object.keys(copied).filter((name) => !copied[name]!())
        return missing.length === 0
      },
      20_000,
      'the host',
    )
    .catch(() => {
      throw new Error(`The host never had: ${missing.join(', ')}`)
    })
  const publish: ReadFixture['publish'] = async (
    platform,
    number,
    devices,
  ) => {
    const format = platform === 'ios' ? 'ipa' : 'apk'
    const data = Buffer.from(`alpha ${platform} ${number} `.repeat(20))
    const digest = createHash('sha256').update(data).digest('hex')
    const objectKey = `${digest.slice(0, 32)}.${format}`
    const id = insertBuild(
      db,
      {
        channelId: Number(
          db
            .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
            .get(appId(ALPHA), platform)!.id,
        ),
        branch: 'master',
        commit,
        version: '1.3',
        buildNumber: number,
        bundleId: ALPHA,
        format,
        size: data.length,
        digest,
        changelog: '',
        source: 'test',
        customFields: '{}',
      } as Parameters<typeof insertBuild>[1],
      objectKey,
      { now: Date.now(), retentionDays: 14 },
    ).id
    const stored = path.join(root, `alpha-${number}.${format}`)
    writeFileSync(stored, data)
    await host.host!.objects.put(objectKey, stored, digest)
    if (devices != null)
      db.prepare(
        "INSERT INTO build_provisioning(build_id,devices,expires_at,team) VALUES(?,?,?,'ABCDE12345')",
      ).run(id, JSON.stringify(devices), Date.now() + 86_400_000)
    master.database.change('build', id)
    await c.until(
      () =>
        cache.prepare('SELECT 1 FROM builds WHERE id=?').get(id) != null &&
        (devices == null ||
          cache
            .prepare('SELECT 1 FROM build_provisioning WHERE build_id=?')
            .get(id) != null),
      10_000,
      `build ${number} on the host`,
    )
    return id
  }
  const request: ReadFixture['request'] = async (
    node,
    method,
    route,
    who = {},
    body,
  ) => {
    const headers: Record<string, string> = {}
    if ('cookie' in who) {
      headers.cookie = who.cookie
      if (method !== 'GET') {
        headers['x-mason-csrf'] = who.csrf
        headers.origin =
          node === host ? host.host!.cache.store.config.origin : origin(node)
      }
    }
    if ('key' in who) headers.authorization = `Bearer ${who.key}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await pinnedFetch(
      origin(node) + route,
      {
        method,
        redirect: 'manual',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      node.web!.certificate!.pin,
    )
    const text = await response.text()
    let json: Reply['json']
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    const caller =
      'cookie' in who ? ' (session)' : 'key' in who ? ' (API key)' : ''
    proofLog(
      `${method} ${node === host ? 'host' : 'master'}${route}${caller}`,
      `${response.status} ${text.length > 4000 ? text.slice(0, 4000) + '…' : text}`,
    )
    return { status: response.status, json, text, headers: response.headers }
  }
  return {
    c,
    host,
    people,
    runs: { built, waiting },
    build,
    keys,
    publish,
    request,
    on: (node, role): { cookie: string; csrf: string } => {
      if (node === 'master') {
        const { token, session } = master.auth.start(people[role], '127.0.0.1')
        return {
          cookie: `${MASTER_SESSION_COOKIE}=${token}`,
          csrf: session.csrf,
        }
      }
      const { token, session } = host.host!.accounts.startSession(people[role])
      return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf }
    },
    origin,
  }
}
