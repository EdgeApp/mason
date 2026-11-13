// The master and the host in a real browser: Chrome driven by maestro-d's
// web driver, as src/master/browser.test.ts is. Skipped unless
// MASON_WEB_E2E=1; it needs MASON_TEST_ROOT, MASON_ARTIFACTS,
// MASON_BROWSER_BIN, MAESTRO_D and MAESTRO_D_CLIENT_ROOT. Run it compiled,
// from lib/: a real checkout needs lib/worker/gitProxy.js. Each scenario
// writes the screenshots and logs that prove it into MASON_ARTIFACTS.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'mocha'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { localOperator } from './roles.js'

// Replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
interface Device {
  command: (name: string, value?: unknown) => Promise<unknown>
  screenshot: () => Promise<Buffer>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  detach: (id: string) => Promise<void>
}
const sha = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const quote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'"

export const ALPHA = 'com.example.alpha'
export const BETA = 'com.example.beta-with-a-longer-id'
/** The upload fixtures, compiled; the stages build packages numbered by their run. */
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../upload/fixtures.test.js',
)

/** The file whose arrival lets the stream stage finish. */
const STREAM_GATE = path.join(tmpdir(), `mason-e11-gate-${process.pid}`)

/**
 * Two apps, two workflows: build-alpha publishes alpha, build-beta beta;
 * beta shares alpha's sequence. A third, stream, logs 100,000 lines (2 MB)
 * and then a line every quarter second until STREAM_GATE exists. A fourth,
 * release, takes a channel and waits for an administrator's approval.
 */
