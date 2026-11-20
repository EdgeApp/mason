// Every Mason screen in a real browser, captured at three widths: Chrome
// driven by maestro-d's web driver, as src/master/uiAcceptance.test.ts is.
// Skipped unless MASON_WEB_E2E=1; it needs MASON_TEST_ROOT, MASON_ARTIFACTS,
// MASON_BROWSER_BIN, MAESTRO_D and MAESTRO_D_CLIENT_ROOT. Run it compiled,
// from lib/. Each screen is saved as `<screen>-<width>-<MASON_SCREENS>.png`
// in MASON_ARTIFACTS (MASON_SCREENS is `after` unless set); `light` sets
// Appearance to Light in local storage before each capture. Every request a
// page made must be to its own origin, and no page may scroll sideways.
// MASON_SCREENS_PREFIX (`/_web`) opens each screen under the React app's
// mount, and MASON_SCREENS_ONLY (names, comma-separated) captures only those
// screens: a milestone captures the screens it ships while the server still
// answers the real routes.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'mocha'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { branchKey } from '../catalog/platform.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { digest } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { seedSecret } from '../test/secrets.js'
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

/** Who looks at a screen: a role signed in, or nobody. */
export type Viewer = 'admin' | 'developer' | 'tester' | 'none'
/**
 * Which node serves it: the cluster's master or host, a master nobody has
 * set up yet, or a host no master has paired.
 */
export type ScreenNode = 'master' | 'host' | 'fresh-master' | 'waiting-host'
export interface Screen {
  /** Short kebab-case name; the file is `<name>-<width>-<variant>.png`. */
  name: string
  /** Path and query, with `{placeholders}` from the fixtures (see `FIXTURE_KEYS`). */
  path: string
  as: Viewer
  node: ScreenNode
  /** The host's link to the master is down, or down past the grace window. */
  state?: 'offline' | 'maintenance'
}

/** The fixture values a screen's path can name. */
export const FIXTURE_KEYS = [
  'run.succeeded',
  'run.failed',
  'run.running',
  'run.approval',
  'group.testers',
  'app.alpha',
  'branch.master',
  'invite',
  'device.token',
] as const

/** Viewport sizes: phone, tablet portrait, desktop. */
export const WIDTHS: ReadonlyArray<readonly [number, number]> = [
  [390, 844],
  [834, 1194],
  [1440, 900],
]

/**
 * The design's surface rules, checked in the page (it returns one line per
 * problem): (a) no card, button, pill or overlay draws an outline, (b)
 * every pill keeps its text and icons at least its corner radius from each
 * side, and (c) no slider option cuts its label short. A pill is drawn (a background, a box-shadow, or the slider thumb
 * behind it), rounded to at least half its height or padded by its radius
 * (a pill that wrapped), and wider than tall; one that holds another pill is
 * a track, and only its options are checked. Its contents are its visible
 * text nodes (icons are ligature text), clipped by any box between them and
 * the pill that hides its overflow, so (b) passes a label cut to an
 * ellipsis; (c) finds those: a box inside a segmented control's, filter's
 * or tab's option that clips its overflow and holds more than it shows.
 * A label hidden on purpose (the tab bar's 1 px clipped labels) is skipped.
 */
export const SURFACE_CHECK = `
  const problems = []
  const visible = (el) => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0 &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  const alpha = (color) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(color)
    if (m == null) return color === 'transparent' ? 0 : 1
    const parts = m[1].split(/[ ,/]+/).filter(Boolean)
    return parts.length > 3 ? Number(parts[3]) : 1
  }
  const name = (el) => el.tagName.toLowerCase() +
    [...el.classList].slice(0, 2).map((c) => '.' + c).join('') +
    ' "' + (el.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 30) + '"'
  // (a) No outline.
  const outlined = '.m-card, .m-btn, .m-chip, .m-status, .m-runchip, .m-node-pill, .m-filter, .m-seg, .m-catalog-platforms, .m-searchcap, .m-banner, .m-callout, .m-menu, .m-palette, .m-formsheet'
  for (const el of document.querySelectorAll(outlined)) {
    if (!visible(el)) continue
    const style = getComputedStyle(el)
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (parseFloat(style['border' + side + 'Width']) > 0 &&
          style['border' + side + 'Style'] !== 'none' &&
          alpha(style['border' + side + 'Color']) > 0) {
        problems.push('outline on ' + name(el) + ': ' + style['border' + side + 'Color'])
        break
      }
  }
  // (b) Pills keep their contents at least their corner radius from each side.
  const pills = []
  for (const el of document.querySelectorAll('body *')) {
    if (el.matches('input, select, textarea, option, svg, svg *') || !visible(el)) continue
    const box = el.getBoundingClientRect()
    if (box.width <= box.height + 1) continue
    const style = getComputedStyle(el)
    const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, box.height / 2)
    if (radius <= 0) continue
    const drawn = alpha(style.backgroundColor) > 0 || style.boxShadow !== 'none' || el.hasAttribute('data-thumb-on')
    const round = radius >= box.height / 2 - 0.5
    const wrapped = Math.abs(parseFloat(style.paddingLeft) - radius) < 0.5 &&
      Math.abs(parseFloat(style.paddingRight) - radius) < 0.5
    if (drawn && (round || wrapped)) pills.push({ el, box, radius })
  }
  for (const { el, box, radius } of pills) {
    if (pills.some((other) => other.el !== el && el.contains(other.el))) continue
    let left = Infinity, right = -Infinity
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text != null; text = walker.nextNode()) {
      if (text.textContent.trim() === '' || !visible(text.parentElement)) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      for (const r of range.getClientRects()) {
        if (r.width <= 1 || r.height <= 1) continue
        let l = r.left, rr = r.right
        for (let a = text.parentElement; a != null && a !== el.parentElement; a = a.parentElement) {
          const cs = getComputedStyle(a)
          if (cs.overflowX !== 'visible' || cs.clipPath !== 'none') {
            const ab = a.getBoundingClientRect()
            l = Math.max(l, ab.left)
            rr = Math.min(rr, ab.right)
          }
        }
        if (rr <= l) continue
        left = Math.min(left, l)
        right = Math.max(right, rr)
      }
    }
    if (left === Infinity) continue
    const inLeft = left - box.left, inRight = box.right - right
    if (inLeft < radius - 0.5 || inRight < radius - 0.5)
      problems.push('pill ' + name(el) + ' holds its contents ' + inLeft.toFixed(1) + ' / ' + inRight.toFixed(1) + ' px from its sides, under its ' + radius.toFixed(1) + ' px radius')
  }
  // (c) Slider options show their labels whole.
  for (const option of document.querySelectorAll('.m-seg__opt, .m-filter__opt, .m-tabbar__item')) {
    if (!visible(option)) continue
    for (const el of [option, ...option.querySelectorAll('*')]) {
      if (el.matches('.m-icon') || el.getBoundingClientRect().width <= 1 || !visible(el)) continue
      if (getComputedStyle(el).overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
        problems.push('slider option ' + name(option) + ' cuts its label short: ' + el.clientWidth + ' of ' + el.scrollWidth + ' px shown')
        break
      }
    }
  }
  return JSON.stringify(problems)
`

export const ALPHA = 'com.example.alpha'
export const BETA = 'com.example.beta-with-a-longer-id'

