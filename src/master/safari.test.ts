// S1: Mason in iOS Safari, on an iPhone simulator driven by maestro-d's
// JavaScript library (app com.apple.mobilesafari). Skipped unless
// MASON_SAFARI_E2E=1; it needs MASON_SIMULATOR_UDID (a booted simulator),
// MASON_TEST_ROOT, MASON_ARTIFACTS, MAESTRO_D and MAESTRO_D_CLIENT_ROOT
// (MAESTRO_D_BIN when maestro-d is not on PATH). Run it compiled, from lib/.
//
// The master and the host serve a leaf certificate for `localhost` (397
// days, serverAuth, as Safari requires) from a test CA the simulator
// trusts. Sign-in is reached by a direct load and again after signing out,
// so the Argon2id worker runs under the shell's policy both ways: only the
// worker's own response allows WebAssembly. Each sign-in leaves with the
// keyboard up and must land with the trail below the top bar (Safari carries
// a keyboard into the next load). Saves safari-signed-in.png.
// Then a tester opens the host's Install apps on the phone, an app and a
// branch's builds, with the tab bar and its Install rows: safari-catalog.png.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { branchKey } from '../catalog/platform.js'
import type { RunningNode } from '../node/serve.js'
import { insertBuild } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { localOperator } from './roles.js'