export const masonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('${ALPHA}', { format: 'YYMMDDCC', apps: ['${BETA}'] })
  m.workflow('build-alpha', { triggers: [{ request: true }] }, (w) => {
    w.stage('android', { on: 'master', publishes: ['${ALPHA}'], run: shipAlpha })
  })
  m.workflow('build-beta', { triggers: [{ request: true }] }, (w) => {
    w.stage('macos', { on: 'master', publishes: ['${BETA}'], run: shipBeta })
  })
  m.workflow('stream', { triggers: [{ request: true }] }, (w) => {
    w.stage('stream', { on: 'master', run: streamLog })
  })
  m.workflow('release', { triggers: [{ request: true }], params: { channel: { type: 'choice', choices: ['testers', 'store'], default: 'testers', description: 'Where the release goes.' } } }, (w) => {
    const approved = w.approval('approve', { roles: ['admin'], message: 'Ship the release?', params: { notes: { type: 'string', description: 'What changed.' } } })
    w.stage('ship', { needs: [approved], on: 'master', run: ship })
  })
}
export async function ship(ctx: Stage) {
  ctx.log.info('shipped to ' + ctx.run.params.channel)
}
export async function streamLog(ctx: Stage) {
  const { existsSync } = await import('node:fs')
  await ctx.sh("seq -f 'stream line %.0f' 1 100000")
  let n = 0
  while (!existsSync(${JSON.stringify(STREAM_GATE)})) {
    ctx.log.info('waiting ' + ++n)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  ctx.log.info('stream done')
}
export async function shipAlpha(ctx: Stage) {
  const { writeFileSync } = await import('node:fs')
  const f = await import(${JSON.stringify(FIXTURES)})
  f.packageFields.bundleId = '${ALPHA}'
  f.packageFields.version = '1.0.' + ctx.run.number
  const n = Number(ctx.getBuildNumber('${ALPHA}'))
  writeFileSync('alpha.apk', f.zip([['AndroidManifest.xml', f.manifest(false, false, n)]]))
  return await ctx.publish({ app: '${ALPHA}', platform: 'android', path: 'alpha.apk', changelog: 'Alpha on ' + ctx.run.branch })
}
export async function shipBeta(ctx: Stage) {
  const { writeFileSync } = await import('node:fs')
  const f = await import(${JSON.stringify(FIXTURES)})
  const image = f.desktop('dmg')
  image[16] = ctx.run.number % 256
  writeFileSync('beta.dmg', image)
  return await ctx.publish({ app: '${BETA}', platform: 'macos', path: 'beta.dmg', version: '2.0.' + ctx.run.number, changelog: 'Beta on ' + ctx.run.branch })
}
`

export const PASSWORDS: Record<string, string> = {
  paul: 'Correct-Horse-9',
  tess: 'Tess-Horse-9-long',
  nora: 'Nora-Horse-9-long',
  dev: 'Dev-Horse-9-long',
}

describe('Mason in a real browser: people, accounts, navigation', function () {
  this.timeout(600_000)
  const enabled = process.env.MASON_WEB_E2E === '1'
  const {
    MASON_TEST_ROOT: parent,
    MASON_ARTIFACTS: artifacts,
    MASON_BROWSER_BIN: browserBin,
    MAESTRO_D: daemonName,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
  } = process.env
  let c: Cluster
  let host: RunningNode
  let daemon: Daemon
  let wrapper: string
  let root: string
  const runs: Record<string, Json> = {}
  const people: Record<string, number> = {}
  const origin = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')

  before(async function () {
    if (!enabled) return this.skip()
    assert(parent && artifacts && browserBin && daemonName && clientRoot)
    root = mkdtempSync(path.join(realpathSync(parent), 'ui-'))
    c = await cluster(path.join(root, 'cluster'), { coWorker: true })
    host = await c.startHost('host')
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', {
      origin: origin(host),
      workerOrigin: host.web!.url,
    })
    const repo = c.repo('fixtures/fixture')
    repo.commit({ 'Masonfile.ts': masonfile }, 'master', 'Fixture Masonfile')
    repo.commit({ 'develop.txt': 'develop\n' }, 'develop', 'Develop work')
    master.saveProject(localOperator, 'fixture', {
      name: 'Fixture',
      repository: repo.url,
      rules: [
        { pattern: 'master', mode: 'request' },
        { pattern: 'develop', mode: 'request' },
      ],
      apps: [
        { bundleId: ALPHA, name: 'Alpha', platforms: ['ios', 'android'] },
        { bundleId: BETA, name: 'Beta', platforms: ['macos'] },
      ],
    })
    // Real runs on the co-worker: each workflow on master, then on develop.
    for (const branch of ['master', 'develop'])
      for (const workflow of ['build-alpha', 'build-beta']) {
        const created = await c.api('POST', '/api/v2/runs', {
          project: 'fixture',
          branch,
          workflow,
        })
        assert.equal(created.status, 202, created.text)
        const value = await c.until(
          () => {
            const run = master.run(created.json.id) as Json
            return ['succeeded', 'failed', 'cancelled', 'unstable'].includes(
              run.status,
            )
              ? run
              : undefined
          },
          120_000,
          `${workflow} on ${branch}`,
        )
        assert.equal(value.status, 'succeeded', master.scheduler.logs(value.id))
        runs[`${workflow}@${branch}`] = value
      }
    const person = async (
      key: string,
      fields: Record<string, unknown>,
    ): Promise<void> => {
      const p = clientParameters(
        Buffer.from(key.padEnd(16, '-')).toString('hex').slice(0, 32),
        DEFAULT_PASSWORD_COSTS,
      )
      people[key] = (
        await master.people.create(localOperator, {
          ...fields,
          password: {
            clientHash: await clientPasswordHash(PASSWORDS[key]!, p),
            clientParameters: p,
          },
        })
      ).id
    }
    await person('tess', {
      name: 'Tess Tester',
      username: 'tess',
      role: 'tester',
      emails: ['tess@example.test', 'tess2@example.test'],
    })
    // No username: she signs in with her email.
    await person('nora', {
      name: 'Nora Tester',
      role: 'tester',
      emails: ['nora@example.test'],
    })
    await person('dev', {
      name: 'Dev Developer',
      username: 'dev',
      role: 'developer',
      emails: ['dev@example.test'],
    })
    people.paul = Number(
      master.database.db
        .prepare("SELECT id FROM accounts WHERE username='paul'")
        .get()!.id,
    )
    const appIds = master.database.db
      .prepare('SELECT id FROM apps WHERE slug IN (?,?) ORDER BY id')
      .all(ALPHA, BETA)
      .map((row) => Number(row.id))
    master.people.createGroup(localOperator, {
      name: 'Testers',
      apps: appIds,
      members: [people.tess!, people.nora!],
    })
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare(
              "SELECT COUNT(*) AS n FROM builds WHERE state='ready'",
            )
            .get() as { n: number }
        ).n >= 4 &&
        host
          .host!.cache.db.prepare("SELECT 1 FROM groups WHERE name='Testers'")
          .get() != null &&
        host
          .host!.cache.db.prepare(
            "SELECT 1 FROM accounts WHERE name='Dev Developer'",
          )
          .get() != null,
      20_000,
      'the builds, people and group on the host',
    )
    wrapper = path.join(root, 'browser')
    const pins = [c.master, host]
      .map((node) => node.web!.certificate!.pin.replace(/^sha256\/\//, ''))
      .join(',')
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${quote(browserBin)} --ignore-certificate-errors-spki-list=${quote(pins)} "$@"\n`,
      { mode: 0o700 },
    )
    const require = createRequire(import.meta.url)
    // The client root is the npm package, or the maestro-d checkout holding it.
    const client = [
      path.join(clientRoot, 'dist/cjs/index.js'),
      path.join(clientRoot, 'npm/maestro-d/dist/cjs/index.js'),
    ].find((file) => existsSync(file))
    assert(client, `No maestro-d client under ${clientRoot}`)
    const { MaestroD } = require(client) as {
      MaestroD: { connect: (options: object) => Promise<Daemon> }
    }
    daemon = await MaestroD.connect({ name: daemonName })
  })
  after(async () => {
    await c?.close()
  })

  /** A fresh Chrome (its own profile) at a window size, on a node's origin. */
  const browser = async (
    name: string,
    node: RunningNode,
    windowSize: string,
  ): Promise<{
    open: (suffix: string) => Promise<void>
    visible: (text: string) => Promise<void>
    gone: (text: string) => Promise<void>
    tap: (css: string) => Promise<void>
    type: (css: string, text: string) => Promise<void>
    script: (script: string) => Promise<unknown>
    command: (name: string, value?: unknown) => Promise<unknown>
    shot: (file: string) => Promise<void>
    close: () => Promise<void>
  }> => {
    const base = origin(node)
    const device = await daemon.attach({
      device: name,
      platform: 'web',
      url: base,
      extra: { browser: wrapper, windowSize },
      artifacts: 'none',
      commandTimeout: 30000,
      // maestro-d writes reports here; the artifacts directory holds only proof.
      outputDir: path.join(realpathSync(parent!), 'maestro-output'),
    })
    const retry = async (step: () => Promise<unknown>): Promise<void> => {
      try {
        await step()
      } catch (error) {
        // A navigation can land mid-command; the page is asked once more.
        if (!/navigated|execution context|find context/i.test(String(error)))
          throw error
        await step()
      }
    }
    return {
      open: async (suffix): Promise<void> => {
        await device.command('openBrowser', { url: base + suffix })
      },
      visible: async (text): Promise<void> =>
        await retry(
          async () =>
            await device.command('assertVisible', { text, timeout: 30000 }),
        ),
      gone: async (text): Promise<void> =>
        await retry(
          async () =>
            await device.command('assertNotVisible', { text, timeout: 30000 }),
        ),
      tap: async (css): Promise<void> =>
        await retry(async () => await device.command('tapOn', { css })),
      type: async (css, text): Promise<void> => {
        await device.command('tapOn', { css })
        await device.command('inputText', { text })
      },
      script: async (script): Promise<unknown> =>
        await device.command('evalBrowserScript', { script }),
      command: async (command, value): Promise<unknown> =>
        await device.command(command, value),
      shot: async (file): Promise<void> => {
        // Let fonts and layout settle before the capture.
        await new Promise((resolve) => setTimeout(resolve, 500))
        writeFileSync(path.join(artifacts!, file), await device.screenshot())
      },
      close: async (): Promise<void> => {
        // Detach only: the daemon is shared by every scenario here.
        await daemon.detach(name).catch(() => undefined)
      },
    }
  }
  type Browser = Awaited<ReturnType<typeof browser>>
  /** Runs a check in the page until it stops throwing, for up to 20 seconds. */
  const settled = async (b: Browser, check: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        await b.script(check)
        return
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }
  /** The master's sign-in form, by username or email. */
  const masterSignIn = async (
    b: Browser,
    identifier: string,
    password: string,
  ): Promise<void> => {
    await b.open('/sign-in')
    await b.visible('^Sign in$')
    await b.type('#sign-in-username', identifier)
    await b.type('#sign-in-password', password)
    await b.tap('form[name="sign-in"] button[type="submit"]')
  }
  /** The host's sign-in form, checked by the master over the link. */
  const hostSignIn = async (
    b: Browser,
    identifier: string,
    password: string,
    destination: string,
  ): Promise<void> => {
    await b.open(`/auth/login?return=${encodeURIComponent(destination)}`)
    await b.visible('^Sign in$')
    await b.type('#sign-in-username', identifier)
    await b.type('#sign-in-password', password)
    await b.tap('form[name="sign-in"] button[type="submit"]')
  }
  /** A request to a node, written to a proof log as a `$` line and its answer. */
  const logged = async (
    file: string,
    node: RunningNode,
    method: string,
    route: string,
    body: unknown,
    show: (reply: { status: number; json: Json }) => string,
  ): Promise<{ status: number; json: Json; cookie: string | undefined }> => {
    const url = origin(node) + route
    const response = await pinnedFetch(
      url,
      {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      node.web!.certificate?.pin,
    )
    const json = await response.json().catch(() => undefined)
    const shown = JSON.stringify(body).replace(
      /"clientHash":"[0-9a-f]+"/,
      '"clientHash":"<64 hex>"',
    )
    appendFileSync(
      path.join(artifacts!, file),
      `$ curl -X ${method} ${url} -d '${shown}'\n${show({ status: response.status, json })}\n\n`,
    )
    return {
      status: response.status,
      json,
      cookie: response.headers.get('set-cookie') ?? undefined,
    }
  }

  it('E1 a password signs in by an email, a second email or a username, and a wrong one is refused', async () => {
    const log = 'sign-in-by-email.log'
    rmSync(path.join(artifacts!, log), { force: true })
    const parameters = async (identifier: string): Promise<Json> =>
      (
        await logged(
          log,
          c.master,
          'POST',
          '/api/v2/session/parameters',
          { identifier },
          (reply) =>
            `HTTP ${reply.status} ${JSON.stringify({ ...reply.json, salt: reply.json?.salt == null ? undefined : '<32 hex>' })}`,
        )
      ).json
    for (const [identifier, who] of [
      ['nora@example.test', 'nora'],
      ['TESS2@example.test', 'tess'],
      ['tess', 'tess'],
    ] as const) {
      const p = await parameters(identifier)
      const signedIn = await logged(
        log,
        c.master,
        'POST',
        '/api/v2/session',
        {
          identifier,
          clientHash: await clientPasswordHash(PASSWORDS[who]!, p),
        },
        (reply) =>
          `HTTP ${reply.status} ${JSON.stringify({ name: reply.json?.name, role: reply.json?.role })}`,
      )
      assert.equal(signedIn.status, 200, identifier)
    }
    const p = await parameters('nora@example.test')
    const wrong = await logged(
      log,
      c.master,
      'POST',
      '/api/v2/session',
      {
        identifier: 'nora@example.test',
        clientHash: await clientPasswordHash('Wrong-Horse-9-long', p),
      },
      (reply) => `HTTP ${reply.status} ${JSON.stringify(reply.json)}`,
    )
    assert.equal(wrong.status, 401)
    assert.equal(wrong.json.error, 'The username or password is wrong')
    c.master.master!.database.db.prepare('DELETE FROM sign_in_failures').run()
    // The same through the page: Nora has no username.
    const b = await browser('mason-e1-nora', c.master, '1280x860')
    try {
      await b.open('/sign-in')
      await b.visible('^Username or email$')
      await b.shot('sign-in-after.png')
      await masterSignIn(b, 'nora@example.test', PASSWORDS.nora!)
      await b.visible('Nora Tester|Alpha|Install apps|Your apps')
    } finally {
      await b.close()
    }
  })

  it('E4 an administrator edits a row in its edit block, saves it through the confirm, and cancels a removal', async () => {
    const b = await browser('mason-e4-paul', c.master, '1280x860')
    const row = (key: string): string => `tr[data-person="${people[key]}"]`
    const edit = 'form[name="person-edit"]'
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await holds(b, "location.pathname !== '/sign-in'", 'signed in')
      await b.open('/people')
      await holds(
        b,
        `document.querySelector('${row('nora')}') != null`,
        'Nora’s row',
      )
      await b.visible('nora@example.test')
      await b.shot('people-after.png')
      // The row becomes its edit block: a new name, an added and a removed address, a new role.
      await b.tap(`${row('nora')} button[aria-label="Edit Nora Tester"]`)
      await holds(
        b,
        `document.querySelector('${edit}') != null`,
        'the edit block',
      )
      await fill(b, `${edit} input[name="name"]`, 'Nora Renamed')
      await b.tap(`${edit} button[aria-label="Add an email address"]`)
      await holds(
        b,
        'document.querySelector(\'form[name="add-email"]\') != null',
        'the Add an email address sheet',
      )
      await fill(
        b,
        'form[name="add-email"] input[name="email"]',
        'nora2@example.test',
      )
      await b.script(
        'document.querySelector(\'form[name="add-email"]\').requestSubmit()',
      )
      await holds(
        b,
        `document.querySelector('${edit} li[data-email="nora2@example.test"]') != null`,
        'the added address',
      )
      await b.tap(`${edit} button[aria-label="Remove nora@example.test"]`)
      await fill(b, `${edit} select[name="role"]`, 'developer')
      await b.tap(`${edit} button[type="submit"]`)
      await b.visible('^Save changes to Nora Tester\\?$')
      await b.visible('Name: Nora Tester → Nora Renamed')
      await b.visible('Email added: nora2@example.test')
      await b.visible('Email removed: nora@example.test')
      await b.visible('Role: tester → developer')
      await b.shot('people-save-confirm.png')
      await press(b, 'Save', '[role=alertdialog]')
      await holds(
        b,
        `document.querySelector('${edit}') == null && document.querySelector('${row('nora')}')?.textContent.includes('Nora Renamed')`,
        'the saved row',
      )
      const saved = c.master.master!.people.get(localOperator, people.nora!)
      assert.equal(saved.name, 'Nora Renamed')
      assert.equal(saved.role, 'developer')
      assert.deepEqual(saved.emails, [
        { email: 'nora2@example.test', confirmed: true },
      ])
      // Remove, then Cancel: Dev stays.
      await b.tap(`${row('dev')} button[aria-label="Remove Dev Developer"]`)
      await b.visible('^Remove Dev Developer\\?$')
      await press(b, 'Cancel', '[role=alertdialog]')
      await holds(
        b,
        "document.querySelector('[role=alertdialog]') == null",
        'the confirm closed',
      )
      assert.equal(
        c.master.master!.people.get(localOperator, people.dev!).disabled,
        false,
      )
    } finally {
      await b.close()
    }
  })

  it('E5 a tester changes her own name and adds an email from Your account on the host, stays signed in, and the master has it', async () => {
    const h = await browser('mason-e5-tess', host, '1280x860')
    const form = 'form[name="account"]'
    try {
      await hostSignIn(h, 'tess', PASSWORDS.tess!, '/account')
      await holds(
        h,
        `document.querySelector('${form}') != null`,
        'Your account',
      )
      await fill(h, `${form} input[name="name"]`, 'Tess Self')
      await h.tap(`${form} button[aria-label="Add an email address"]`)
      await holds(
        h,
        'document.querySelector(\'form[name="add-email"]\') != null',
        'the Add an email address sheet',
      )
      await fill(
        h,
        'form[name="add-email"] input[name="email"]',
        'tess.self@example.test',
      )
      await h.script(
        'document.querySelector(\'form[name="add-email"]\').requestSubmit()',
      )
      await holds(
        h,
        `document.querySelector('${form} li[data-email="tess.self@example.test"]') != null`,
        'the added address',
      )
      await h.tap(`${form} button[type="submit"]`)
      await h.visible('Email added: tess.self@example.test')
      await press(h, 'Save', '[role=alertdialog]')
      // The master takes the change; the host's copy follows over the change feed.
      await c.until(
        () =>
          host
            .host!.cache.db.prepare(
              "SELECT 1 FROM accounts a JOIN account_emails e ON e.account_id=a.id WHERE a.id=? AND a.name='Tess Self' AND e.email='tess.self@example.test'",
            )
            .get(people.tess!),
        10_000,
        'her change on the host',
      )
      // Still signed in: the page reads as hers, the new address unconfirmed.
      await h.open('/account')
      await holds(
        h,
        `document.querySelector('${form} input[name="name"]')?.value === 'Tess Self' && document.querySelector('${form} li[data-email="tess.self@example.test"]')?.textContent.includes('Unconfirmed')`,
        'her saved account',
      )
      await h.shot('account-page-host.png')
    } finally {
      await h.close()
    }
    const saved = c.master.master!.people.get(localOperator, people.tess!)
    assert.equal(saved.name, 'Tess Self')
    assert.deepEqual(saved.emails.at(-1), {
      email: 'tess.self@example.test',
      confirmed: false,
    })
    // On the master, the account menu opens Your account.
    const m = await browser('mason-e5-paul', c.master, '1280x860')
    try {
      await masterSignIn(m, 'paul', PASSWORDS.paul!)
      await holds(m, "location.pathname !== '/sign-in'", 'signed in')
      await m.open('/projects/fixture')
      await m.visible('App IDs')
      await m.tap('button[aria-label="Your account"]')
      await holds(
        m,
        "document.querySelector('[role=menu]') != null",
        'the account menu',
      )
      await m.shot('account-menu-after.png')
      await press(m, 'Your account', '[role=menu]')
      await holds(
        m,
        "location.pathname === '/account' && document.querySelector('form[name=\"account\"]') != null",
        'Your account',
      )
      await m.shot('account-page.png')
      await m.open('/people')
      await m.visible('Tess Self')
    } finally {
      await m.close()
    }
  })

  it('N6 an administrator adds a person with an invitation, invites again, changes the role in the edit block and removes them after the confirm', async () => {
    const master = c.master.master!
    const log = 'people.log'
    writeFileSync(path.join(artifacts!, log), '')
    const note = (line: string): void =>
      appendFileSync(path.join(artifacts!, log), `${line}\n`)
    const added = ():
      | { id: number; role: string; disabled: number }
      | undefined =>
      master.database.db
        .prepare(
          "SELECT id, role, disabled FROM accounts WHERE name='Nia Newcomer'",
        )
        .get() as { id: number; role: string; disabled: number } | undefined
    const b = await browser('mason-n6', c.master, '1440x900')
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await holds(b, "location.pathname !== '/sign-in'", 'signed in')
      await b.open('/people')
      await holds(
        b,
        `document.querySelector('tr[data-person="${people.paul}"]') != null`,
        'the People table',
      )
      // The keyboard, on People and on Settings: from the top, Tab walks the
      // skip link, the shell and the page in visual order, each stop with a
      // visible ring; Reduce Motion calms the large sheets and the alerts.
      const walks: string[] = []
      for (const page of ['/people', '/settings']) {
        if (page !== '/people') {
          await b.open(page)
          await holds(b, "document.querySelector('h1') != null", page)
        }
        await b.script('document.activeElement?.blur(); window.scrollTo(0, 0)')
        const stops: string[] = []
        for (let n = 0; n < 40; n++) {
          await b.command('pressKey', { key: 'Tab' })
          stops.push(
            await value(
              b,
              "(() => { const e = document.activeElement; const s = getComputedStyle(e); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none'; return (ring ? 'ring ' : 'NO RING ') + e.tagName.toLowerCase() + ' ' + (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 60) })()",
            ),
          )
        }
        assert.match(stops[0]!, /^ring a Skip to content$/)
        assert.deepEqual(
          stops.filter(
            (stop) =>
              stop.startsWith('NO RING') && !stop.startsWith('NO RING body'),
          ),
          [],
          page,
        )
        walks.push(
          `$ Tab ×40 on ${origin(c.master)}${page} at 1440x900\n${stops.map((stop, n) => `${n + 1}. ${stop}`).join('\n')}`,
        )
      }
      const calm = await value(
        b,
        "[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.media?.mediaText.includes('prefers-reduced-motion')).map((rule) => rule.cssText).filter((text) => text.includes('m-largesheet') && text.includes('m-alert')).length",
      )
      assert(Number(calm) > 0)
      writeFileSync(
        path.join(artifacts!, 'people-tab-order.log'),
        `${walks.join('\n\n')}\n$ reduced-motion rules covering the large sheets and the alerts: ${calm}\n`,
      )
      await b.open('/people')
      await holds(
        b,
        `document.querySelector('tr[data-person="${people.paul}"]') != null`,
        'the People table again',
      )
      // Add, with an invitation link.
      await press(b, 'Add a person')
      const add = 'form[name="person-add"]'
      await holds(
        b,
        `document.querySelector('${add}') != null`,
        'the Add a person sheet',
      )
      await fill(b, `${add} input[name="name"]`, 'Nia Newcomer')
      await fill(b, `${add} input[name="email-0"]`, 'nia@example.test')
      await b.tap(`${add} input[name="invite"]`)
      await b.shot('people-add-sheet.png')
      await press(b, 'Add', 'dialog[open]')
      await holds(
        b,
        "[...document.querySelectorAll('dialog[open] .m-copy code')].some((e) => e.textContent.includes('/auth/invite#'))",
        'the invitation link',
      )
      const person = added()
      assert(person != null)
      assert.equal(person.role, 'tester')
      note(
        `$ Add a person Nia Newcomer, nia@example.test, Make an invitation link\n  → account ${person.id}, tester, link shown once`,
      )
      await press(b, 'Done', 'dialog[open]')
      const row = `tr[data-person="${person.id}"]`
      await holds(b, `document.querySelector('${row}') != null`, 'her row')
      // Invite again from her row.
      await b.tap(`${row} button[aria-label="Invite Nia Newcomer again"]`)
      await holds(
        b,
        "document.querySelector('dialog[open]')?.textContent.includes('Make the link')",
        'the Invite sheet',
      )
      await press(b, 'Make the link', 'dialog[open]')
      await holds(
        b,
        "[...document.querySelectorAll('dialog[open] .m-copy code')].some((e) => e.textContent.includes('/auth/invite#'))",
        'the new link',
      )
      note(
        '$ Invite Nia Newcomer again → Make the link\n  → a new link, the earlier one replaced',
      )
      await press(b, 'Done', 'dialog[open]')
      // The role, in her row's edit block.
      await b.tap(`${row} button[aria-label="Edit Nia Newcomer"]`)
      const edit = 'form[name="person-edit"]'
      await holds(
        b,
        `document.querySelector('${edit}') != null`,
        'the edit block',
      )
      await fill(b, `${edit} select[name="role"]`, 'developer')
      await b.shot('people-edit-block.png')
      await b.tap(`${edit} button[type="submit"]`)
      await b.visible('Role: tester → developer')
      await press(b, 'Save', '[role=alertdialog]')
      await holds(
        b,
        `document.querySelector('${edit}') == null`,
        'the saved row',
      )
      assert.equal(added()!.role, 'developer')
      note(
        '$ Edit Nia Newcomer: Role tester → developer → confirm "Save"\n  → role developer',
      )
      // Remove, after the confirm.
      await b.tap(`${row} button[aria-label="Remove Nia Newcomer"]`)
      await b.visible('^Remove Nia Newcomer\\?$')
      await b.visible('Every API key they created is revoked.')
      await b.shot('people-remove-confirm.png')
      await press(b, 'Remove', '[role=alertdialog]')
      await holds(b, `document.querySelector('${row}') == null`, 'her row gone')
      assert.equal(added()!.disabled, 1)
      note(
        '$ Remove Nia Newcomer → confirm "Remove"\n  → row gone, account disabled',
      )
    } finally {
      await b.close()
    }
  })

  it('E6 a developer reads the project’s Overview, Runs and builds and Masonfile on the host, the Masonfile also while the link is down', async () => {
    const h = await browser('mason-e6-dev', host, '1280x860')
    try {
      // Signing in returns to the page asked for.
      await hostSignIn(h, 'dev', PASSWORDS.dev!, '/projects/fixture')
      await h.visible('App IDs')
      await h.visible('Build numbers')
      // The host keeps no secrets, and sets no build numbers.
      await holds(
        h,
        "document.querySelectorAll('nav.m-tabs a').length === 3 && ![...document.querySelectorAll('nav.m-tabs a')].some((a) => a.textContent.includes('Secrets'))",
        'the tabs without Secrets',
      )
      await h.gone('Set where it stands')
      await h.shot('host-project-after.png')
      await h.open('/projects/fixture/runs?branch=develop')
      await h.visible('build-beta')
      await h.open('/projects/fixture/masonfile')
      await h.visible('m.workflow')
      await c.drop('host', 8000, async () => {
        await h.open('/projects/fixture/masonfile')
        await h.visible('m.workflow')
      })
    } finally {
      await h.close()
    }
  })

  it('E3 a tester keeps the navigation, with only Install apps and Devices, on every page of both nodes, at phone width and on a desktop; a developer lands on Projects & apps on the master', async () => {
    const db = c.master.master!.database.db
    const alpha = Number(
      db.prepare('SELECT id FROM apps WHERE slug=?').get(ALPHA)!.id,
    )
    /**
     * Fails unless the navigation holds exactly these links, the current one
     * starred: the tab bar on a phone, the sidebar on a desktop.
     */
    const menu = async (
      b: Browser,
      phone: boolean,
      expected: string[],
    ): Promise<void> => {
      const links = phone
        ? '.m-tabbar__platter a'
        : '.m-sidebar nav[aria-label="Destinations"] a'
      await b.script(
        `const nav = [...document.querySelectorAll(${JSON.stringify(links)})].map((a) => a.getAttribute('href') + (a.getAttribute('aria-current') === 'page' ? '*' : '')).join(); if (nav !== ${JSON.stringify(expected.join())}) throw new Error('The navigation is ' + nav + ' on ' + location.pathname)`,
      )
    }
    /** Fails unless the page's heading is this. */
    const heading = async (b: Browser, text: string): Promise<void> => {
      await b.script(
        `const h1 = document.querySelector('main h1')?.textContent; if (h1 !== ${JSON.stringify(text)}) throw new Error('The heading is ' + h1 + ' on ' + location.pathname)`,
      )
    }
    /** Her pages on one node: `/`, an app, its branch's install page, Devices, Your account, then `/projects`. */
    const walk = async (
      b: Browser,
      node: 'host' | 'master',
      phone: boolean,
    ): Promise<void> => {
      // `/` opens Install apps, naming the platform in the address.
      await b.visible('Choose an app to browse recent builds')
      await heading(b, 'Install apps')
      await b.script(
        "if (location.pathname !== '/apps' || !/^\\?platform=\\w+$/.test(location.search)) throw new Error('Home is ' + location.pathname + location.search)",
      )
      await menu(b, phone, ['/apps*', '/devices'])
      if (node === 'master' && !phone)
        await b.shot('master-home-tester-after.png')
      await b.open('/apps')
      await b.visible('Choose an app to browse recent builds')
      await menu(b, phone, ['/apps*', '/devices'])
      if (node === 'host' && phone)
        await b.shot('host-tester-install-after.png')
      await b.tap(`a.m-list__row[href^="/apps/${alpha}?"]`)
      await b.visible('^Branches with builds for ')
      // The sticky platform switch: Android, remembered for later visits.
      await b.tap(
        'nav[aria-label="Build platform"] a[href*="platform=android"]',
      )
      await b.visible('^Branches with builds for Android.$')
      await b.script(
        "if (!document.cookie.split('; ').includes('mason-platform=android')) throw new Error('The platform was not remembered: ' + document.cookie)",
      )
      await menu(b, phone, ['/apps*', '/devices'])
      await b.tap('a.m-list__row[href*="/branches/"]')
      await b.visible('^Android builds · newest first$')
      await settled(
        b,
        "if (![...document.querySelectorAll('main .m-catalog-build .m-btn')].some((b) => b.textContent.endsWith('Install'))) throw new Error('No Install on ' + location.pathname)",
      )
      await menu(b, phone, ['/apps*', '/devices'])
      if (phone) await b.shot(`${node}-tester-branch-after.png`)
      if (node === 'host' && phone) {
        // The keyboard on the phone layout: from the top, Tab walks the skip
        // link, the top bar, the trail, the platform switch, the builds'
        // controls and the tab bar, each stop with a visible focus ring.
        const stops: string[] = []
        // A fresh load, so Tab starts at the top rather than at the last tap.
        await b.open(await value(b, 'location.pathname + location.search'))
        await settled(
          b,
          "if (document.querySelector('main .m-catalog-build .m-btn') == null) throw new Error('No builds yet')",
        )
        await b.script('document.activeElement?.blur(); window.scrollTo(0, 0)')
        // Until focus leaves the page for the browser's own controls.
        for (let n = 0; n < 20; n++) {
          await b.command('pressKey', { key: 'Tab' })
          const stop = await value(
            b,
            "(() => { const e = document.activeElement; const s = getComputedStyle(e); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none'; return (ring ? 'ring ' : 'NO RING ') + e.tagName.toLowerCase() + ' ' + (e.getAttribute('aria-label') || e.textContent || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 60) })()",
          )
          if (/^NO RING body /.test(stop)) break
          stops.push(stop)
        }
        const calm = await value(
          b,
          "[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.media?.mediaText.includes('prefers-reduced-motion')).map((rule) => rule.cssText).filter((text) => text.includes('m-spinner')).length",
        )
        writeFileSync(
          path.join(artifacts!, 'catalog-tab-order.log'),
          `$ Tab ×${stops.length} on ${origin(host)}/apps/${alpha}/branches/<master>?platform=android at 390x844\n${stops.map((stop, n) => `${n + 1}. ${stop}`).join('\n')}\n$ reduced-motion rules covering the spinners: ${calm}\n`,
        )
        assert.match(stops[0]!, /^ring a Skip to content$/)
        assert.deepEqual(
          stops.filter((stop) => stop.startsWith('NO RING')),
          [],
        )
        assert(
          stops.some((stop) => /^ring a Android$/.test(stop)),
          'the switch',
        )
        assert(
          stops.some((stop) =>
            /^ring button Install 1\.0\.\d+ build/.test(stop),
          ),
          'an Install row',
        )
        assert(Number(calm) > 0, 'reduced motion')
      }
      await b.tap(
        phone
          ? '.m-tabbar__platter a[href="/devices"]'
          : '.m-sidebar a[href="/devices"]',
      )
      await b.visible(
        'Android and desktop apps can be downloaded without iOS device registration|Device registration is being configured',
      )
      await heading(b, 'Devices')
      await menu(b, phone, ['/apps', '/devices*'])
      if (node === 'host' && phone)
        await b.shot('host-tester-devices-after.png')
      // Install apps opens on the remembered platform.
      await b.open('/apps')
      await b.visible('Choose an app to browse recent builds')
      await b.script(
        "if (location.search !== '?platform=android') throw new Error('Install apps opened ' + location.search)",
      )
      // Your account on both nodes.
      await b.open('/account')
      await b.visible('^Your account$')
      await menu(b, phone, ['/apps', '/devices'])
      // To her, projects do not exist.
      await b.open('/projects')
      await b.visible('There is no such page')
      await heading(b, 'Not found')
      await menu(b, phone, ['/apps', '/devices'])
    }
    for (const size of ['390x844', '1280x860']) {
      const phone = size === '390x844'
      const h = await browser(`mason-e3-tess-host-${size}`, host, size)
      try {
        await hostSignIn(h, 'tess', PASSWORDS.tess!, '/')
        await walk(h, 'host', phone)
      } finally {
        await h.close()
      }
      const m = await browser(`mason-e3-tess-master-${size}`, c.master, size)
      try {
        await masterSignIn(m, 'tess', PASSWORDS.tess!)
        await walk(m, 'master', phone)
      } finally {
        await m.close()
      }
    }
    // A developer's home on the master is Projects & apps; Install apps is one tap away.
    const d = await browser('mason-e3-dev-master', c.master, '1280x860')
    try {
      await masterSignIn(d, 'dev', PASSWORDS.dev!)
      await d.visible('their latest builds and runs')
      // The web app's sidebar, at /: Projects & apps is current.
      await d.script(
        `const items = [...document.querySelectorAll('.m-sidebar nav[aria-label="Destinations"] a')].map((a) => a.getAttribute('href') + (a.getAttribute('aria-current') === 'page' ? '*' : '')).join(); if (items !== ${JSON.stringify(['/projects*', '/artifacts', '/apps', '/devices'].join())}) throw new Error('The sidebar is ' + items + ' on ' + location.pathname); if (location.pathname !== '/') throw new Error('Home is ' + location.pathname)`,
      )
      await d.shot('master-home-developer-after.png')
      await d.tap('.m-sidebar a[href="/apps"]')
      await d.visible('Choose an app to browse recent builds')
      await heading(d, 'Install apps')
      await menu(d, false, ['/projects', '/artifacts', '/apps*', '/devices'])
    } finally {
      await d.close()
    }
  })

  it('E2 the run page’s breadcrumbs are pills from Mason Master down to the run, and each one opens its level', async () => {
    const latest = runs['build-beta@develop']
    const b = await browser('mason-e2-paul', c.master, '1280x860')
    /** Fails unless the page is at this path and query. */
    const at = async (where: string): Promise<void> => {
      await b.script(
        `if (location.pathname + location.search !== ${JSON.stringify(where)}) throw new Error('The page is ' + location.pathname + location.search)`,
      )
    }
    /** Fails unless the breadcrumbs are these pills, each a link, the last one current. */
    const trail = async (expected: string[]): Promise<void> => {
      await b.script(
        `const pills = [...document.querySelectorAll('nav.breadcrumbs[aria-label="Breadcrumb"] a.crumb')]; const got = pills.map((a) => a.textContent + (a.getAttribute('aria-current') === 'page' ? '*' : '')).join(' › '); if (got !== ${JSON.stringify(expected.join(' › '))}) throw new Error('The breadcrumbs are ' + got); if (pills.some((a) => !a.getAttribute('href'))) throw new Error('A pill is not a link')`,
      )
    }
    /** Taps the breadcrumb pill that links here. */
    const pill = async (href: string): Promise<void> => {
      await b.tap(`nav.breadcrumbs a.crumb[href="${href}"]`)
    }
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await b.visible('^Backups$|^Projects & apps$|^Install apps$')
      // Runs and builds, then develop, then its latest run.
      await b.open('/projects/fixture/runs')
      await b.visible('The latest runs on every branch.')
      await b.tap(
        'nav.branch-list a[href="/projects/fixture/runs?branch=develop"]',
      )
      await b.visible('The latest runs on develop.')
      await trail([
        'Mason Master',
        'Projects',
        'Fixture',
        'Runs and builds',
        'develop*',
      ])
      // The run page is the web app's: its trail is the app's, from the
      // node's pill through the project's Runs and builds and the branch.
      const appTrail = async (expected: string[]): Promise<void> => {
        await b.script(
          `const got = [...document.querySelectorAll('.m-crumbs li')].map((li) => li.textContent.replace(/[\\uE000-\\uF8FF]/g, '') + (li.querySelector('[aria-current="page"]') ? '*' : '')).join(' › '); if (got !== ${JSON.stringify(expected.join(' › '))}) throw new Error('The breadcrumbs are ' + got)`,
        )
      }
      await b.tap('table.runs tbody tr:first-child a')
      await b.visible('History of develop')
      await at(`/runs/${latest.id}`)
      const run = `Run ${latest.number}`
      const levels = [
        'Mason Master',
        'Projects',
        'Fixture',
        'Runs and builds',
        'develop',
        run,
      ]
      await appTrail([
        'Mason Master',
        'Projects & apps',
        'Fixture',
        'Runs and builds',
        'develop',
        `${run}*`,
      ])
      await b.shot('breadcrumb-run-after.png')
      // From the right back to the first: each crumb opens its level, the
      // server's pages with a full load until their milestones.
      await b.tap('.m-crumbs a[href="/projects/fixture/runs?branch=develop"]')
      await b.visible('The latest runs on develop.')
      await at('/projects/fixture/runs?branch=develop')
      await trail([...levels.slice(0, 4), 'develop*'])
      // Back on the run, its Runs and builds crumb, then the server's pills.
      await b.open(`/runs/${latest.id}`)
      await b.visible('History of develop')
      await b.tap('.m-crumbs a[href="/projects/fixture/runs"]')
      await b.visible('The latest runs on every branch.')
      await at('/projects/fixture/runs')
      await trail([...levels.slice(0, 3), 'Runs and builds*'])
      await pill('/projects/fixture')
      await b.visible('App IDs')
      await at('/projects/fixture')
      await trail([...levels.slice(0, 2), 'Fixture*'])
      await pill('/projects')
      await b.visible('their latest builds and runs')
      await at('/projects')
      // Projects & apps is the web app's, with its own trail; its node pill
      // opens the master's home, Projects & apps again.
      await appTrail(['Mason Master', 'Projects & apps*'])
      await b.tap('.m-crumbs a.m-node-pill[href="/"]')
      await b.visible('their latest builds and runs')
      await b.script(
        "if (location.pathname !== '/') throw new Error('The page is ' + location.pathname)",
      )
      await appTrail(['Mason Master', 'Projects & apps*'])
    } finally {
      await b.close()
    }
  })

  it('E7 a tester installs Alpha’s Android build and reads her devices on the master, through the host', async () => {
    const master = c.master.master!
    const db = master.database.db
    const alpha = Number(
      db.prepare('SELECT id FROM apps WHERE slug=?').get(ALPHA)!.id,
    )
    // A device the master registered for her: the host has it from the change feed.
    const now = Date.now()
    const device = Number(
      db
        .prepare(
          "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,'iPhone14,5','iPhone 13','26.0','registered',?,?)",
        )
        .run('E'.repeat(39) + '7', now, now).lastInsertRowid,
    )
    db.prepare(
      'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?)',
    ).run(people.tess!, device, 'iPhone of Tess', now)
    master.database.change('device', device)
    master.database.change('account', people.tess!)
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            'SELECT 1 FROM account_devices WHERE device_id=?',
          )
          .get(device),
      10_000,
      'her device on the host',
    )
    const b = await browser('mason-e7-tess', c.master, '1280x860')
    try {
      await masterSignIn(b, 'tess', PASSWORDS.tess!)
      // A tester's home on the master is Install apps, read from the host.
      await b.visible('Choose an app to browse recent builds')
      await b.tap(`a.m-list__row[href^="/apps/${alpha}?"]`)
      await b.visible('^Branches with builds for ')
      await b.tap(
        'nav[aria-label="Build platform"] a[href*="platform=android"]',
      )
      await b.visible('^Branches with builds for Android.$')
      await b.visible('^master$')
      await b.shot('master-install-apps.png')
      await b.tap('a.m-list__row[href*="/branches/"]')
      await b.visible('^Android builds · newest first$')
      // An Android build installs by downloading its package: Install asks
      // the host for a grant and the browser downloads it from the master.
      await b.tap('main .m-catalog-build button.m-btn')
      await b.visible('^Downloading ')
      await b.open('/devices')
      await b.visible('^Your devices$')
      await b.visible('^iPhone of Tess$')
      await b.visible('Registered with Apple')
      await b.shot('master-devices-tester.png')
    } finally {
      await b.close()
    }
    // The download, through the master, with her master session.
    const log = 'master-install-relay.log'
    rmSync(path.join(artifacts!, log), { force: true })
    const base = origin(c.master)
    const parameters = (await (
      await pinnedFetch(
        base + '/api/v2/session/parameters',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identifier: 'tess' }),
        },
        c.master.web!.certificate!.pin,
      )
    ).json()) as Json
    const signedIn = await pinnedFetch(
      base + '/api/v2/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: 'tess',
          clientHash: await clientPasswordHash(PASSWORDS.tess!, parameters),
        }),
      },
      c.master.web!.certificate!.pin,
    )
    const { csrf } = (await signedIn.json()) as { csrf: string }
    const session = /^([^;]+)/.exec(signedIn.headers.get('set-cookie')!)![1]!
    const build = db
      .prepare(
        "SELECT id,file_key,digest,size FROM builds WHERE app_id=? AND platform='android' AND branch='master' AND state='ready' ORDER BY id DESC LIMIT 1",
      )
      .get(alpha) as Json
    const stored = await host.host!.objects.get(build.file_key)
    const hash = createHash('sha256')
    for await (const chunk of stored!.stream) hash.update(chunk as Buffer)
    const hostSha = hash.digest('hex')
    type Reply = Awaited<ReturnType<typeof pinnedFetch>>
    const curl = async (
      shown: string,
      route: string,
      init: {
        method?: string
        headers?: Record<string, string>
        body?: string
      },
      describe: (reply: Reply, body: Buffer) => string,
    ): Promise<{ reply: Reply; body: Buffer }> => {
      const reply = await pinnedFetch(
        base + route,
        {
          redirect: 'manual',
          ...init,
          // Only Install needs her session; a grant's URLs carry none.
          headers: {
            ...(route.startsWith('/install/') ? {} : { cookie: session }),
            ...init.headers,
          },
        },
        c.master.web!.certificate!.pin,
      )
      const body = Buffer.from(await reply.arrayBuffer())
      appendFileSync(
        path.join(artifacts!, log),
        `$ curl ${shown} ${base}${route.replace(/\/install\/[^/]+\//, '/install/<token>/')}\n${describe(reply, body)}\n\n`,
      )
      return { reply, body }
    }
    const header = (reply: Reply, name: string): string =>
      `${name}: ${reply.headers.get(name) ?? '(none)'}`
    const install = await curl(
      "-sS -b '__Host-mason-master=<tess>' -H 'X-Mason-CSRF: <csrf>' -X POST",
      `/api/v2/catalog/builds/${build.id}/install`,
      {
        method: 'POST',
        headers: { origin: base, 'x-mason-csrf': csrf },
      },
      (reply, body) =>
        `HTTP ${reply.status}\n${body.toString().replace(/\/install\/[^/]+\//, '/install/<token>/')}`,
    )
    assert.equal(install.reply.status, 200)
    const answer = JSON.parse(install.body.toString()) as {
      kind: string
      url: string
    }
    assert.equal(answer.kind, 'download')
    const artifact = answer.url
    assert.match(artifact, /^\/install\/[^/]+\/artifact$/)
    const full = await curl(
      '-sS -o alpha.apk -w "%{http_code}"',
      artifact,
      {},
      (reply, body) =>
        [
          `HTTP ${reply.status}`,
          header(reply, 'content-type'),
          header(reply, 'content-length'),
          header(reply, 'accept-ranges'),
          `$ shasum -a 256 alpha.apk`,
          `${sha(body)}  alpha.apk`,
          `host's file ${build.file_key}: ${hostSha}`,
          sha(body) === hostSha ? 'match' : 'MISMATCH',
        ].join('\n'),
    )
    assert.equal(full.reply.status, 200)
    assert.equal(sha(full.body), hostSha)
    assert.equal(hostSha, build.digest)
    const head = await curl(
      '-sS -I',
      artifact,
      { method: 'HEAD' },
      (reply, body) =>
        [
          `HTTP ${reply.status}`,
          header(reply, 'content-length'),
          header(reply, 'etag'),
          `body: ${body.length} bytes`,
        ].join('\n'),
    )
    assert.equal(head.reply.status, 200)
    assert.equal(head.body.length, 0)
    const range = await curl(
      "-sS -i -H 'Range: bytes=0-99'",
      artifact,
      { headers: { range: 'bytes=0-99' } },
      (reply, body) =>
        [
          `HTTP ${reply.status}`,
          header(reply, 'content-range'),
          header(reply, 'content-length'),
          `body: ${body.length} bytes`,
        ].join('\n'),
    )
    assert.equal(range.reply.status, 206)
    assert.equal(
      range.reply.headers.get('content-range'),
      `bytes 0-99/${build.size}`,
    )
    const beyond = await curl(
      `-sS -i -H 'Range: bytes=${build.size}-'`,
      artifact,
      { headers: { range: `bytes=${build.size}-` } },
      (reply) =>
        [`HTTP ${reply.status}`, header(reply, 'content-range')].join('\n'),
    )
    assert.equal(beyond.reply.status, 416)
    assert.equal(
      beyond.reply.headers.get('content-range'),
      `bytes */${build.size}`,
    )
  })

  it('E8 an app ID’s page lists only its runs, and a number set on the master shows read-only on the host', async () => {
    const page = `/projects/fixture/apps/${BETA}`
    // Above every number alpha's shared sequence issued today: YYMMDD then 90.
    const last = `${new Date().toISOString().slice(2, 10).replaceAll('-', '')}90`
    const b = await browser('mason-e8-paul', c.master, '1280x860')
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await b.visible('^Backups$|^Projects & apps$|^Install apps$')
      await b.open(page)
      await b.visible(`^${BETA.replaceAll('.', '\\.')}$`)
      await b.visible('^Runs and builds$')
      // Only build-beta's runs, one per branch it ran on.
      await holds(
        b,
        "document.querySelectorAll('table.m-runs tbody tr').length === 2",
        'build-beta’s two runs',
      )
      await b.script(
        `const rows = [...document.querySelectorAll('table.m-runs tbody tr')].map((row) => row.querySelector('.m-t-headline').textContent); if (rows.length !== 2 || rows.some((text) => !text.includes('build-beta'))) throw new Error('The runs are ' + rows.join(' | '))`,
      )
      await b.script(
        `const ids = [...document.querySelectorAll('table.m-runs tbody tr')].map((row) => row.dataset.runId).sort().join(); if (ids !== ${JSON.stringify([runs['build-beta@master'].id, runs['build-beta@develop'].id].sort().join())}) throw new Error('The runs are ' + ids)`,
      )
      await b.shot('app-id-runs.png')
      await b.tap(`nav.m-tabs a[href="${page}/build-numbers"]`)
      await holds(
        b,
        `document.querySelector('[data-shared]')?.textContent === 'Shared with${ALPHA}'`,
        'shared with alpha',
      )
      await b.tap('.m-card__header button[aria-haspopup="dialog"]')
      await holds(
        b,
        'document.querySelector(\'form[name="seed"]\') != null',
        'the sheet',
      )
      await b.type('form[name="seed"] input[name="last"]', last)
      await b.shot('app-id-build-numbers.png')
      await b.tap('.m-formsheet__foot .m-btn--primary')
      // The sheet closes and the facts read again with the new number.
      await holds(
        b,
        `document.querySelector('form[name="seed"]') == null && document.querySelector('dl.m-kv')?.textContent.includes(${JSON.stringify(last)})`,
        'the new number',
      )
    } finally {
      await b.close()
    }
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare(
              "SELECT details FROM projects WHERE slug='fixture'",
            )
            .get() as { details: string }
        ).details.includes(`"${last}"`),
      10_000,
      'the new number on the host',
    )
    const h = await browser('mason-e8-dev', host, '1280x860')
    try {
      await hostSignIn(h, 'dev', PASSWORDS.dev!, `${page}/build-numbers`)
      await holds(
        h,
        `document.querySelector('[data-shared]')?.textContent === 'Shared with${ALPHA}' && document.querySelector('dl.m-kv')?.textContent.includes(${JSON.stringify(last)})`,
        'the number on the host',
      )
      await h.gone('Set where it stands')
    } finally {
      await h.close()
    }
  })

  it('E10 the App IDs table starts every row’s platform chips at one left edge under its header, a chip’s gap apart, and each row links to its app ID page', async () => {
    const log = 'app-ids-card-alignment.log'
    rmSync(path.join(artifacts!, log), { force: true })
    // Each App IDs row: its link, the left edge of its Platforms cell and of
    // each chip, and the gaps between adjacent chips, in CSS pixels.
    const measure = `return JSON.stringify({ head: document.querySelector('table.m-appids thead th:nth-child(2)').getBoundingClientRect().left, rows: [...document.querySelectorAll('table.m-appids tbody tr')].map((row) => { const link = row.querySelector('a.m-appids__link'); const chips = [...row.querySelectorAll('.m-appids__platforms .m-chip')].map((chip) => chip.getBoundingClientRect()); return { id: link.textContent, href: link.getAttribute('href'), cell: row.querySelector('td:nth-child(2)').getBoundingClientRect().left, lefts: chips.map((box) => box.left), gaps: chips.slice(1).map((box, i) => box.left - chips[i].right) } }) })`
    const b = await browser('mason-e10-paul', c.master, '1280x860')
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await b.visible('^Backups$|^Projects & apps$|^Install apps$')
      await b.open('/projects/fixture')
      await b.visible('App IDs')
      await b.visible(`^${BETA.replaceAll('.', '\\.')}$`)
      // maestro-d's evalBrowserScript answers with the script's return value as a string.
      const reply = (await b.script(measure)) as { data?: unknown }
      assert.equal(typeof reply.data, 'string', JSON.stringify(reply))
      const measured = JSON.parse(reply.data as string) as {
        head: number
        rows: Array<{
          id: string
          href: string
          cell: number
          lefts: number[]
          gaps: number[]
        }>
      }
      writeFileSync(
        path.join(artifacts!, log),
        [
          `$ device.command('evalBrowserScript', { script }) on ${origin(c.master)}/projects/fixture at 1280x860, where script is:`,
          measure,
          '',
          `Platforms column header left: ${measured.head}px`,
          ...measured.rows.map(
            (row) =>
              `${row.id} → ${row.href}\n  Platforms cell left: ${row.cell}px\n  chip lefts: ${row.lefts.map((left) => `${left}px`).join(', ')}\n  gaps between adjacent chips: ${row.gaps.length === 0 ? '(one chip)' : row.gaps.map((gap) => `${gap}px`).join(', ')}`,
          ),
          '',
          `first chips' left edges: ${[...new Set(measured.rows.map((row) => row.lefts[0]))].join(', ')}px (${new Set(measured.rows.map((row) => row.lefts[0])).size === 1 ? 'one edge' : 'NOT ALIGNED'}); largest gap: ${Math.max(...measured.rows.flatMap((row) => row.gaps))}px`,
          '',
        ].join('\n'),
      )
      assert.deepEqual(
        measured.rows.map((row) => [row.id, row.href, row.lefts.length]),
        [
          [ALPHA, `/projects/fixture/apps/${ALPHA}`, 2],
          [BETA, `/projects/fixture/apps/${BETA}`, 1],
        ],
      )
      // One left edge for the Platforms column, header included, whatever the app ID's length.
      const first = measured.rows[0]!.lefts[0]!
      for (const row of measured.rows) {
        assert.equal(row.cell, measured.head, row.id)
        assert.equal(row.lefts[0], first, row.id)
        assert(row.lefts[0]! > row.cell, row.id)
        for (const gap of row.gaps) assert(gap >= 0 && gap <= 12, `${gap}px`)
      }
      await b.shot('app-ids-card-after.png')
      // The keyboard: from the top, Tab walks the skip link, the shell and
      // the Overview in visual order, each stop with a visible focus ring;
      // Reduce Motion calms the sheets and the editor.
      const stops: string[] = []
      await b.script('document.activeElement?.blur(); window.scrollTo(0, 0)')
      for (let n = 0; n < 40; n++) {
        await b.command('pressKey', { key: 'Tab' })
        stops.push(
          await value(
            b,
            "(() => { const e = document.activeElement; const s = getComputedStyle(e); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none'; return (ring ? 'ring ' : 'NO RING ') + e.tagName.toLowerCase() + ' ' + (e.getAttribute('aria-label') || e.textContent || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 60) })()",
          ),
        )
      }
      const calm = await value(
        b,
        "[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.media?.mediaText.includes('prefers-reduced-motion')).map((rule) => rule.cssText).filter((text) => text.includes('m-formsheet') && text.includes('m-editor')).length",
      )
      writeFileSync(
        path.join(artifacts!, 'project-tab-order.log'),
        `$ Tab ×40 on ${origin(c.master)}/projects/fixture at 1280x860\n${stops.map((stop, n) => `${n + 1}. ${stop}`).join('\n')}\n$ reduced-motion rules covering the sheets and the editor: ${calm}\n`,
      )
      assert.match(stops[0]!, /^ring a Skip to content$/)
      assert.deepEqual(
        stops.filter(
          (stop) =>
            stop.startsWith('NO RING') && !stop.startsWith('NO RING body'),
        ),
        [],
        stops.join('\n'),
      )
      assert(
        stops.some((stop) => stop.includes(`a ${ALPHA}`)),
        stops.join('\n'),
      )
      assert(Number(calm) >= 1, calm)
      // The app ID opens its page.
      await b.tap(
        `table.m-appids a.m-appids__link[href="/projects/fixture/apps/${ALPHA}"]`,
      )
      await b.visible('^Shared with|^Runs and builds$')
      await b.script(
        `if (location.pathname !== ${JSON.stringify(`/projects/fixture/apps/${ALPHA}`)}) throw new Error('The row opened ' + location.pathname)`,
      )
    } finally {
      await b.close()
    }
  })

  it('E9 on Projects & apps the card’s title opens the project, alpha’s app ID its page, and a build chip its run', async () => {
    const alphaPage = `/projects/fixture/apps/${ALPHA}`
    const b = await browser('mason-e9-paul', c.master, '1280x860')
    /** Fails unless the page is at this path. */
    const at = async (where: string): Promise<void> => {
      await b.script(
        `if (location.pathname !== ${JSON.stringify(where)}) throw new Error('The page is ' + location.pathname)`,
      )
    }
    /**
     * Clicks with the mouse at the middle of the element `css` names,
     * after checking the link hit there is `href`: the click lands on what
     * a person's would.
     */
    const click = async (css: string, href: string): Promise<void> => {
      const reply = (await b.script(
        `const target = document.querySelector(${JSON.stringify(css)}); target.scrollIntoView({ block: 'center' }); const box = target.getBoundingClientRect(); const x = Math.round(box.left + box.width / 2); const y = Math.round(box.top + box.height / 2); const hit = document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'); if (hit !== ${JSON.stringify(href)}) throw new Error('At ' + x + ',' + y + ' the link is ' + hit); return JSON.stringify({ x, y })`,
      )) as { data?: unknown }
      const point = JSON.parse(String(reply.data)) as { x: number; y: number }
      await b.command('tapOnPoint', point)
    }
    const back = async (): Promise<void> => {
      await b.script('history.back()')
      await b.visible('their latest builds and runs')
      await at('/projects')
    }
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await b.visible('^Backups$|^Projects & apps$|^Install apps$')
      await b.open('/projects')
      await b.visible('their latest builds and runs')
      await b.visible(`^${BETA.replaceAll('.', '\\.')}$`)
      // The keyboard: from the top, Tab walks the skip link, the shell and
      // the page in visual order, each stop with a visible focus ring.
      const stops: string[] = []
      await b.script('document.activeElement?.blur(); window.scrollTo(0, 0)')
      for (let n = 0; n < 40; n++) {
        await b.command('pressKey', { key: 'Tab' })
        const reply = (await b.script(
          "const e = document.activeElement; const s = getComputedStyle(e); const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 || s.boxShadow !== 'none'; return (ring ? 'ring ' : 'NO RING ') + e.tagName.toLowerCase() + ' ' + (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 60)",
        )) as { data?: unknown }
        stops.push(String(reply.data))
      }
      writeFileSync(
        path.join(artifacts!, 'dashboard-tab-order.log'),
        `$ Tab ×40 on ${origin(c.master)}/projects at 1280x860\n${stops.map((stop, n) => `${n + 1}. ${stop}`).join('\n')}\n`,
      )
      assert.match(stops[0]!, /^ring a Skip to content$/)
      assert.deepEqual(
        // Past the last stop focus leaves the page (the body), then wraps.
        stops.filter(
          (stop) =>
            stop.startsWith('NO RING') && !stop.startsWith('NO RING body'),
        ),
        [],
      )
      const place = (pattern: RegExp): number =>
        stops.findIndex((stop) => pattern.test(stop))
      assert(place(/All \d/) > 0, stops.join('\n'))
      assert(place(/All \d/) < place(/Filter app IDs/), stops.join('\n'))
      assert(
        place(/Filter app IDs/) < place(/Fixture\s*Default branch/),
        stops.join('\n'),
      )
      // Alpha's row: a chip per branch it built, newest first, each opening its run.
      const alphaRow = `#project-fixture li.m-approw:has(a[href="${alphaPage}"])`
      await b.script(
        `const row = document.querySelector(${JSON.stringify(alphaRow)}); const chips = [...row.querySelectorAll('a.m-runchip:not(.m-runchip--more)')].map((chip) => chip.getAttribute('href') + ' ' + chip.querySelector('.m-runchip__branch').textContent).join(); if (chips !== ${JSON.stringify(
          [
            `/runs/${runs['build-alpha@develop'].id} develop`,
            `/runs/${runs['build-alpha@master'].id} master`,
          ].join(),
        )}) throw new Error('The chips are ' + chips)`,
      )
      await b.shot('projects-card-after.png')
      // The card's title: the project (the node's own page, a full load).
      await click('#project-fixture header h2', '/projects/fixture')
      await b.visible('App IDs')
      await at('/projects/fixture')
      await back()
      // Alpha's app ID: its page.
      await click(`${alphaRow} a.m-approw__id`, alphaPage)
      await b.visible('^Runs and builds$')
      await at(alphaPage)
      await back()
      // A build chip in alpha's row: its run.
      const run = runs['build-alpha@master']
      await click(
        `${alphaRow} a.m-runchip[href="/runs/${run.id}"]`,
        `/runs/${run.id}`,
      )
      await b.visible('History of master')
      await at(`/runs/${run.id}`)
    } finally {
      await b.close()
    }
  })

  it('E11 a developer on the host scrolls a 100,000-line log drawn a window at a time, follows it live over the link, goes to its end with the round button, and reads it again once the run is finished', async () => {
    const master = c.master.master!
    rmSync(STREAM_GATE, { force: true })
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'fixture',
      branch: 'develop',
      workflow: 'stream',
    })
    assert.equal(created.status, 202, created.text)
    const id = String(created.json.id)
    await c.until(
      () => {
        const file = master.scheduler.logFile(id, 'stream')
        return (
          existsSync(file) && readFileSync(file, 'utf8').includes('waiting 3')
        )
      },
      120_000,
      'the stream stage logging',
    )
    await c.until(
      () =>
        host.host!.cache.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id),
      10_000,
      'the run on the host',
    )
    const h = await browser('mason-e11-dev', host, '1280x860')
    // The web app's log viewer: a scrolling body, its round button to the
    // end, and the lines in view, each numbered.
    const pre = "document.querySelector('.m-log__body')"
    const button = "document.querySelector('.m-log__end')"
    const rows = "[...document.querySelectorAll('.m-log__line')]"
    /** The highest line number drawn. */
    const last = `Math.max(0, ...${rows}.map((l) => Number(l.dataset.line)))`
    /** A drawn line's text. */
    const lineText = "(l) => l.querySelector('.m-log__t').textContent"
    /** Whether a line with this text is drawn. */
    const drawn = (text: string): string =>
      `${rows}.map(${lineText}).includes(${JSON.stringify(text)})`
    /** No more than a window of lines is in the page. */
    const windowed = `(${rows}.length > 0 && ${rows}.length < 1500)`
    const atEnd = `(${pre}.scrollHeight - ${pre}.scrollTop - ${pre}.clientHeight < 2)`
    const scrollTo = async (fraction: number): Promise<void> => {
      await h.script(
        `${pre}.scrollTop = (${pre}.scrollHeight - ${pre}.clientHeight) * ${fraction}; ${pre}.dispatchEvent(new Event('scroll'))`,
      )
    }
    /** Waits until the page's condition holds, or fails saying what did not. */
    const holds = async (condition: string, what: string): Promise<void> => {
      const deadline = Date.now() + 20_000
      for (;;) {
        try {
          await h.script(
            `if (!(${condition})) throw new Error(${JSON.stringify(what)} + ': ' + ${rows}.length + ' rows, last ' + ${last})`,
          )
          return
        } catch (error) {
          if (Date.now() > deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    }
    /** Waits for lines numbered past those drawn now. */
    const more = async (what: string, also = 'true'): Promise<void> => {
      await h.script(`window.__last = ${last}`)
      await holds(`${last} > window.__last + 2 && ${also}`, what)
    }
    try {
      await hostSignIn(h, 'dev', PASSWORDS.dev!, `/runs/${id}?stage=stream`)
      // The running stage opens at its end, its new lines live from the
      // master over the host's link, with only a window of lines drawn and
      // no button while it follows.
      await holds(
        `${rows}.map(${lineText}).some((t) => /^waiting \\d+$/.test(t)) && ${windowed}`,
        'the live log',
      )
      await more('new lines', `${atEnd} && ${button}.hidden && ${windowed}`)
      // Scrolled to its top, the lines there are asked for over the link.
      await scrollTo(0)
      await holds(`${drawn('stream line 1')} && ${windowed}`, 'the top')
      await holds(`!${button}.hidden`, 'the button shown')
      await h.script(
        "document.querySelector('.m-log').scrollIntoView({ block: 'end' })",
      )
      await h.shot('host-live-log-button.png')
      // Halfway down: the middle of the log, still a window.
      await scrollTo(0.5)
      await holds(
        `${rows}.map(${lineText}).some((t) => /^stream line [4-5]\\d{4}$/.test(t)) && ${windowed}`,
        'the middle',
      )
      // The button goes to the end and follows again, then hides.
      await h.tap('.m-log__end')
      await more('lines while following', `${atEnd} && ${button}.hidden`)
      // Wrapped lines are measured, and the log still scrolls to its top.
      await h.tap('.m-log [data-wrap]')
      await scrollTo(0)
      await holds(drawn('stream line 1'), 'the top, wrapped')
      await h.tap('.m-log [data-wrap]')
      // The run ends: its log is asked for a window at a time, through the host.
      writeFileSync(STREAM_GATE, '')
      await c.until(
        () =>
          (
            host
              .host!.cache.db.prepare('SELECT status FROM jobs WHERE id=?')
              .get(id) as { status: string } | undefined
          )?.status === 'succeeded',
        60_000,
        'the run finished on the host',
      )
      await h.open(`/runs/${id}?stage=stream`)
      // A finished log opens at its start, with the button to its end.
      await holds(`${drawn('stream line 1')} && ${windowed}`, 'the start')
      await holds(`${pre}.scrollTop === 0 && !${button}.hidden`, 'the button')
      await h.script(
        "document.querySelector('.m-log').scrollIntoView({ block: 'end' })",
      )
      await h.shot('host-finished-log.png')
      await h.tap('.m-log__end')
      await holds(
        `${atEnd} && ${button}.hidden && ${drawn('stream done')} && ${windowed}`,
        'the end of the log',
      )
      // So is the whole run's, its stages one after another.
      await h.open(`/runs/${id}`)
      await holds(windowed, 'the whole run log')
      await h.tap('.m-log__end')
      await holds(drawn('stream done'), 'the whole run log’s end')
    } finally {
      await h.close()
      rmSync(STREAM_GATE, { force: true })
    }
    // The master's own page draws a window too, from its first chunk.
    const m = await browser('mason-e11-master', c.master, '1280x860')
    /** Waits until the master's page holds, or fails saying what did not. */
    const shows = async (condition: string, what: string): Promise<void> => {
      const deadline = Date.now() + 20_000
      for (;;) {
        try {
          await m.script(
            `if (!(${condition})) throw new Error(${JSON.stringify(what)})`,
          )
          return
        } catch (error) {
          if (Date.now() > deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    }
    try {
      await masterSignIn(m, 'paul', PASSWORDS.paul!)
      await shows("location.pathname !== '/sign-in'", 'signed in')
      await m.open(`/runs/${id}?stage=stream`)
      await shows(`${drawn('stream line 1')} && ${windowed}`, 'the start')
      await m.script(
        `${pre}.scrollTop = ${pre}.scrollHeight; ${pre}.dispatchEvent(new Event('scroll'))`,
      )
      await shows(`${drawn('stream done')} && ${windowed}`, 'the end')
    } finally {
      await m.close()
    }
  })

  /** A value the page computes, read back through the driver as text. */
  const value = async (b: Browser, expression: string): Promise<string> =>
    String(
      ((await b.script(`return String(${expression})`)) as { data?: unknown })
        ?.data ?? '',
    )

  /** Sets a React-controlled field's value as typing would (a select's too). */
  const fill = async (b: Browser, css: string, text: string): Promise<void> => {
    await b.script(
      `const e = document.querySelector(${JSON.stringify(css)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))`,
    )
  }
  /** Presses the button whose words are `text` (its icon's glyph aside), inside `scope` (the page by default). */
  const press = async (
    b: Browser,
    text: string,
    scope = 'document',
  ): Promise<void> => {
    await b.script(
      `const button = [...${scope === 'document' ? 'document' : `document.querySelector(${JSON.stringify(scope)})`}.querySelectorAll('button, [role=menuitem]')].find((e) => e.textContent.replace(/[\\uE000-\\uF8FF]/g, '').trim() === ${JSON.stringify(text)} && !e.disabled); if (button == null) throw new Error('No button ' + ${JSON.stringify(text)}); button.click()`,
    )
  }
  /** Waits until the page's expression is true, or fails saying what did not happen. */
  const holds = async (
    b: Browser,
    expression: string,
    what: string,
  ): Promise<void> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const done = await value(b, `Boolean(${expression})`).catch(() => '')
      if (done === 'true') return
      if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  it('N2 Appearance moves Dark → Light → Match system from the account menu, applies before the first paint, and persists across reloads', async () => {
    const log = 'appearance.log'
    const b = await browser('mason-n2', c.master, '1440x900')
    const note = (line: string): void =>
      appendFileSync(path.join(artifacts!, log), `${line}\n`)
    writeFileSync(path.join(artifacts!, log), '')
    /** The theme on <html>, what storage holds, the page's canvas colour. */
    const theme = async (): Promise<string> =>
      String(
        await value(
          b,
          "[document.documentElement.dataset.theme, localStorage.getItem('mason-appearance'), getComputedStyle(document.body).backgroundColor].join(' | ')",
        ),
      )
    /** theme-boot.js ran, parser-blocking in <head>, before the first paint. */
    const beforePaint = async (): Promise<void> => {
      const order = String(
        await value(
          b,
          "[...document.head.children].filter((e) => e.matches('script[src], link[rel=stylesheet]')).map((e) => (e.src || e.href).replace(location.origin, '') + (e.async || e.defer || e.type === 'module' ? ' (deferred)' : '')).join(', ')",
        ),
      )
      note(`head order: ${order}`)
      assert.match(
        order,
        /^\/assets\/web\/theme-boot\.js, \/assets\/web\/app-[^,]+\.css, \/assets\/web\/app-[^ ]+\.js \(deferred\)$/,
      )
      const timing = (await value(
        b,
        "JSON.stringify((() => { const boot = performance.getEntriesByType('resource').find((e) => e.name.endsWith('/theme-boot.js')); const paint = performance.getEntriesByType('paint')[0]; return { boot: boot && boot.responseEnd, paint: paint && paint.startTime } })())",
      ).then((text) => JSON.parse(text))) as { boot?: number; paint?: number }
      note(
        `theme-boot.js loaded at ${timing.boot?.toFixed(1)} ms, first paint at ${timing.paint?.toFixed(1)} ms`,
      )
      assert(timing.boot != null && timing.paint != null)
      assert(timing.boot < timing.paint, JSON.stringify(timing))
    }
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await holds(b, "location.pathname !== '/sign-in'", 'signed in')
      await b.open('/_web/projects')
      await holds(
        b,
        "document.querySelector('h1')?.textContent === 'Projects & apps'",
        'the shell',
      )
      const dark = await theme()
      note(`$ open /_web/projects\n  ${dark}`)
      assert.match(dark, /^dark \| {2}\| /)
      await b.tap('button[aria-label="Your account"]')
      await holds(
        b,
        "document.querySelector('[role=menu]') != null",
        'the account menu',
      )
      await b.command('tapOn', { text: 'Light' })
      await holds(
        b,
        "document.documentElement.dataset.theme === 'light'",
        'the light theme',
      )
      const light = await theme()
      note(`$ account menu → Appearance → Light\n  ${light}`)
      assert.match(light, /^light \| light \| /)
      assert.notEqual(light.split(' | ')[2], dark.split(' | ')[2])
      await b.open('/_web/projects')
      await holds(
        b,
        "document.querySelector('h1')?.textContent === 'Projects & apps'",
        'the reload',
      )
      const reloaded = await theme()
      note(`$ reload\n  ${reloaded}`)
      assert.equal(reloaded, light)
      await beforePaint()
      await b.shot('appearance-light.png')
      await b.tap('button[aria-label="Your account"]')
      await holds(
        b,
        "document.querySelector('[role=menu]') != null",
        'the account menu',
      )
      await b.command('tapOn', { text: 'Match system' })
      await holds(
        b,
        "localStorage.getItem('mason-appearance') === 'system'",
        'Match system',
      )
      const system = String(
        await value(
          b,
          "matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'",
        ),
      )
      await b.open('/_web/projects')
      await holds(
        b,
        "document.querySelector('h1')?.textContent === 'Projects & apps'",
        'the reload',
      )
      const matched = await theme()
      note(
        `$ account menu → Appearance → Match system; reload (the system is ${system})\n  ${matched}`,
      )
      assert.match(matched, new RegExp(`^${system} \\| system \\| `))
    } finally {
      await b.close()
    }
  })

  it('N3 ⌘K finds a run by its number and by its commit, and Enter opens it', async () => {
    const master = c.master.master!
    const run = runs['build-beta@develop']
    const sha = String(
      (
        master.database.db
          .prepare('SELECT commit_sha FROM jobs WHERE id=?')
          .get(run.id) as { commit_sha: string }
      ).commit_sha,
    )
    const log = 'palette.log'
    writeFileSync(path.join(artifacts!, log), '')
    const note = (line: string): void =>
      appendFileSync(path.join(artifacts!, log), `${line}\n`)
    const b = await browser('mason-n3', c.master, '1440x900')
    /** The palette's options, as the viewer reads them. */
    const options = async (): Promise<string> =>
      String(
        await value(
          b,
          "[...document.querySelectorAll('[role=option]')].map((o) => (o.getAttribute('aria-selected') === 'true' ? '> ' : '  ') + o.querySelector('.m-list__main').innerText.replace(/\\n/g, ' · ')).join('\\n')",
        ),
      )
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await holds(b, "location.pathname !== '/sign-in'", 'signed in')
      await b.open('/_web/projects')
      await holds(
        b,
        "document.querySelector('h1')?.textContent === 'Projects & apps'",
        'the shell',
      )
      // By its number: ⌘K, the number, Enter.
      await b.command('pressKey', { key: 'Meta+k' })
      await holds(
        b,
        "document.activeElement?.getAttribute('role') === 'combobox'",
        'the palette',
      )
      await b.command('inputText', { text: `#${run.number}` })
      await holds(
        b,
        `[...document.querySelectorAll('[role=option]')].some((o) => o.textContent.includes('Run ${run.number}'))`,
        'the run by number',
      )
      note(`$ ⌘K, type #${run.number}\n${await options()}`)
      const byNumber = String(
        await value(
          b,
          "document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).textContent",
        ),
      )
      assert.match(byNumber, new RegExp(`Run ${run.number}\\b`))
      await b.command('pressKey', { key: 'Enter' })
      await holds(
        b,
        `location.pathname === '/_web/runs/${run.id}' && document.activeElement?.tagName === 'H1'`,
        'the run page',
      )
      note(
        `$ Enter\n  → ${String(await value(b, 'location.pathname'))}, focus on the h1 "${String(await value(b, 'document.activeElement.textContent'))}"`,
      )
      // By its commit: ⌘K, the SHA's first 8, Enter.
      await b.command('pressKey', { key: 'Meta+k' })
      await holds(
        b,
        "document.activeElement?.getAttribute('role') === 'combobox'",
        'the palette',
      )
      await b.command('inputText', { text: sha.slice(0, 8) })
      await holds(
        b,
        `[...document.querySelectorAll('[role=group][aria-label=Commits] [role=option]')].length > 0`,
        'the commit',
      )
      note(`$ ⌘K, type ${sha.slice(0, 8)}\n${await options()}`)
      await b.shot('palette-run.png')
      await b.command('pressKey', { key: 'Enter' })
      await holds(
        b,
        "location.pathname.startsWith('/_web/runs/') && document.querySelector('dialog') == null",
        'the run from its commit',
      )
      const opened = String(await value(b, 'location.pathname'))
      note(`$ Enter\n  → ${opened}`)
      const commitOf = (
        master.database.db
          .prepare('SELECT commit_sha FROM jobs WHERE id=?')
          .get(decodeURIComponent(opened.replace('/_web/runs/', ''))) as {
          commit_sha: string
        }
      ).commit_sha
      assert.equal(commitOf, sha)
    } finally {
      await b.close()
    }
  })

  it('N4 an administrator requests a run from the run page’s sheet, follows it live to its approval, approves it, and cancels another after the confirm', async () => {
    const master = c.master.master!
    const log = 'run-actions.log'
    writeFileSync(path.join(artifacts!, log), '')
    const note = (line: string): void =>
      appendFileSync(path.join(artifacts!, log), `${line}\n`)
    const b = await browser('mason-n4', c.master, '1440x900')
    const status = (): Promise<string> =>
      value(b, "document.querySelector('[data-run-status]')?.dataset.runStatus")
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await holds(b, "location.pathname !== '/sign-in'", 'signed in')
      const from = runs['build-alpha@master']
      await b.open(`/runs/${from.id}`)
      await holds(
        b,
        "document.querySelector('[data-run-status]') != null",
        'the run page',
      )
      // The keyboard: from the top, Tab walks the skip link, the shell and
      // the run page in visual order, each stop with a visible focus ring
      // (a graph bubble's ring is its disc's stroke).
      const stops: string[] = []
      await b.script('document.activeElement?.blur(); window.scrollTo(0, 0)')
      for (let n = 0; n < 45; n++) {
        await b.command('pressKey', { key: 'Tab' })
        stops.push(
          await value(
            b,
            "(() => { const e = document.activeElement; const s = getComputedStyle(e); const disc = e.classList?.contains('m-gbubble') ? getComputedStyle(e.querySelector('.m-gbubble__disc')).strokeWidth : ''; const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none' || disc === '3px'; return (ring ? 'ring ' : 'NO RING ') + e.tagName.toLowerCase() + ' ' + (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 60) })()",
          ),
        )
      }
      // Reduce Motion stops the running ring and the graph's fades.
      const calm = await value(
        b,
        "[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.media?.mediaText.includes('prefers-reduced-motion')).map((rule) => rule.cssText).filter((text) => text.includes('m-gbubble__ring') || text.includes('m-dot--live')).length",
      )
      writeFileSync(
        path.join(artifacts!, 'run-tab-order.log'),
        `$ Tab ×45 on ${origin(c.master)}/runs/${from.id} at 1440x900\n${stops.map((stop, n) => `${n + 1}. ${stop}`).join('\n')}\n$ reduced-motion rules covering the graph ring and live dot: ${calm}\n`,
      )
      assert.match(stops[0]!, /^ring a Skip to content$/)
      assert.deepEqual(
        stops.filter(
          (stop) =>
            stop.startsWith('NO RING') && !stop.startsWith('NO RING body'),
        ),
        [],
        stops.join('\n'),
      )
      assert(Number(calm) >= 2, calm)
      // The sheet: master, the release workflow, its typed parameter.
      await b.tap('.m-page__actions button[aria-haspopup="dialog"]')
      await holds(
        b,
        'document.querySelector(\'form[name="request-run"]\') != null',
        'the sheet',
      )
      await b.script(
        "const s = document.querySelector('form[name=\"request-run\"] select[name=\"workflow\"]'); if (![...s.options].some((o) => o.value === 'release')) throw new Error('The workflows are ' + [...s.options].map((o) => o.value)); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'release'); s.dispatchEvent(new Event('change', { bubbles: true }))",
      )
      await holds(
        b,
        "document.body.textContent.includes('Parameters of release')",
        'the release’s parameters',
      )
      await b.shot('request-run-sheet.png')
      // Marks the page: a reload would lose it, so what follows is live.
      await b.script('window.__n4 = true')
      await b.tap('.m-formsheet__foot .m-btn--primary')
      await holds(
        b,
        `location.pathname.startsWith('/runs/') && location.pathname !== '/runs/${from.id}' && window.__n4 === true`,
        'the new run, in the same page',
      )
      const id = decodeURIComponent(
        String(await value(b, 'location.pathname')).replace('/runs/', ''),
      )
      const job = master.run(id) as Json
      assert.equal(job.workflow, 'release')
      note(
        `$ Request run: master, release, channel testers\n  → /runs/${id} (Run ${job.number})`,
      )
      // Followed live to its approval: the status, the bubble, the box.
      await holds(
        b,
        "['running', 'awaiting_approval'].includes(document.querySelector('[data-run-status]')?.dataset.runStatus) && document.querySelector('.m-gbubble[data-stage=\"approve\"]')?.dataset.status === 'awaiting_approval' && document.querySelector('[data-approval=\"approve\"]') != null && window.__n4 === true",
        'the approval, live',
      )
      note(
        `  live: status ${await status()}, approve awaiting_approval, no reload`,
      )
      await b.type('[data-approval="approve"] input', 'First release')
      await b.shot('run-approve.png')
      await b.tap('[data-approval="approve"] .m-btn--primary')
      await holds(
        b,
        "document.querySelector('[data-run-status]')?.dataset.runStatus === 'succeeded' && document.querySelector('[data-approval]') == null && window.__n4 === true",
        'the run finished after the approval, live',
      )
      const approved = master.database.db
        .prepare("SELECT status FROM job_stages WHERE job_id=? AND name='ship'")
        .get(id) as { status: string }
      assert.equal(approved.status, 'succeeded')
      note(
        `$ Approve (notes "First release")\n  live: status ${await status()}, ship ${approved.status}`,
      )
      // Another run, running: Cancel run asks first.
      rmSync(STREAM_GATE, { force: true })
      const other = await c.api('POST', '/api/v2/runs', {
        project: 'fixture',
        branch: 'develop',
        workflow: 'stream',
      })
      assert.equal(other.status, 202, other.text)
      await b.open(`/runs/${other.json.id}`)
      await holds(
        b,
        "document.querySelector('[data-run-status]')?.dataset.runStatus === 'running'",
        'the other run running',
      )
      await b.script('window.__n4 = true')
      await b.tap('.m-page__actions .m-btn--danger')
      await holds(
        b,
        "document.querySelector('[role=alertdialog]') != null",
        'the confirm',
      )
      await b.shot('run-cancel-confirm.png')
      await b.tap('[role=alertdialog] .m-btn--danger-filled')
      await holds(
        b,
        "document.querySelector('[data-run-status]')?.dataset.runStatus === 'cancelled' && window.__n4 === true",
        'the cancel, live',
      )
      assert.equal(
        (master.run(String(other.json.id)) as Json).status,
        'cancelled',
      )
      note(
        `$ Cancel run → confirm "Cancel run"\n  live: status ${await status()}`,
      )
    } finally {
      await b.close()
    }
  })

  it('N5 an administrator adds a secret value and a secret file, edits the file in the editor and deletes the value after the confirm; the host has no Secrets tab', async () => {
    const master = c.master.master!
    const log = 'secrets.log'
    writeFileSync(path.join(artifacts!, log), '')
    const note = (line: string): void =>
      appendFileSync(path.join(artifacts!, log), `${line}\n`)
    // Secrets are kept only once backups are: a bare repository here.
    const bare = path.join(root, 'backup.git')
    execFileSync('git', ['init', '-q', '--bare', bare])
    await master.settings.set(localOperator, 'backup', {
      repository: bare,
      branch: 'backups',
    })
    const stored = (name: string): { contents: string } | undefined =>
      master.database.db
        .prepare(
          "SELECT s.contents FROM project_secrets s JOIN projects p ON p.id=s.project_id WHERE p.slug='fixture' AND s.name=?",
        )
        .get(name) as { contents: string } | undefined
    const b = await browser('mason-n5', c.master, '1440x900')
    try {
      await masterSignIn(b, 'paul', PASSWORDS.paul!)
      await holds(b, "location.pathname !== '/sign-in'", 'signed in')
      await b.open('/projects/fixture/secrets')
      await holds(
        b,
        "document.querySelector('.m-secrets__add') != null && !document.querySelector('.m-secrets__add button').disabled",
        'the Secrets tab with backups configured',
      )
      // A value.
      await b.tap('.m-secrets__add button:nth-of-type(1)')
      await holds(
        b,
        'document.querySelector(\'form[name="secret-value"]\') != null',
        'the Add value sheet',
      )
      await fill(b, 'form[name="secret-value"] input[name="name"]', 'N5_TOKEN')
      await fill(
        b,
        'form[name="secret-value"] input[name="configs"]',
        'release',
      )
      await fill(
        b,
        'form[name="secret-value"] input[name="value"]',
        'n5-s3cret',
      )
      await b.tap('.m-formsheet__foot .m-btn--primary')
      await holds(
        b,
        'document.querySelector(\'tr[data-secret="N5_TOKEN"]\') != null && document.querySelector(\'form[name="secret-value"]\') == null',
        'the value in the table',
      )
      assert.equal(stored('N5_TOKEN')?.contents, 'n5-s3cret')
      note('$ Add value N5_TOKEN (release)\n  → row N5_TOKEN, stored')
      // A file, its text pasted.
      await b.tap('.m-secrets__add button:nth-of-type(2)')
      await holds(
        b,
        'document.querySelector(\'form[name="secret-file"]\') != null',
        'the Add file sheet',
      )
      await fill(
        b,
        'form[name="secret-file"] textarea[name="text"]',
        '{\n  "channel": "testers"\n}\n',
      )
      await fill(b, 'form[name="secret-file"] input[name="name"]', 'n5.json')
      await b.tap('.m-formsheet__foot .m-btn--primary')
      await holds(
        b,
        'document.querySelector(\'tr[data-secret="n5.json"]\') != null && document.querySelector(\'form[name="secret-file"]\') == null',
        'the file in the table',
      )
      note('$ Add file n5.json (pasted text)\n  → row n5.json · 27 B · text')
      // The file in the editor.
      await b.tap('button[aria-label="Edit n5.json"]')
      await holds(
        b,
        "document.querySelector('.m-editor textarea')?.value.includes('testers')",
        'the editor with the file',
      )
      await fill(b, '.m-editor textarea', '{\n  "channel": "store"\n}\n')
      await b.shot('secrets-file-editor.png')
      await b.tap('.m-editor .m-btn--primary')
      await holds(
        b,
        "document.querySelector('.m-editor') == null",
        'the editor closed after Save',
      )
      assert.equal(
        Buffer.from(stored('n5.json')!.contents, 'base64').toString('utf8'),
        '{\n  "channel": "store"\n}\n',
      )
      note('$ Edit n5.json in the editor → Save\n  → stored "channel": "store"')
      // Delete the value, after the confirm.
      await b.tap('button[aria-label="Delete N5_TOKEN"]')
      await holds(
        b,
        "document.querySelector('[role=alertdialog]')?.textContent.includes('Delete N5_TOKEN?')",
        'the delete confirm',
      )
      await b.shot('secrets-delete-confirm.png')
      await b.tap('[role=alertdialog] .m-btn--danger-filled')
      await holds(
        b,
        "document.querySelector('tr[data-secret=\"N5_TOKEN\"]') == null && document.querySelector('[role=alertdialog]') == null",
        'the value gone',
      )
      assert.equal(stored('N5_TOKEN'), undefined)
      // The audit holds each change.
      await holds(
        b,
        "['Added', 'Edited', 'Deleted'].every((word) => [...document.querySelectorAll('section[aria-labelledby=audit-title] td')].some((td) => td.textContent === word))",
        'the audit',
      )
      note(
        '$ Delete N5_TOKEN → confirm "Delete"\n  → row gone, audit: Added, Added, Edited, Deleted',
      )
    } finally {
      await b.close()
    }
    const h = await browser('mason-n5-dev', host, '1280x860')
    try {
      await hostSignIn(h, 'dev', PASSWORDS.dev!, '/projects/fixture')
      await holds(
        h,
        "document.querySelectorAll('nav.m-tabs a').length === 3 && ![...document.querySelectorAll('nav.m-tabs a')].some((a) => a.textContent.includes('Secrets'))",
        'the host’s tabs without Secrets',
      )
      note(
        '$ the host, /projects/fixture as dev\n  → tabs Overview, Runs and builds, Masonfile (no Secrets)',
      )
    } finally {
      await h.close()
    }
  })

  it('N7 a developer browses the host while its master is unreachable: the banner and footer say so, cached pages read, and what needs the master is named', async () => {
    const run = runs['build-alpha@master']
    const h = await browser('mason-n7-dev', host, '1280x860')
    try {
      await hostSignIn(h, 'dev', PASSWORDS.dev!, '/projects')
      await h.visible('their latest builds and runs')
      await holds(
        h,
        "!document.body.textContent.includes('The master is unreachable')",
        'no banner while the link is up',
      )
      await c.drop('host', 1000, async () => {
        // Projects & apps from the host's copy, under the read-only banner.
        await h.open('/projects')
        await h.visible('The master is unreachable')
        await h.visible('Runs, approvals and account changes need the master')
        await holds(
          h,
          "document.querySelector('.m-banner [role=status], .m-banner[role=status]')?.textContent.includes('Read-only')",
          'the banner’s Read-only chip',
        )
        await holds(
          h,
          "document.querySelector('.m-sidebar__foot')?.textContent.includes('Master unreachable')",
          'the footer',
        )
        await holds(
          h,
          `document.querySelector('#project-fixture a[href="/projects/fixture/apps/${ALPHA}"]') != null`,
          'the cached project card',
        )
        // The host has no Add project, and its queue reads from its copy.
        await holds(
          h,
          "![...document.querySelectorAll('a')].some((a) => a.textContent.includes('Add project')) && document.querySelector('[aria-label=Queue]') != null",
          'the read-only page',
        )
        await h.shot('host-offline-banner.png')
        // Artifacts and a run's detail read from the copy too.
        await h.open('/artifacts')
        await h.visible('The master is unreachable')
        await h.visible(`fixture Run ${run.number}`)
        await h.open(`/artifacts?run=${run.id}`)
        await h.visible('Published builds')
        // The host serves the build itself: Install stays.
        await holds(
          h,
          "[...document.querySelectorAll('a[href^=\"/apps/\"]')].some((a) => a.textContent.endsWith('Install'))",
          'Install on the cached build',
        )
        await h.visible('The master is unreachable')
      })
      // Once the link is back, the banner goes.
      await h.open('/projects')
      await h.visible('their latest builds and runs')
      await holds(
        h,
        "!document.body.textContent.includes('The master is unreachable')",
        'the banner gone',
      )
    } finally {
      await h.close()
    }
  })
})