/** Every screen, by who sees it on which node. Later milestones extend it. */
export const SCREENS: Screen[] = [
  // Signed out.
  { name: 'setup', path: '/', as: 'none', node: 'fresh-master' },
  { name: 'restore', path: '/?restore', as: 'none', node: 'fresh-master' },
  { name: 'sign-in', path: '/sign-in', as: 'none', node: 'master' },
  { name: 'invite', path: '/auth/invite#{invite}', as: 'none', node: 'master' },
  { name: 'host-sign-in', path: '/auth/login', as: 'none', node: 'host' },
  { name: 'host-waiting', path: '/', as: 'none', node: 'waiting-host' },
  // An administrator on the master.
  { name: 'dashboard', path: '/projects', as: 'admin', node: 'master' },
  { name: 'artifacts', path: '/artifacts', as: 'admin', node: 'master' },
  {
    name: 'artifacts-run',
    path: '/artifacts?run={run.succeeded}',
    as: 'admin',
    node: 'master',
  },
  { name: 'run', path: '/runs/{run.succeeded}', as: 'admin', node: 'master' },
  {
    name: 'run-failed',
    path: '/runs/{run.failed}',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'run-running',
    path: '/runs/{run.running}',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'run-approval',
    path: '/runs/{run.approval}',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'project-overview',
    path: '/projects/fixture',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'project-runs',
    path: '/projects/fixture/runs',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'project-runs-branch',
    path: '/projects/fixture/runs?branch=develop',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'app-id-runs',
    path: `/projects/fixture/apps/${ALPHA}`,
    as: 'admin',
    node: 'master',
  },
  {
    name: 'app-id-build-numbers',
    path: `/projects/fixture/apps/${ALPHA}/build-numbers`,
    as: 'admin',
    node: 'master',
  },
  {
    name: 'masonfile',
    path: '/projects/fixture/masonfile',
    as: 'admin',
    node: 'master',
  },
  {
    name: 'secrets',
    path: '/projects/fixture/secrets',
    as: 'admin',
    node: 'master',
  },
  { name: 'wizard', path: '/projects/new', as: 'admin', node: 'master' },
  { name: 'nodes', path: '/nodes', as: 'admin', node: 'master' },
  { name: 'cloud', path: '/cloud', as: 'admin', node: 'master' },
  { name: 'settings', path: '/settings', as: 'admin', node: 'master' },
  { name: 'people', path: '/people', as: 'admin', node: 'master' },
  { name: 'account', path: '/account', as: 'admin', node: 'master' },
  { name: 'groups', path: '/groups', as: 'admin', node: 'master' },
  {
    name: 'group',
    path: '/groups/{group.testers}',
    as: 'admin',
    node: 'master',
  },
  { name: 'backups', path: '/backups', as: 'admin', node: 'master' },
  { name: 'install-apps-master', path: '/apps', as: 'admin', node: 'master' },
  { name: 'devices-master', path: '/devices', as: 'admin', node: 'master' },
  {
    name: 'run-missing',
    path: '/runs/no-such-run',
    as: 'admin',
    node: 'master',
  },
  { name: 'not-found', path: '/no-such-page', as: 'admin', node: 'master' },
  // A developer: refused on the master, reading on the host.
  { name: 'forbidden', path: '/backups', as: 'developer', node: 'master' },
  { name: 'host-dashboard', path: '/projects', as: 'developer', node: 'host' },
  {
    name: 'host-artifacts',
    path: '/artifacts',
    as: 'developer',
    node: 'host',
  },
  {
    name: 'host-run',
    path: '/runs/{run.succeeded}',
    as: 'developer',
    node: 'host',
  },
  {
    name: 'host-project-overview',
    path: '/projects/fixture',
    as: 'developer',
    node: 'host',
  },
  {
    name: 'host-project-runs',
    path: '/projects/fixture/runs',
    as: 'developer',
    node: 'host',
  },
  {
    name: 'host-masonfile',
    path: '/projects/fixture/masonfile',
    as: 'developer',
    node: 'host',
  },
  {
    name: 'host-app-id-build-numbers',
    path: `/projects/fixture/apps/${ALPHA}/build-numbers`,
    as: 'developer',
    node: 'host',
  },
  {
    name: 'host-offline',
    path: '/projects',
    as: 'developer',
    node: 'host',
    state: 'offline',
  },
  {
    name: 'host-offline-run',
    path: '/runs/{run.succeeded}',
    as: 'developer',
    node: 'host',
    state: 'offline',
  },
  {
    name: 'host-maintenance',
    path: '/',
    as: 'developer',
    node: 'host',
    state: 'maintenance',
  },
  // A tester on the host.
  { name: 'install-apps', path: '/apps', as: 'tester', node: 'host' },
  {
    name: 'app',
    path: '/apps/{app.alpha}?platform=android',
    as: 'tester',
    node: 'host',
  },
  {
    name: 'branch',
    path: '/apps/{app.alpha}/branches/{branch.master}?platform=android',
    as: 'tester',
    node: 'host',
  },
  { name: 'devices', path: '/devices', as: 'tester', node: 'host' },
  {
    name: 'device-registered',
    path: '/devices/complete/{device.token}',
    as: 'tester',
    node: 'host',
  },
  { name: 'host-account', path: '/account', as: 'tester', node: 'host' },
  { name: 'app-unavailable', path: '/apps/999999', as: 'tester', node: 'host' },
  {
    name: 'host-not-found-tester',
    path: '/projects',
    as: 'tester',
    node: 'host',
  },
]

/** The upload fixtures, compiled; the stages build packages numbered by their run. */
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../upload/fixtures.test.js',
)

const quote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'"

/**
 * Alpha and Beta share a build number sequence. A release waits for an
 * administrator's approval; `follow` logs until `gate` exists.
 */
const fixtureMasonfile = (gate: string): string => `
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
  m.workflow('release', { triggers: [{ request: true }] }, (w) => {
    const approved = w.approval('approve', { roles: ['admin'], message: 'Ship Alpha to the testers?' })
    w.stage('ship', { needs: [approved], on: 'master', run: ship })
  })
  m.workflow('follow', { triggers: [{ request: true }] }, (w) => {
    w.stage('follow', { on: 'master', run: follow })
  })
}
export async function follow(ctx: Stage) {
  const { existsSync } = await import('node:fs')
  ctx.log.info('compiling the app')
  let n = 0
  while (!existsSync(${JSON.stringify(gate)})) {
    ctx.log.info('step ' + ++n)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  ctx.log.info('follow done')
}
export async function ship(ctx: Stage) {
  ctx.log.info('shipped')
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

/** A second project with no apps: tests pass, the linter fails. */
const websiteMasonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('test', { triggers: [{ request: true }] }, (w) => {
    w.stage('unit', { on: 'master', run: unit })
  })
  m.workflow('check', { triggers: [{ request: true }] }, (w) => {
    w.stage('lint', { on: 'master', run: lint })
  })
}
export async function unit(ctx: Stage) {
  ctx.log.info('42 tests passed')
}
export async function lint(ctx: Stage) {
  ctx.log.info('checking 118 files')
  await ctx.sh('echo "src/index.ts:12:3 error no-unused-vars" && exit 3')
}
`

/** Fixture passwords; the setup admin is `paul`, as src/test/cluster.ts makes him. */
export const PASSWORDS: Record<string, string> = {
  paul: 'Correct-Horse-9',
  mia: 'Mia-Horse-9-long',
  dev: 'Dev-Horse-9-long',
  tess: 'Tess-Horse-9-long',
  nora: 'Nora-Horse-9-long',
}
/** Who signs in for each viewer. */
const SIGN_IN: Record<Exclude<Viewer, 'none'>, string> = {
  admin: 'paul',
  developer: 'dev',
  tester: 'tess',
}