interface Node {
  type?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
interface Device {
  command: (name: string, value?: unknown) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  hierarchy: () => Promise<Node>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  detach: (id: string) => Promise<void>
}

/** A test CA, and a leaf for `localhost` it signed, in `dir`. */
export function testCertificates(dir: string): {
  ca: string
  cert: string
  key: string
} {
  const file = (name: string): string => path.join(dir, name)
  const openssl = (...args: string[]): void => {
    execFileSync('openssl', args, { stdio: 'pipe' })
  }
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.pem'),
    '-days',
    '397',
    '-subj',
    '/CN=Mason test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  )
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('leaf.key'),
    '-out',
    file('leaf.csr'),
    '-subj',
    '/CN=localhost',
  )
  writeFileSync(
    file('leaf.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ].join('\n'),
  )
  openssl(
    'x509',
    '-req',
    '-in',
    file('leaf.csr'),
    '-CA',
    file('ca.pem'),
    '-CAkey',
    file('ca.key'),
    '-CAcreateserial',
    '-out',
    file('leaf.pem'),
    '-days',
    '397',
    '-sha256',
    '-extfile',
    file('leaf.ext'),
  )
  return { ca: file('ca.pem'), cert: file('leaf.pem'), key: file('leaf.key') }
}

describe('Mason in iOS Safari (S1)', function () {
  this.timeout(900_000)
  const enabled = process.env.MASON_SAFARI_E2E === '1'
  const {
    MASON_SIMULATOR_UDID: udid,
    MASON_TEST_ROOT: parent,
    MASON_ARTIFACTS: artifacts,
    MAESTRO_D: daemonName,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
  } = process.env
  let c: Cluster
  let host: RunningNode
  let root: string
  let alpha: number
  let tess: number
  let daemon: Daemon
  let device: Device
  const base = (node: RunningNode): string =>
    `https://localhost:${new URL(node.web!.url).port}`

  before(async function () {
    if (!enabled) return this.skip()
    assert(udid && parent && artifacts && daemonName && clientRoot)
    root = mkdtempSync(path.join(realpathSync(parent), 'safari-'))
    const certificates = testCertificates(root)
    execFileSync('xcrun', [
      'simctl',
      'keychain',
      udid,
      'add-root-cert',
      certificates.ca,
    ])
    const web = { cert: certificates.cert, key: certificates.key }
    c = await cluster(path.join(root, 'cluster'), {
      master: { webCert: web.cert, webKey: web.key },
    })
    host = await c.startHost('host', { web, testEndpoints: true })
    await c.master.master!.settings.set(localOperator, 'host', {
      origin: base(host),
      workerOrigin: base(host),
    })
    // Alpha for Tess's group, with an Android build on master the host holds.
    const master = c.master.master!
    const repo = c.repo('fixtures/safari')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(localOperator, 'safari', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [
        {
          bundleId: 'com.example.alpha',
          name: 'Alpha',
          platforms: ['ios', 'android'],
        },
      ],
    })
    const db = master.database.db
    alpha = Number(
      (
        db
          .prepare('SELECT id FROM apps WHERE slug=?')
          .get('com.example.alpha') as { id: number }
      ).id,
    )
    tess = (
      await master.people.create(localOperator, {
        name: 'Tess Tester',
        emails: ['tess@example.test'],
        role: 'tester',
      })
    ).id
    master.people.createGroup(localOperator, {
      name: 'Testers',
      apps: [alpha],
      members: [tess],
    })
    const bytes = Buffer.from('safari apk')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const key = digest.slice(0, 32) + '.apk'
    const channel = db
      .prepare("SELECT id FROM channels WHERE app_id=? AND platform='android'")
      .get(alpha) as { id: number }
    const build = insertBuild(
      db,
      {
        channelId: Number(channel.id),
        branch: 'master',
        commit: 'c'.repeat(40),
        version: '4.18.3',
        buildNumber: '26111301',
        bundleId: 'com.example.alpha',
        format: 'apk',
        size: bytes.length,
        digest,
        changelog: '',
        source: 'test',
        customFields: '{}',
      },
      key,
      { now: Date.now(), retentionDays: 14 },
    )
    writeFileSync(path.join(root, 'alpha.apk'), bytes)
    await host.host!.objects.put(key, path.join(root, 'alpha.apk'), digest)
    master.database.change('build', build.id)
    const cache = host.host!.cache.db
    await c.until(
      () =>
        cache.prepare('SELECT 1 FROM builds WHERE id=?').get(build.id) !=
          null &&
        cache.prepare('SELECT 1 FROM accounts WHERE id=?').get(tess) != null &&
        cache.prepare("SELECT 1 FROM groups WHERE name='Testers'").get() !=
          null,
      30_000,
      'the build, Tess and her group on the host',
    )
    const require = createRequire(import.meta.url)
    const client = [
      path.join(clientRoot, 'dist/cjs/index.js'),
      path.join(clientRoot, 'npm/maestro-d/dist/cjs/index.js'),
    ].find((entry) => existsSync(entry))
    assert(client, `No maestro-d client under ${clientRoot}`)
    const { MaestroD } = require(client) as {
      MaestroD: { connect: (options: object) => Promise<Daemon> }
    }
    daemon = await MaestroD.connect({ name: daemonName })
    device = await daemon.attach({
      device: udid,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'none',
      commandTimeout: 120_000,
      outputDir: path.join(realpathSync(parent), 'maestro-output'),
    })
    // Safari's first launch on a new simulator can drop the link and stay
    // on its start page: open the master until its page shows.
    const open = async (): Promise<void> => {
      await device.command('openLink', `${base(c.master)}/sign-in`)
      await dismiss()
    }
    for (let attempt = 1; attempt < 3; attempt++) {
      await open()
      const shown = await device
        .command('assertVisible', { text: 'Sign in', timeout: 20_000 })
        .then(
          () => true,
          () => false,
        )
      if (shown) return
      console.log(`S1: Safari did not show sign-in (try ${attempt})`)
    }
    await open()
    await visible('Sign in')
  })
  after(async () => {
    if (device != null) await daemon.detach(udid!).catch(() => undefined)
    await c?.close()
  })

  const visible = async (text: string): Promise<void> => {
    try {
      await device.command('assertVisible', { text, timeout: 60_000 })
    } catch (error) {
      writeFileSync(
        path.join(artifacts!, 'safari-failure.png'),
        await device.screenshot(),
      )
      throw error
    }
  }
  /** Safari's tips and its offer to save the password cover the page; close any that shows. */
  const dismiss = async (text = 'Close'): Promise<void> => {
    await device
      .command('tapOn', { text, optional: true, timeout: 3000 })
      .catch(() => undefined)
  }
  const find = (node: Node, text: string): Node | undefined =>
    node.text === text
      ? node
      : (node.children ?? [])
          .map((child) => find(child, text))
          .find((found) => found != null)
  /** The page's breadcrumb trail lies wholly below the sticky top bar. */
  const trailBelowBar = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const tree = await device.hierarchy()
    const bar = find(tree, 'banner')?.bounds
    const trail = find(tree, 'Breadcrumb, navigation')?.bounds
    assert(bar && trail, 'the top bar and the trail')
    assert(
      trail.y >= bar.y + bar.height,
      `the trail (top ${trail.y}) under the top bar (bottom ${bar.y + bar.height})`,
    )
  }
  /**
   * Taps the control of this type and name at its centre: a field and its
   * label share the name, and a tap on the label does not move Safari's focus.
   */
  const tapControl = async (type: string, text: string): Promise<void> => {
    const find = (node: Node): Node | undefined =>
      node.type === type && node.text === text
        ? node
        : (node.children ?? []).map(find).find((found) => found != null)
    const found = find(await device.hierarchy())
    assert(found?.bounds, `No ${type} named ${text}`)
    const { x, y, width, height } = found.bounds
    await device.command('tapOn', {
      point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`,
    })
  }
  /** Signs in as Paul through the web app's form, whose worker hashes the password. */
  const signIn = async (): Promise<void> => {
    await visible('Username or email')
    // Safari's keyboard covers the lower field once it is up, and does not
    // go away when asked: the password first, then the username above it,
    // whose Return submits the form.
    await tapControl('SecureTextField', 'Password')
    await device.command('inputText', 'Correct-Horse-9')
    await tapControl('TextField', 'Username or email')
    await device.command('inputText', 'paul')
    await device.command('pressKey', 'Enter')
  }
  /** Paul's sessions on the master: a sign-in adds one, signing out ends it. */
  const sessions = (): number =>
    Number(
      (
        c.master
          .master!.database.db.prepare(
            "SELECT COUNT(*) AS n FROM master_sessions s JOIN accounts a ON a.id=s.account_id WHERE a.username='paul'",
          )
          .get() as { n: number }
      ).n,
    )

  it('signs in on the master by a direct load and again after signing out, hashing in the worker under the shell’s CSP', async () => {
    const before = sessions()
    await device.command('openLink', `${base(c.master)}/sign-in`)
    await dismiss()
    await visible('Sign in')
    await signIn()
    // Signed in: the master's home.
    await visible('Projects & apps')
    await dismiss('Never for This Website')
    await trailBelowBar()
    assert.equal(sessions(), before + 1)
    // Sign out from the web app's account menu: a full load to sign-in.
    await device.command('openLink', `${base(c.master)}/_web/projects`)
    await dismiss()
    await visible('Projects & apps')
    await device.command('tapOn', { text: 'Your account' })
    await device.command('tapOn', { text: 'Sign out' })
    await visible('You are signed out.')
    assert.equal(sessions(), before)
    // Signed in again from the page sign-out left on.
    await signIn()
    await visible('Projects & apps')
    await dismiss('Not Now')
    await trailBelowBar()
    assert.equal(sessions(), before + 1)
    writeFileSync(
      path.join(artifacts!, 'safari-signed-in.png'),
      await device.screenshot(),
    )
  })

  it('shows a tester the host’s Install apps on the phone: an app, a branch’s builds with Install, and the tab bar', async () => {
    // Safari cannot be handed a cookie: the host opens her session itself.
    const { token } = host.host!.accounts.startSession(tess)
    await device.command('openLink', `${base(host)}/test/session/${token}`)
    await dismiss()
    await device.command('openLink', `${base(host)}/apps`)
    await dismiss()
    await visible('Choose an app to browse recent builds')
    // The tab bar holds her two destinations.
    await visible('Install')
    await visible('Devices')
    await device.command('tapOn', { text: 'Alpha' })
    // iOS is the phone's own platform; Alpha has no iOS builds yet.
    await visible('There are currently no builds for iOS.*')
    await visible('Android')
    await device.command(
      'openLink',
      `${base(host)}/apps/${alpha}/branches/${branchKey('master')}?platform=android`,
    )
    await dismiss()
    await visible('Android builds · newest first')
    await visible('.*26111301.*')
    const tree = await device.hierarchy()
    assert(
      find(tree, 'Install 4.18.3 build 26111301') != null,
      'the build’s Install row',
    )
    writeFileSync(
      path.join(artifacts!, 'safari-catalog.png'),
      await device.screenshot(),
    )
  })
})