describe('Every Mason screen at three widths', function () {
  this.timeout(1_800_000)
  const enabled = process.env.MASON_WEB_E2E === '1'
  const variant = process.env.MASON_SCREENS ?? 'after'
  const prefix = process.env.MASON_SCREENS_PREFIX ?? ''
  const only = process.env.MASON_SCREENS_ONLY?.split(',').filter(Boolean)
  const wanted = (screen: Screen): boolean =>
    only == null || only.includes(screen.name)
  const {
    MASON_TEST_ROOT: parent,
    MASON_ARTIFACTS: artifacts,
    MASON_BROWSER_BIN: browserBin,
    MAESTRO_D: daemonName,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
  } = process.env
  let c: Cluster
  let host: RunningNode
  let fresh: RunningNode
  let waiting: RunningNode
  let daemon: Daemon
  let wrapper: string
  let root: string
  let gate: string
  const fixtures: Record<string, string> = {}
  const people: Record<string, number> = {}
  /** One line per capture: screen, width, the page's final address and heading. */
  const manifest: string[] = []
  const origin = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const nodeOf = (screen: Screen): RunningNode =>
    ({
      master: c.master,
      host,
      'fresh-master': fresh,
      'waiting-host': waiting,
    })[screen.node]

  before(async function () {
    if (!enabled) return this.skip()
    assert(parent && artifacts && browserBin && daemonName && clientRoot)
    mkdirSync(artifacts, { recursive: true })
    root = mkdtempSync(path.join(realpathSync(parent), 'screens-'))
    gate = path.join(root, 'follow-gate')
    c = await cluster(path.join(root, 'cluster'), {
      coWorker: true,
      workers: [{ name: 'mac-mini-1', type: 'mac', setup: false }],
    })
    host = await c.startHost('host')
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', {
      origin: origin(host),
      workerOrigin: host.web!.url,
    })
    await master.settings.set(localOperator, 'nodeTypes', { mac: {} })
    // Two projects: Fixture with two apps, Website with none.
    const repo = c.repo('fixtures/fixture')
    repo.commit(
      { 'Masonfile.ts': fixtureMasonfile(gate) },
      'master',
      'Fixture Masonfile',
    )
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
        { bundleId: BETA, name: 'Beta', platforms: ['macos', 'tvos'] },
      ],
    })
    const website = c.repo('fixtures/website')
    website.commit(
      { 'Masonfile.ts': websiteMasonfile },
      'master',
      'Website Masonfile',
    )
    master.saveProject(localOperator, 'website', {
      name: 'Website',
      repository: website.url,
      rules: [{ pattern: 'master', mode: 'request' }],
      apps: [],
    })
    const db = master.database.db
    seedSecret(db, 'fixture', {
      name: 'PLAY_STORE_TOKEN',
      kind: 'value',
      value: 'not-a-real-token',
      masked: true,
    })
    seedSecret(db, 'fixture', {
      name: 'google-services.json',
      kind: 'file',
      contents: Buffer.from('{"project_info":{}}\n').toString('base64'),
      destination: 'android/app/google-services.json',
    })
    const request = async (
      project: string,
      branch: string,
      workflow: string,
    ): Promise<string> => {
      const created = await c.api('POST', '/api/v2/runs', {
        project,
        branch,
        workflow,
      })
      assert.equal(created.status, 202, created.text)
      return String(created.json.id)
    }
    const finished = async (
      project: string,
      branch: string,
      workflow: string,
      status: string,
    ): Promise<Json> => {
      const id = await request(project, branch, workflow)
      const run = await c.until(
        () => {
          const value = master.run(id) as Json
          return ['succeeded', 'failed', 'cancelled', 'unstable'].includes(
            value.status,
          )
            ? value
            : undefined
        },
        120_000,
        `${workflow} on ${branch}`,
      )
      assert.equal(run.status, status, master.scheduler.logs(id))
      return run
    }
    for (const branch of ['master', 'develop'])
      for (const workflow of ['build-alpha', 'build-beta'])
        await finished('fixture', branch, workflow, 'succeeded')
    const succeeded = await finished(
      'fixture',
      'master',
      'build-alpha',
      'succeeded',
    )
    fixtures['run.succeeded'] = String(succeeded.id)
    await finished('website', 'master', 'test', 'succeeded')
    fixtures['run.failed'] = String(
      (await finished('website', 'master', 'check', 'failed')).id,
    )
    // A release waits for its approval; then a run logs until the gate opens.
    const approval = await request('fixture', 'master', 'release')
    await c.until(
      () => JSON.stringify(master.run(approval)).includes('awaiting_approval'),
      120_000,
      'the release to wait for approval',
    )
    fixtures['run.approval'] = approval
    rmSync(gate, { force: true })
    const running = await request('fixture', 'develop', 'follow')
    await c.until(
      () => {
        const file = master.scheduler.logFile(running, 'follow')
        return existsSync(file) && readFileSync(file, 'utf8').includes('step 2')
      },
      120_000,
      'the follow stage logging',
    )
    fixtures['run.running'] = running
    // People: one per role, a tester with only an email, and one invited.
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
    await person('mia', {
      name: 'Mia Manager',
      username: 'mia',
      role: 'manager',
      emails: ['mia@example.test'],
    })
    await person('dev', {
      name: 'Dev Developer',
      username: 'dev',
      role: 'developer',
      emails: ['dev@example.test'],
    })
    await person('tess', {
      name: 'Tess Tester',
      username: 'tess',
      role: 'tester',
      emails: ['tess@example.test', 'tess2@example.test'],
    })
    await person('nora', {
      name: 'Nora Tester',
      role: 'tester',
      emails: ['nora@example.test'],
    })
    people.ivy = (
      await master.people.create(localOperator, {
        name: 'Ivy Invited',
        role: 'tester',
        emails: ['ivy@example.test'],
      })
    ).id
    fixtures.invite = master.people.invite(localOperator, people.ivy).token
    people.paul = Number(
      db.prepare("SELECT id FROM accounts WHERE username='paul'").get()!.id,
    )
    const appIds = db
      .prepare('SELECT id FROM apps WHERE slug IN (?,?) ORDER BY id')
      .all(ALPHA, BETA)
      .map((row) => Number(row.id))
    fixtures['app.alpha'] = String(appIds[0])
    fixtures['branch.master'] = branchKey('master')
    fixtures['group.testers'] = String(
      master.people.createGroup(localOperator, {
        name: 'Testers',
        apps: appIds,
        members: [people.tess!, people.nora!],
      }).id,
    )
    master.people.createGroup(localOperator, {
      name: 'Beta crew',
      apps: [appIds[1]],
      members: [people.dev!],
    })
    // A device the master registered for Tess.
    const now = Date.now()
    const device = Number(
      db
        .prepare(
          "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,'iPhone14,5','iPhone 13','26.0','registered',?,?)",
        )
        .run('00008110-001A2B3C4D5E6F7A', now, now).lastInsertRowid,
    )
    db.prepare(
      'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?)',
    ).run(people.tess!, device, 'iPhone of Tess', now)
    master.database.change('device', device)
    master.database.change('account', people.tess!)
    const cache = host.host!.cache.db
    await c.until(
      () =>
        (
          cache
            .prepare("SELECT COUNT(*) AS n FROM builds WHERE state='ready'")
            .get() as { n: number }
        ).n >= 5 &&
        cache.prepare("SELECT 1 FROM groups WHERE name='Testers'").get() !=
          null &&
        cache
          .prepare("SELECT 1 FROM accounts WHERE name='Ivy Invited'")
          .get() != null &&
        cache
          .prepare('SELECT 1 FROM account_devices WHERE device_id=?')
          .get(device) != null &&
        [succeeded.id, fixtures['run.failed'], approval, running].every(
          (id) =>
            cache.prepare('SELECT 1 FROM jobs WHERE id=?').get(id) != null,
        ),
      30_000,
      'the builds, people, device and runs on the host',
    )
    // Her registration's completion link, as the Profile Service would leave it.
    const token = `screens-${process.pid}`
    const session = host.host!.accounts.startSession(people.tess!).session
    cache
      .prepare(
        'INSERT INTO device_challenges(hash,account_id,session_hash,expires_at,device_id) VALUES(?,?,?,?,?)',
      )
      .run(digest(token), people.tess!, session.hash, now + 86_400_000, device)
    fixtures['device.token'] = token
    // A master nobody has set up, and a host no master has paired.
    fresh = await startNode(
      {
        role: 'master',
        data: path.join(root, 'fresh'),
        port: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
      },
      () => undefined,
    )
    waiting = await startNode(
      {
        role: 'host',
        data: path.join(root, 'waiting'),
        port: 0,
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
      },
      () => undefined,
    )
    wrapper = path.join(root, 'browser')
    const pins = [c.master, host, fresh, waiting]
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
    if (gate != null) writeFileSync(gate, '')
    if (artifacts != null && manifest.length > 0)
      writeFileSync(
        path.join(artifacts, `screens-${variant}.log`),
        manifest.join('\n') + '\n',
      )
    await fresh?.close()
    await waiting?.close()
    await c?.close()
  })

  /** A screen's path with its fixtures filled in. */
  const resolve = (screen: Screen): string =>
    prefix +
    screen.path.replace(/\{([a-z.]+)\}/g, (_match, key: string) => {
      const value = fixtures[key]
      assert(value != null, `No fixture ${key} for ${screen.name}`)
      return value
    })

  /** A fresh Chrome (its own profile) at one viewport size. */
  const browser = async (
    name: string,
    width: number,
    height: number,
  ): Promise<{
    open: (url: string) => Promise<void>
    script: (script: string) => Promise<string>
    tap: (css: string) => Promise<void>
    type: (css: string, text: string) => Promise<void>
    drag: (from: string, to: string) => Promise<void>
    shot: () => Promise<Buffer>
    close: () => Promise<void>
  }> => {
    const id = `${name}-${process.pid}`
    const device = await daemon.attach({
      device: id,
      platform: 'web',
      url: origin(c.master),
      extra: { browser: wrapper, windowSize: `${width}x${height}` },
      artifacts: 'none',
      commandTimeout: 30000,
      // maestro-d writes reports here; the artifacts directory holds only proof.
      outputDir: path.join(realpathSync(parent!), 'maestro-output'),
    })
    /** A navigation can land mid-command; the page is asked once more. */
    const retry = async <T>(step: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++)
        try {
          return await step()
        } catch (error) {
          if (
            attempt > 3 ||
            !/navigated|execution context|find context|detached/i.test(
              String(error),
            )
          )
            throw error
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
    }
    return {
      open: async (url): Promise<void> => {
        await device.command('openBrowser', { url })
      },
      script: async (script): Promise<string> =>
        await retry(async () => {
          const reply = (await device.command('evalBrowserScript', {
            script,
          })) as { data?: unknown }
          return String(reply?.data ?? '')
        }),
      tap: async (css): Promise<void> => {
        await retry(async () => await device.command('tapOn', { css }))
      },
      type: async (css, text): Promise<void> => {
        await device.command('tapOn', { css })
        await device.command('inputText', { text })
      },
      // A pointer press held briefly, then moved over 600 ms, as a finger drags.
      drag: async (from, to): Promise<void> => {
        await device.command('dragAndDrop', {
          from: { css: from },
          to: { css: to },
          holdDuration: 100,
          duration: 600,
        })
      },
      shot: async (): Promise<Buffer> => await device.screenshot(),
      close: async (): Promise<void> => {
        await daemon.detach(id).catch(() => undefined)
      },
    }
  }
  type Browser = Awaited<ReturnType<typeof browser>>

  /** Waits until the page's script returns true, or fails saying what did not. */
  const until = async (
    b: Browser,
    condition: string,
    what: string,
  ): Promise<void> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const done = await b
        .script(`return String(${condition})`)
        .catch(() => 'false')
      if (done === 'true') return
      if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** Signs in through the node's own form, as a person would. */
  const signIn = async (
    b: Browser,
    viewer: Exclude<Viewer, 'none'>,
    node: RunningNode,
  ): Promise<void> => {
    const who = SIGN_IN[viewer]
    const form = node === c.master ? '/sign-in' : '/auth/login'
    await b.open(origin(node) + (node === c.master ? form : `${form}?return=/`))
    await until(
      b,
      "document.querySelector('#sign-in-username') != null",
      'the form',
    )
    await b.type('#sign-in-username', who)
    await b.type('#sign-in-password', PASSWORDS[who]!)
    await b.tap('form[name="sign-in"] button[type="submit"]')
    await until(
      b,
      `location.pathname !== ${JSON.stringify(form)}`,
      `${who} signed in on ${origin(node)}`,
    )
  }

  /**
   * Waits for fonts and for the page to stop loading resources, then returns
   * the page's address, heading and every resource it requested.
   */
  const settle = `
    if (document.fonts) await document.fonts.ready
    let count = -1, stable = 0
    for (let i = 0; i < 40 && stable < 3; i++) {
      const now = performance.getEntriesByType('resource').length
      stable = now === count && document.readyState === 'complete' ? stable + 1 : 0
      count = now
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return JSON.stringify({
      href: location.href,
      heading: document.querySelector('h1')?.textContent ?? document.title ?? '',
      requests: performance.getEntriesByType('resource').map((entry) => entry.name),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      tabLabels: [...document.querySelectorAll('.m-tabbar__item')].map((item) => {
        const style = getComputedStyle(item)
        return style.fontSize + ' ' + style.fontWeight
      }),
    })`

  /** Opens a screen, settles it and saves its capture; returns what went wrong, if anything. */
  const capture = async (
    b: Browser,
    screen: Screen,
    width: number,
  ): Promise<string[]> => {
    const node = nodeOf(screen)
    const base = origin(node)
    const url = base + resolve(screen)
    await b.open(url)
    if (variant === 'light') {
      await b.script("localStorage.setItem('mason-appearance', 'light')")
      await b.open(url)
    }
    const page = JSON.parse(await b.script(settle)) as {
      href: string
      heading: string
      requests: string[]
      scrollWidth: number
      innerWidth: number
      tabLabels: string[]
    }
    // Let layout and animations finish before the capture.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const file = `${screen.name}-${width}-${variant}.png`
    writeFileSync(path.join(artifacts!, file), await b.shot())
    const where = new URL(page.href)
    manifest.push(
      `${file}\t${screen.as}@${screen.node}${screen.state == null ? '' : ` (${screen.state})`}\t${url.replace(/#.*/, '#…')}\t→ ${where.pathname}${where.search}\t${page.heading.trim()}\t${page.requests.length} requests`,
    )
    const problems: string[] = []
    const foreign = page.requests.filter(
      (request) =>
        !/^(data|blob):/.test(request) && new URL(request).origin !== base,
    )
    if (foreign.length > 0)
      problems.push(
        `${file}: requests to another origin: ${foreign.join(', ')}`,
      )
    // No outlines; every pill clears its contents by its radius. The base
    // draws outlines, so a `before` capture is not checked.
    if (variant !== 'before')
      for (const problem of JSON.parse(
        await b.script(SURFACE_CHECK),
      ) as string[])
        problems.push(`${file}: ${problem}`)
    // Nothing wider than the window: no page scrolls sideways.
    if (page.scrollWidth > page.innerWidth)
      problems.push(
        `${file}: scrolls sideways at ${width} px (scrollWidth ${page.scrollWidth} > innerWidth ${page.innerWidth})`,
      )
    // Every tab bar label is drawn alike, the More button's too.
    if (new Set(page.tabLabels).size > 1)
      problems.push(
        `${file}: tab bar labels differ (${page.tabLabels.join(', ')})`,
      )
    const signInPaths = ['/sign-in', '/auth/login']
    if (
      screen.as !== 'none' &&
      signInPaths.includes(where.pathname) &&
      !signInPaths.includes(new URL(url).pathname)
    )
      problems.push(`${file}: sent to sign in (${where.pathname})`)
    return problems
  }

  /**
   * Captures these screens at every width, each width in its own signed-in
   * browser. `during` decides when: it is handed a function that captures a
   * list of screens in every browser (all of them by default).
   */
  const captureAll = async (
    label: string,
    screens: Screen[],
    during: (each: (list: Screen[]) => Promise<void>) => Promise<void> = async (
      each,
    ) => await each(screens),
  ): Promise<void> => {
    const problems: string[] = []
    const browsers: Array<{ b: Browser; width: number }> = []
    try {
      for (const [width, height] of WIDTHS) {
        const b = await browser(`screens-${label}-${width}`, width, height)
        browsers.push({ b, width })
        const viewer = screens[0]!.as
        if (viewer !== 'none') await signIn(b, viewer, nodeOf(screens[0]!))
      }
      await during(async (list) => {
        for (const { b, width } of browsers)
          for (const screen of list)
            try {
              problems.push(...(await capture(b, screen, width)))
            } catch (error) {
              problems.push(`${screen.name}-${width}: ${String(error)}`)
            }
      })
      assert.deepEqual(problems, [], problems.join('\n'))
    } finally {
      for (const { b } of browsers) await b.close()
    }
  }

  const groups = (): Map<string, Screen[]> => {
    const byKey = new Map<string, Screen[]>()
    for (const screen of SCREENS) {
      if (screen.state != null || !wanted(screen)) continue
      const key =
        screen.as === 'none' ? 'signed-out' : `${screen.as}@${screen.node}`
      byKey.set(key, [...(byKey.get(key) ?? []), screen])
    }
    return byKey
  }

  for (const key of [
    'signed-out',
    'admin@master',
    'developer@master',
    'developer@host',
    'tester@host',
  ])
    it(`captures the screens ${key} sees`, async function () {
      const screens = groups().get(key) ?? []
      if (screens.length === 0) return this.skip()
      await captureAll(key.replace('@', '-'), screens)
    })

  it('captures the overlays an admin opens: the account menu, the command palette and More', async function () {
    if (only != null && !only.includes('overlays')) return this.skip()
    const problems: string[] = []
    const overlay = async (
      b: Browser,
      name: string,
      width: number,
      opener: string,
      shown: string,
    ): Promise<void> => {
      await b.open(origin(c.master) + prefix + '/projects')
      await b.script(settle)
      await b.tap(opener)
      await until(
        b,
        `document.querySelector(${JSON.stringify(shown)}) != null`,
        shown,
      )
      // Let the overlay's entrance finish before the capture.
      await new Promise((resolve) => setTimeout(resolve, 600))
      const file = `overlay-${name}-${width}-${variant}.png`
      writeFileSync(path.join(artifacts!, file), await b.shot())
      manifest.push(`${file}\tadmin@master\t/projects\t${opener} → ${shown}`)
      if (variant !== 'before')
        for (const problem of JSON.parse(
          await b.script(SURFACE_CHECK),
        ) as string[])
          problems.push(`${file}: ${problem}`)
    }
    for (const [width, height] of [WIDTHS[2]!, WIDTHS[0]!]) {
      const b = await browser(`screens-overlays-${width}`, width, height)
      try {
        await signIn(b, 'admin', c.master)
        if (width > 800) {
          await overlay(
            b,
            'menu',
            width,
            'button[aria-label="Your account"]',
            '.m-menu',
          )
          await overlay(b, 'palette', width, '.m-searchcap', '.m-palette')
        } else
          await overlay(
            b,
            'more',
            width,
            '.m-tabbar__platter button',
            '.m-formsheet',
          )
      } finally {
        await b.close()
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'))
  })

  it('slides and drags the slider pills on a real master and host', async function () {
    if (only != null && !only.includes('sliders')) return this.skip()
    const log: string[] = []
    const step = async (
      b: Browser,
      what: string,
      file: string,
      check: string,
    ): Promise<void> => {
      // Let the thumb's slide and any navigation finish.
      await new Promise((resolve) => setTimeout(resolve, 700))
      const result = await b.script(`return JSON.stringify(${check})`)
      writeFileSync(path.join(artifacts!, file), await b.shot())
      log.push(`$ ${what}`, result, `(${file})`, '')
    }
    /** The track's thumb and chosen option, for the log. */
    const thumbOf = (track: string): string => `(() => {
      const t = document.querySelector(${JSON.stringify(track)})
      const on = t.querySelector('[data-thumb-on]')
      const chosen = t.querySelector("[aria-pressed='true'], [aria-current='true'], [aria-current='page']")
      return {
        address: location.pathname + location.search,
        chosen: chosen?.textContent.trim(),
        thumbOn: on?.textContent.trim(),
        thumbX: t.style.getPropertyValue('--thumb-x'),
        chosenX: chosen == null ? null : chosen.offsetLeft + 'px',
      }
    })()`
    /** The CSS for a track's option by its visible text. */
    const option = async (
      b: Browser,
      track: string,
      text: string,
    ): Promise<string> => {
      const n = await b.script(
        `return String([...document.querySelector(${JSON.stringify(track)}).children].findIndex((o) => { const label = o.cloneNode(true); for (const icon of label.querySelectorAll('.m-icon')) icon.remove(); return label.textContent.trim().startsWith(${JSON.stringify(text)}) }) + 1)`,
      )
      assert(Number(n) > 0, `${text} in ${track}`)
      return `${track} > :nth-child(${n})`
    }
    const expect = async (
      b: Browser,
      condition: string,
      what: string,
    ): Promise<void> => {
      await until(b, condition, what)
    }
    /**
     * A step that measures the page, then saves `<name>-<MASON_SCREENS>.png`,
     * before anything is asserted, and returns the measures. It measures
     * first: the capture is of the whole page, which resizes the window for
     * a moment and drops its scroll. The base truncates the catalog switch's
     * labels, so a `before` run only captures: callers assert when `checked`.
     */
    const checked = variant !== 'before'
    const measure = async (
      b: Browser,
      what: string,
      name: string,
      check: string,
    ): Promise<Json> => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const result = await b.script(`return JSON.stringify(${check})`)
      const file = `${name}-${variant}.png`
      writeFileSync(path.join(artifacts!, file), await b.shot())
      log.push(`$ ${what}`, result, `(${file})`, '')
      return JSON.parse(result)
    }
    /** A track and each option's box, icon and label, relative to the track. */
    const layoutOf = (track: string): string => `(() => {
      const t = document.querySelector(${JSON.stringify(track)})
      const box = t.getBoundingClientRect()
      const column = t.parentElement.closest('.m-page')
      const pad = getComputedStyle(column)
      return {
        scrolls: t.dataset.scrolls != null,
        scrollLeft: t.scrollLeft,
        width: box.width,
        switchWidth: t.closest('.m-catalog-platforms')?.getBoundingClientRect().width,
        column: column.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
        pageScrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        scrollY: Math.round(scrollY),
        options: [...t.children].map((o) => {
          const b = o.getBoundingClientRect()
          const icon = o.querySelector('.m-icon')?.getBoundingClientRect()
          const label = o.querySelector(':scope > :not(.m-icon)')
          const shown = label.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(label)
          const text = range.getBoundingClientRect()
          return {
            text: label.textContent.trim(),
            chosen: o.matches("[aria-current='true'], [aria-pressed='true']"),
            height: b.height,
            inTrack: b.left >= box.left - 0.5 && b.right <= box.right + 0.5,
            whole: label.scrollWidth <= label.clientWidth + 1,
            clearLeft: text.left - b.left,
            clearRight: b.right - text.right,
            iconOffCentre: icon == null ? 0 : (icon.left + icon.right) / 2 - (b.left + b.right) / 2,
            iconAbove: icon == null || icon.bottom <= shown.top + 0.5,
            iconBeside: icon == null || (icon.right <= shown.left + 0.5 && Math.abs((icon.top + icon.bottom) / 2 - (shown.top + shown.bottom) / 2) <= 1),
          }
        }),
      }
    })()`
    const master = origin(c.master) + prefix
    try {
      // Desktop: the filter pills, the run page's view switch, Appearance.
      const b = await browser('screens-sliders-1440', 1440, 900)
      try {
        await signIn(b, 'admin', c.master)
        const filter = '.m-filter'
        await b.open(master + '/projects')
        await b.script(settle)
        await expect(
          b,
          `document.querySelector('${filter}[data-thumb]') != null`,
          'the filter thumb',
        )
        await b.tap(await option(b, filter, 'iOS'))
        await expect(
          b,
          "location.search.includes('platform=ios')",
          'iOS chosen by a tap',
        )
        // The pills are drawn anew with the reload; focus stays on the choice.
        await expect(
          b,
          `document.activeElement?.matches('${filter} [aria-pressed=true]') === true`,
          'focus on the chosen filter option',
        )
        await step(
          b,
          'tap iOS in the platform filter on /projects',
          'slider-filter-tap.png',
          thumbOf(filter),
        )
        await b.drag(
          `${filter} > [data-thumb-on]`,
          await option(b, filter, 'Android'),
        )
        await expect(
          b,
          "location.search.includes('platform=android')",
          'Android chosen by a drag',
        )
        await expect(
          b,
          `document.querySelector('${filter} [aria-pressed=true]').textContent.trim().startsWith('Android') && document.querySelector('${filter}').style.getPropertyValue('--thumb-x') === document.querySelector('${filter} [aria-pressed=true]').offsetLeft + 'px'`,
          'the thumb on Android',
        )
        await step(
          b,
          'drag the filter thumb from iOS to Android',
          'slider-filter-drag.png',
          thumbOf(filter),
        )

        const view = '.m-seg[aria-label="Pipeline view"]'
        await b.open(
          master +
            resolve({
              name: 'run',
              path: '/runs/{run.succeeded}',
              as: 'admin',
              node: 'master',
            }),
        )
        await b.script(settle)
        await expect(
          b,
          `document.querySelector('${view}[data-thumb]') != null`,
          'the view thumb',
        )
        await b.drag(
          `${view} > [data-thumb-on]`,
          await option(b, view, 'Timeline'),
        )
        await expect(
          b,
          "location.search.includes('tab=timeline')",
          'Timeline chosen by a drag',
        )
        await step(
          b,
          'drag the run page’s view thumb from Graph to Timeline',
          'slider-run-drag.png',
          thumbOf(view),
        )

        const look = '.m-seg[aria-label="Appearance"]'
        await b.open(master + '/account')
        await b.script(settle)
        await expect(
          b,
          `document.querySelector('${look}[data-thumb]') != null`,
          'the Appearance thumb',
        )
        await b.drag(
          `${look} > [data-thumb-on]`,
          await option(b, look, 'Light'),
        )
        await expect(
          b,
          "document.documentElement.dataset.theme === 'light'",
          'Light chosen by a drag',
        )
        await step(
          b,
          'drag Appearance’s thumb to Light on /account',
          'slider-appearance-drag.png',
          `{ ...${thumbOf(look)}, theme: document.documentElement.dataset.theme }`,
        )
      } finally {
        await b.close()
      }

      // Phones: three tabs whose labels, where shown, clear their pills' ends.
      // A desktop window's scrollbar takes part of its width, so the bar is
      // measured too: from 360 px of bar the labels show.
      for (const [width, height] of [
        [390, 844],
        [375, 812],
        [360, 780],
      ] as const) {
        const p = await browser(`screens-sliders-${width}`, width, height)
        try {
          await signIn(p, 'admin', c.master)
          await p.open(master + '/projects')
          await p.script(settle)
          await expect(
            p,
            "document.querySelector('.m-tabbar__platter[data-thumb]') != null",
            'the tab bar thumb',
          )
          const tabs = JSON.parse(
            await p.script(`return JSON.stringify([...document.querySelectorAll('.m-tabbar__platter > .m-tabbar__item')].map((tab) => {
            const box = tab.getBoundingClientRect()
            const label = tab.querySelector('span:not(.m-icon)').getBoundingClientRect()
            return { label: tab.querySelector('span:not(.m-icon)').textContent.trim(), bar: document.querySelector('.m-app__tabbar').getBoundingClientRect().width, shown: label.width > 1, icon: tab.querySelector('.m-icon').getBoundingClientRect().width, width: box.width, radius: box.height / 2, left: label.left - box.left, right: box.right - label.right }
          }))`),
          ) as Array<{
            label: string
            bar: number
            shown: boolean
            icon: number
            width: number
            radius: number
            left: number
            right: number
          }>
          assert.deepEqual(
            tabs.map((tab) => tab.label),
            ['Projects', 'Install', 'More'],
            `${width} px`,
          )
          for (const tab of tabs) {
            // The icon always shows; only the label gives way.
            assert(
              tab.icon >= 16,
              `${width} px: ${tab.label}'s icon is ${tab.icon} px`,
            )
            assert.equal(
              tab.shown,
              tab.bar >= 360,
              `${width} px: ${tab.label}'s label ${tab.shown ? 'shows' : 'hides'} on a ${tab.bar} px bar`,
            )
            if (!tab.shown) continue
            assert(
              tab.left >= tab.radius - 0.5 && tab.right >= tab.radius - 0.5,
              `${width} px: ${tab.label} is ${tab.left.toFixed(1)} / ${tab.right.toFixed(1)} px from the ends of its ${tab.radius} px-radius pill`,
            )
          }
          log.push(
            `$ measure the tab bar at ${width} px`,
            JSON.stringify(tabs),
            '',
          )
          if (width === 390) {
            // A filter row that scrolls sideways keeps its swipes: a drag
            // from its thumb chooses nothing.
            await p.script(
              "document.querySelector('.m-filter').style.maxWidth = '120px'",
            )
            await expect(
              p,
              "document.querySelector('.m-filter[data-scrolls]') != null",
              'the filter row scrolls',
            )
            const before = await p.script('return location.search')
            await p.drag(
              '.m-filter > [data-thumb-on]',
              '.m-filter > :nth-child(2)',
            )
            await new Promise((resolve) => setTimeout(resolve, 700))
            assert.equal(
              await p.script('return location.search'),
              before,
              'a swipe on a scrolling filter row chose nothing',
            )
            log.push(
              '$ drag from the thumb of a filter row that scrolls sideways at 390 px',
              JSON.stringify({ search: before, after: before }),
              '',
            )
            await p.script(
              "document.querySelector('.m-filter').style.maxWidth = ''",
            )
            // At a larger text size the tabs stay 44 px: the labels give way
            // sooner, and the icon alone clears its pill's ends.
            const large = JSON.parse(
              await p.script(`document.documentElement.style.fontSize = '24px'
                await new Promise((resolve) => setTimeout(resolve, 300))
                const tabs = [...document.querySelectorAll('.m-tabbar__platter > .m-tabbar__item')].map((tab) => {
                  const box = tab.getBoundingClientRect()
                  const label = tab.querySelector('span:not(.m-icon)').getBoundingClientRect()
                  const icon = tab.querySelector('.m-icon').getBoundingClientRect()
                  const shown = label.width > 1
                  const left = Math.min(icon.left, shown ? label.left : Infinity), right = Math.max(icon.right, shown ? label.right : -Infinity)
                  return { shown, height: box.height, icon: icon.width, left: left - box.left, right: box.right - right }
                })
                document.documentElement.style.fontSize = ''
                return JSON.stringify(tabs)`),
            ) as Array<{
              shown: boolean
              height: number
              icon: number
              left: number
              right: number
            }>
            for (const tab of large) {
              assert.equal(tab.height, 44, 'a tab stays 44 px at 24 px text')
              assert(tab.icon >= 16, `icon ${tab.icon} px at 24 px text`)
              assert(
                tab.left >= 21.5 && tab.right >= 21.5,
                `at 24 px text a tab's contents are ${tab.left.toFixed(1)} / ${tab.right.toFixed(1)} px from its 22 px ends`,
              )
            }
            log.push(
              '$ measure the tab bar at 390 px with 24 px text',
              JSON.stringify(large),
              '',
            )

            await p.drag(
              '.m-tabbar__platter > [data-thumb-on]',
              '.m-tabbar__platter > a[href="/apps"]',
            )
            await expect(
              p,
              "location.pathname === '/apps'",
              'Install apps opened by a drag',
            )
            await step(
              p,
              'drag the tab bar thumb from Projects to Install at 390 px',
              'slider-tabbar-drag-390.png',
              thumbOf('.m-tabbar__platter'),
            )
            // A run chip whose branch wraps keeps its contents clear of its corners.
            await p.open(master + '/projects')
            await p.script(settle)
            await expect(
              p,
              "document.querySelector('.m-runchip .m-runchip__branch') != null",
              'a run chip with a branch',
            )
            const wrapped = await p.script(`
              const chip = document.querySelector('.m-runchip:has(.m-runchip__branch)')
              chip.querySelector('.m-runchip__branch').textContent = 'paul/aBranchNameLongEnoughToWrapOnAPhoneScreen0123456789abcd'
              return String(chip.getBoundingClientRect().height)`)
            assert(
              Number(wrapped) > 30,
              `the run chip wrapped (${wrapped} px tall)`,
            )
            const problems = JSON.parse(
              await p.script(SURFACE_CHECK),
            ) as string[]
            assert.deepEqual(problems, [], problems.join('\n'))
            await step(
              p,
              'wrap a run chip with a 60-character branch at 390 px and check its margins',
              'slider-runchip-wrapped-390.png',
              `{ height: document.querySelector('.m-runchip:has(.m-runchip__branch)').getBoundingClientRect().height, problems: ${JSON.stringify(problems.length)} }`,
            )
          }
        } finally {
          await p.close()
        }
      }

      // 175 % text in a window wide enough for labels: icon and label stay
      // inside the 44 px tab and clear its ends.
      const wide = await browser('screens-sliders-700', 700, 900)
      try {
        await signIn(wide, 'admin', c.master)
        await wide.open(master + '/projects')
        await wide.script(settle)
        await expect(
          wide,
          "document.querySelector('.m-tabbar__platter[data-thumb]') != null",
          'the tab bar thumb at 700 px',
        )
        const large = JSON.parse(
          await wide.script(`document.documentElement.style.fontSize = '28px'
            await new Promise((resolve) => setTimeout(resolve, 300))
            const tabs = [...document.querySelectorAll('.m-tabbar__platter > .m-tabbar__item')].map((tab) => {
              const box = tab.getBoundingClientRect()
              const label = tab.querySelector('span:not(.m-icon)').getBoundingClientRect()
              const icon = tab.querySelector('.m-icon').getBoundingClientRect()
              const shown = label.width > 1
              const parts = shown ? [icon, label] : [icon]
              return {
                shown,
                height: box.height,
                top: Math.min(...parts.map((r) => r.top)) - box.top,
                bottom: box.bottom - Math.max(...parts.map((r) => r.bottom)),
                left: Math.min(...parts.map((r) => r.left)) - box.left,
                right: box.right - Math.max(...parts.map((r) => r.right)),
              }
            })
            document.documentElement.style.fontSize = ''
            return JSON.stringify(tabs)`),
        ) as Array<{
          shown: boolean
          height: number
          top: number
          bottom: number
          left: number
          right: number
        }>
        for (const tab of large) {
          assert.equal(tab.height, 44, 'a tab stays 44 px at 28 px text')
          assert(
            tab.top >= -0.5 && tab.bottom >= -0.5,
            `at 28 px text a tab's contents spill ${(-Math.min(tab.top, tab.bottom)).toFixed(1)} px past it`,
          )
          assert(
            tab.left >= 21.5 && tab.right >= 21.5,
            `at 28 px text a tab's contents are ${tab.left.toFixed(1)} / ${tab.right.toFixed(1)} px from its 22 px ends`,
          )
        }
        log.push(
          '$ measure the tab bar in a 700 px window with 28 px text',
          JSON.stringify(large),
          '',
        )
      } finally {
        await wide.close()
      }

      // A tester's catalog on the host: the platform switch's links.
      const t = await browser('screens-sliders-host', 390, 844)
      try {
        await signIn(t, 'tester', host)
        const platforms = '.m-catalog-platforms .m-seg'
        await t.open(origin(host) + prefix + '/apps')
        await t.script(settle)
        await expect(
          t,
          `document.querySelector('${platforms}[data-thumb]') != null`,
          'the platform thumb',
        )
        const from = await t.script(
          `return document.querySelector('${platforms} [data-thumb-on]').textContent.trim()`,
        )
        const target = from.includes('iOS') ? 'Android' : 'iOS'
        // The page keeps its scroll when the switch's link is followed: a spacer
        // below the two apps makes it tall enough to scroll.
        const scrolled = await t.script(
          "const spacer = document.createElement('div'); spacer.style.height = '1200px'; document.querySelector('main').append(spacer); window.scrollTo(0, 60); return String(Math.round(scrollY))",
        )
        assert.equal(scrolled, '60', 'the page scrolled before the drag')
        await t.drag(
          `${platforms} > [data-thumb-on]`,
          await option(t, platforms, target),
        )
        await expect(
          t,
          `document.querySelector("${platforms} [aria-current='true']").textContent.trim().includes('${target}')`,
          `${target} chosen by a drag`,
        )
        assert.equal(
          await t.script('return String(Math.round(scrollY))'),
          scrolled,
          'the page kept its scroll',
        )
        await step(
          t,
          `drag the catalog platform thumb from ${from} to ${target} as a tester on the host`,
          'slider-catalog-drag-390.png',
          thumbOf(platforms),
        )
        // An app's page reads its builds per platform: it keeps its switch
        // (the same element) and its scroll while it reads the new one.
        await t.open(
          origin(host) +
            prefix +
            resolve({
              name: 'app',
              path: '/apps/{app.alpha}?platform=android',
              as: 'tester',
              node: 'host',
            }),
        )
        await t.script(settle)
        await expect(
          t,
          `document.querySelector('${platforms}[data-thumb]') != null`,
          'the app page’s platform thumb',
        )
        const kept = await t.script(
          `const spacer = document.createElement('div'); spacer.style.height = '1200px'; document.querySelector('main').append(spacer); document.querySelector('${platforms}').dataset.qaSame = 'yes'; window.scrollTo(0, 60); return String(Math.round(scrollY))`,
        )
        assert.equal(kept, '60', 'the app page scrolled before the drag')
        await t.drag(
          `${platforms} > [data-thumb-on]`,
          await option(t, platforms, 'iOS'),
        )
        await expect(
          t,
          "location.search.includes('platform=ios')",
          'iOS chosen on the app page',
        )
        await expect(
          t,
          `document.querySelector("${platforms} [aria-current='true']")?.textContent.trim().includes('iOS') === true`,
          'the iOS answer',
        )
        assert.equal(
          await t.script(
            `return String(document.querySelector('${platforms}').dataset.qaSame === 'yes' && Math.round(scrollY) === 60)`,
          ),
          'true',
          'the app page kept its switch and its scroll',
        )
        await step(
          t,
          'drag the platform thumb from Android to iOS on an app’s page as a tester',
          'slider-app-drag-390.png',
          `{ ...${thumbOf(platforms)}, sameSwitch: document.querySelector('${platforms}').dataset.qaSame === 'yes', scrollY: Math.round(scrollY) }`,
        )

        // Where the tab bar shows, the switch is laid out like it: every
        // option a 44 px pill, its icon centred over its whole label, the
        // options filling the page column.
        await t.open(origin(host) + prefix + '/apps')
        await t.script(settle)
        const stacked = await measure(
          t,
          'lay out the four-platform switch on Install apps at 390 px as a tester',
          'install-apps-stacked-390',
          layoutOf(platforms),
        )
        if (checked) {
          assert.deepEqual(
            stacked.options.map((o: Json) => o.text),
            ['iOS', 'Android', 'macOS', 'tvOS'],
          )
          assert(
            Math.abs(stacked.switchWidth - stacked.column) <= 1,
            `the switch spans the column (${stacked.switchWidth} of ${stacked.column} px)`,
          )
          assert(!stacked.scrolls, 'four platforms fit at 390 px')
          for (const o of stacked.options) {
            assert.equal(o.height, 44, `${o.text} is 44 px tall`)
            assert(o.whole, `${o.text} shows its whole label`)
            assert(
              Math.abs(o.iconOffCentre) <= 1 && o.iconAbove,
              `${o.text}'s icon is centred over its label`,
            )
            assert(
              o.clearLeft >= 21.5 && o.clearRight >= 21.5,
              `${o.text}'s label is ${o.clearLeft.toFixed(1)} / ${o.clearRight.toFixed(1)} px from its 22 px ends`,
            )
          }
          const problems = JSON.parse(await t.script(SURFACE_CHECK)) as string[]
          assert.deepEqual(problems, [], problems.join('\n'))
        }

        // 175 % text: the options keep whole labels and the switch scrolls
        // sideways inside its column; the page does not.
        await t.script(
          "document.documentElement.style.fontSize = '28px'; await new Promise((resolve) => setTimeout(resolve, 400)); return ''",
        )
        const large = await measure(
          t,
          'lay out the switch at 390 px with 28 px text',
          'install-apps-large-text-390',
          layoutOf(platforms),
        )
        const ends =
          await t.script(`const t = document.querySelector('${platforms}')
          t.scrollLeft = t.scrollWidth
          const end = t.scrollLeft
          t.scrollLeft = 0
          return JSON.stringify([end, t.scrollLeft])`)
        log.push('$ scroll the switch to its end and back', ends, '')
        await t.script(
          "document.documentElement.style.fontSize = ''; return ''",
        )
        if (checked) {
          assert(large.scrolls, 'the switch scrolls at 28 px text')
          assert(
            large.pageScrollWidth <= large.innerWidth,
            'the page does not scroll sideways',
          )
          for (const o of large.options)
            assert(o.whole, `${o.text} shows its whole label at 28 px text`)
          const [end, back] = JSON.parse(ends) as number[]
          assert(
            end! > 0 && back === 0,
            `the switch scrolled to ${end} and back to ${back}`,
          )
        }
      } finally {
        await t.close()
      }

      // A tablet keeps the switch's icons beside their labels.
      const platforms = '.m-catalog-platforms .m-seg'
      const tablet = await browser('screens-sliders-host-834', 834, 1194)
      try {
        await signIn(tablet, 'tester', host)
        await tablet.open(origin(host) + prefix + '/apps')
        await tablet.script(settle)
        await expect(
          tablet,
          `document.querySelector('${platforms}[data-thumb]') != null`,
          'the platform thumb at 834 px',
        )
        const inline = await measure(
          tablet,
          'lay out the switch on Install apps at 834 px',
          'install-apps-inline-834',
          layoutOf(platforms),
        )
        for (const o of inline.options)
          assert(
            o.iconBeside,
            `${o.text}'s icon sits beside its label at 834 px`,
          )
      } finally {
        await tablet.close()
      }
    } finally {
      writeFileSync(
        path.join(artifacts!, 'sliders-e2e.log'),
        log.join('\n') + '\n',
      )
    }
  })

  it('captures the host while its master is unreachable, then past the grace window', async function () {
    const offline = SCREENS.filter(
      (screen) => screen.state === 'offline' && wanted(screen),
    )
    const maintenance = SCREENS.filter(
      (screen) => screen.state === 'maintenance' && wanted(screen),
    )
    if (offline.length + maintenance.length === 0) return this.skip()
    // Signed in while the link is up; the link drops for the captures.
    await captureAll(
      'host-offline',
      [...offline, ...maintenance],
      async (each) => {
        await c.drop('host', 300, async () => {
          await each(offline)
          // Past the grace window the host stops serving.
          host.host!.advanceClock(
            ((host.host!.cache.host()?.offlineGraceHours ?? 72) + 1) *
              3_600_000,
          )
          try {
            await each(maintenance)
          } finally {
            host.host!.resetClock()
          }
        })
      },
    )
  })
})
