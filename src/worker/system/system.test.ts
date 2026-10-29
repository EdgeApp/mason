import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import type { Graph, GraphStage } from '../../pipeline/graph.js'
import {
  asNodeType,
  storedNodeType,
  type NodeType,
} from '../../master/nodeTypes.js'
import {
  applyXcodeVersion,
  needsXcode,
  xcodeSpec,
} from '../../master/scheduler.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { RuntimeStore } from '../../master/runtimes.js'
import { NOMAC_HELPER } from '../../master/runtime.js'
import { EventEmitter } from 'node:events'
import { FakeApple } from '../../test/fakeApple.js'
import { FakeMac, fakeXcode } from '../../test/fakeMac.js'
import type { FullInventory } from '../inventory.js'
import { scanXcodes } from '../inventory.js'
import { systemInventory, xcodeLaunches } from './index.js'
import {
  checklist,
  performItem,
  reconcile,
  reconcilePlan,
  type ItemContext,
  type Progress,
} from './reconcile.js'
import { prepareXcode, removeSimulatorSet, simulatorSet } from './xcode.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'system-'))
const GB = 1024 ** 3
const admin = { role: 'admin' as const, label: 'paul' }

const type = (value: unknown): NodeType =>
  asNodeType(value, undefined, { by: 'paul', at: 1 })

function inventory(extra: Partial<FullInventory> = {}): FullInventory {
  return {
    name: 'mac',
    type: 'mac-xcode',
    labels: [],
    os: 'macos',
    osVersion: '26.1',
    arch: 'arm64',
    hostname: 'mac',
    freeDisk: 500 * GB,
    slots: 1,
    version: '0.1.0',
    xcodes: [],
    tools: {
      node: [],
      rust: [],
      java: [],
      python: [],
      go: [],
      ruby: [],
      android: [],
    },
    ...extra,
  }
}

/** Serves `.xip` files for item tests: `/good/<version>` is Apple-signed, `/bad` is not. */
async function xipServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const version = /^\/good\/(.+)$/.exec(req.url ?? '')?.[1]
    res.end(
      version == null
        ? 'tampered'
        : `xcode:${version}:B${version.replace(/\./g, '')}`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
}

function itemContext(
  mac: FakeMac,
  base: string,
  store: Map<string, string>,
  log: string[] = [],
): ItemContext {
  const scratch = mkdtempSync(path.join(mac.work, 'scratch-'))
  return {
    log: (text) => log.push(text),
    helper: mac.helper,
    authorize: async (version) => ({
      url: `${base}/good/${version}`,
      cookie: 'ADCDownloadAuth=one-file',
    }),
    installTool: async (): Promise<void> => {
      log.push('tool installed\n')
    },
    fetchRuntime: async (name, file): Promise<boolean> => {
      const contents = store.get(name)
      if (contents == null) return false
      writeFileSync(file, contents)
      return true
    },
    storeRuntime: async (name, file): Promise<void> => {
      const { readFileSync } = await import('node:fs')
      store.set(name, readFileSync(file, 'utf8'))
    },
    run: mac.run,
    scratch,
    xcodes: () => scanXcodes(mac.applications),
    launches: async (install) => (await xcodeLaunches(install, mac.run)).ok,
  }
}

describe('Node software', () => {
  let xips: { server: Server; url: string }
  before(async () => {
    xips = await xipServer()
  })
  after(() => {
    xips.server.close()
  })

  it('U9.3 plans the installs a node lacks for its type, on macOS and Linux', () => {
    const mac = type({
      software: {
        xcode: ['26.1', '26.0'],
        xcodeDefault: '26.1',
        simulators: ['iOS 26.1', 'iOS 18.6'],
        commandLineTools: true,
        rosetta: true,
        brew: { formulae: ['jq', 'swiftlint'], casks: ['temurin'] },
        apt: ['curl'],
        node: '24',
        java: '21',
        android: ['platforms;android-35'],
      },
      settings: { noSleep: true, devToolsSecurity: true, automationMode: true },
    })
    const plan = reconcilePlan(mac, {
      inventory: {
        ...inventory({
          xcodes: [
            {
              version: '26.1',
              build: '17B55',
              path: '/Applications/Xcode-26.1.app',
              beta: false,
            },
          ],
          tools: {
            node: ['24.11.1'],
            rust: [],
            java: [],
            python: [],
            go: [],
            ruby: [],
            android: [],
          },
        }),
        system: {
          commandLineTools: true,
          rosetta: false,
          brew: { formulae: ['jq'], casks: [] },
          settings: {
            noSleep: true,
            devToolsSecurity: false,
            automationMode: false,
          },
          runtimes: [
            { name: 'iOS 26.1', version: '26.1', build: 'X', identifier: 'r' },
          ],
          launches: {},
        },
      },
      inUse: [],
    })
    assert.deepEqual(
      plan.map((item) => item.id),
      [
        'xcode:26.0',
        'runtime:iOS 18.6',
        'rosetta',
        'brew:swiftlint',
        'brew-cask:temurin',
        'setting:devToolsSecurity',
        'setting:automationMode',
        'java:21',
        'android:platforms;android-35',
      ],
    )
    // Rosetta is for Apple silicon; apt is not a macOS package manager.
    assert(
      !reconcilePlan(mac, {
        inventory: {
          ...inventory({ arch: 'x64' }),
          system: { runtimes: [], launches: {} },
        },
        inUse: [],
      }).some((item) => item.id === 'rosetta'),
    )

    const linux = type({
      software: {
        apt: ['curl', 'git'],
        dnf: ['make'],
        docker: true,
        node: '24',
      },
    })
    const linuxInventory = (system: Json): Json => ({
      ...inventory({ os: 'linux' }),
      system,
    })
    assert.deepEqual(
      reconcilePlan(linux, {
        inventory: linuxInventory({
          apt: ['git'],
          docker: false,
          runtimes: [],
          launches: {},
        }),
        inUse: [],
      }).map((item) => item.id),
      ['apt:curl', 'docker', 'node:24'],
    )
    assert.deepEqual(
      reconcilePlan(linux, {
        inventory: linuxInventory({
          dnf: [],
          docker: true,
          runtimes: [],
          launches: {},
        }),
        inUse: [],
      }).map((item) => item.id),
      ['dnf:make', 'node:24'],
    )
    assert.deepEqual(
      reconcilePlan(type({}), { inventory: inventory(), inUse: [] }),
      [],
    )
  })

  it('U9.3/U9.4/U9.7/U9.8 reconciles through the helper, reports progress, and keeps going after a failure', async () => {
    const dir = root()
    const mac = new FakeMac(dir)
    fakeXcode(path.join(mac.applications, 'Xcode.app'), '26.0.1', '17A400')
    mac.failing.add('nope')
    mac.failing.add('devToolsSecurity')
    const t = type({
      software: {
        xcode: ['26.1'],
        commandLineTools: true,
        rosetta: true,
        brew: { formulae: ['jq', 'nope'], casks: ['temurin'] },
        node: '24',
      },
      settings: { noSleep: true, devToolsSecurity: true, automationMode: true },
    })
    const base = scanXcodes(mac.applications)
    const state = {
      inventory: {
        ...inventory({ xcodes: base }),
        system: await systemInventory({
          os: 'macos',
          arch: 'arm64',
          xcodes: base,
          run: mac.run,
        }),
      },
      inUse: [],
    }
    assert.deepEqual(state.inventory.system.settings, {
      noSleep: false,
      devToolsSecurity: false,
      automationMode: false,
    })
    const plan = reconcilePlan(t, state)
    const progress: Progress[] = []
    const log: string[] = []
    const results = await reconcile(plan, {
      ...itemContext(mac, xips.url, new Map(), log),
      helperReady: true,
      progress: (entry) => progress.push(entry),
    })
    const states = Object.fromEntries(
      results.map((entry) => [entry.item, entry.state]),
    )
    assert.deepEqual(states, {
      'xcode:26.1': 'done',
      commandLineTools: 'done',
      rosetta: 'done',
      'brew:jq': 'done',
      'brew:nope': 'failed',
      'brew-cask:temurin': 'done',
      'setting:noSleep': 'done',
      'setting:devToolsSecurity': 'failed',
      'setting:automationMode': 'done',
      'node:24': 'done',
    })
    assert.equal(
      progress.filter((entry) => entry.state === 'running').length,
      plan.length,
    )
    assert.match(
      results.find((entry) => entry.item === 'brew:nope')!.error!,
      /No available formula/,
    )
    // Xcode: downloaded with the one-file authorization, verified, side by side, licensed, first launch run.
    assert.deepEqual(mac.installed(), ['Xcode-26.1.app', 'Xcode.app'])
    const xcode = path.join(mac.applications, 'Xcode-26.1.app')
    assert(
      mac.calls.some(
        (call) =>
          call.join(' ') === `root pkgutil --check-signature ${call[3]}` &&
          call[3]!.endsWith('Xcode-26.1.xip'),
      ),
    )
    assert(
      mac.calls.some(
        (call) => call[1] === 'xcodebuild' && call[2] === '-license',
      ),
    )
    assert(
      mac.calls.some(
        (call) => call[1] === 'xcodebuild' && call[2] === '-runFirstLaunch',
      ),
    )
    assert(!mac.calls.some((call) => call.includes('xcode-select')))
    assert.deepEqual(
      scanXcodes(mac.applications).map((install) => install.path),
      [xcode, path.join(mac.applications, 'Xcode.app')],
    )
    // Homebrew runs as the Mason user, everything else as root.
    assert(
      mac.calls.some(
        (call) => call.join(' ') === 'root brew install jq (as user)',
      ),
    )
    assert(
      mac.calls.some(
        (call) =>
          call.join(' ') === 'root brew install --cask temurin (as user)',
      ),
    )
    assert.equal(mac.clt, true)
    assert.equal(mac.rosetta, true)
    assert.deepEqual(mac.settings, {
      noSleep: true,
      devToolsSecurity: false,
      automationMode: true,
    })
    assert(log.includes('tool installed\n'))

    // A second pass has only the failures left; a node without the helper waits.
    const again = reconcilePlan(t, {
      inventory: {
        ...inventory({
          xcodes: scanXcodes(mac.applications),
          tools: {
            node: ['24.11.1'],
            rust: [],
            java: [],
            python: [],
            go: [],
            ruby: [],
            android: [],
          },
        }),
        system: await systemInventory({
          os: 'macos',
          arch: 'arm64',
          xcodes: [],
          run: mac.run,
        }),
      },
      inUse: [],
    })
    assert.deepEqual(
      again.map((item) => item.id),
      ['brew:nope', 'setting:devToolsSecurity'],
    )
    const blocked = await reconcile(again, {
      ...itemContext(mac, xips.url, new Map()),
      helperReady: false,
      progress: () => undefined,
    })
    assert.deepEqual(
      blocked.map((entry) => entry.state),
      ['blocked', 'blocked'],
    )
  })

  it('U9.4 refuses a tampered Xcode archive and leaves nothing installed', async () => {
    const mac = new FakeMac(root())
    const context = {
      ...itemContext(mac, xips.url, new Map()),
      authorize: async (): Promise<{ url: string; cookie: string }> => ({
        url: `${xips.url}/bad`,
        cookie: 'x=y',
      }),
    }
    await assert.rejects(
      performItem(
        { id: 'xcode:26.1', kind: 'xcode', version: '26.1' },
        context,
      ),
      /not signed by Apple/,
    )
    assert.deepEqual(mac.installed(), [])
    assert(!existsSync(path.join(context.scratch, 'xcode', 'Xcode-26.1.xip')))
    await assert.rejects(
      performItem(
        { id: 'xcode:26.1', kind: 'xcode', version: '26.1' },
        {
          ...context,
          authorize: async () => ({
            url: `${xips.url.replace(/:\d+$/, ':1')}/x`,
            cookie: '',
          }),
        },
      ),
    )
  })

  it('U9.5 exports a simulator runtime once and imports it on each node, skipping runtimes already there', async () => {
    const store = new Map<string, string>()
    const macs = [new FakeMac(root()), new FakeMac(root())]
    for (const mac of macs)
      fakeXcode(path.join(mac.applications, 'Xcode-26.1.app'), '26.1', '17B55')
    for (const mac of macs)
      await performItem(
        { id: 'runtime:iOS 26.1', kind: 'runtime', name: 'iOS 26.1' },
        itemContext(mac, xips.url, store),
      )
    assert.deepEqual(
      macs.map((mac) => mac.downloads),
      [1, 0],
    )
    assert.deepEqual([...store.keys()], ['iOS 26.1'])
    for (const mac of macs)
      assert.deepEqual(
        mac.runtimes.map((runtime) => runtime.name),
        ['iOS 26.1'],
      )
    const download = macs[0]!.calls.find(
      (call) => call[0] === 'xcodebuild' && call[1] === '-downloadPlatform',
    )!
    assert.deepEqual(download.slice(1, 5), [
      '-downloadPlatform',
      'iOS',
      '-buildVersion',
      '26.1',
    ])
    assert(download.at(-1)!.endsWith('Xcode-26.1.app/Contents/Developer'))
    const t = type({ software: { simulators: ['iOS 26.1'] } })
    const system = await systemInventory({
      os: 'macos',
      arch: 'arm64',
      xcodes: [],
      run: macs[1]!.run,
    })
    assert.deepEqual(
      reconcilePlan(t, { inventory: { ...inventory(), system }, inUse: [] }),
      [],
    )
    // No launching Xcode: the runtime cannot be fetched.
    const bare = new FakeMac(root())
    await assert.rejects(
      performItem(
        { id: 'runtime:iOS 26.1', kind: 'runtime', name: 'iOS 26.1' },
        itemContext(bare, xips.url, new Map()),
      ),
      /No Xcode on this node launches/,
    )
    macs[0]!.failing.add('iOS 18.6')
    await assert.rejects(
      performItem(
        { id: 'runtime:iOS 18.6', kind: 'runtime', name: 'iOS 18.6' },
        itemContext(macs[0]!, xips.url, new Map()),
      ),
      /downloadPlatform failed/,
    )
  })

  it('U9.7 installs apt and dnf packages and Docker through the helper on Linux', async () => {
    const ops: Array<[string, Record<string, unknown>]> = []
    const context = {
      ...itemContext(new FakeMac(root()), xips.url, new Map()),
      helper: async (
        op: string,
        args: Record<string, unknown>,
      ): Promise<null> => {
        ops.push([op, args])
        return null
      },
    }
    const t = type({ software: { apt: ['curl'], docker: true } })
    const plan = reconcilePlan(t, {
      inventory: {
        ...inventory({ os: 'linux' }),
        system: { apt: [], docker: false, runtimes: [], launches: {} },
      },
      inUse: [],
    })
    await reconcile(plan, {
      ...context,
      helperReady: true,
      progress: () => undefined,
    })
    await performItem({ id: 'dnf:make', kind: 'dnf', package: 'make' }, context)
    assert.deepEqual(ops, [
      ['apt.install', { packages: ['curl'] }],
      ['docker.install', {}],
      ['dnf.install', { packages: ['make'] }],
    ])
  })

  it('U9.10 removes unpinned Mason Xcodes and runtimes oldest first when disk is low, never one in use', async () => {
    const t = type({
      software: { xcode: ['26.1'], simulators: ['iOS 26.1'] },
      diskThresholdGb: 40,
    })
    const xcode = (version: string, name = `Xcode-${version}.app`): Json => ({
      version,
      build: 'B',
      path: `/Applications/${name}`,
      beta: false,
    })
    const system = {
      runtimes: [
        {
          name: 'iOS 26.1',
          version: '26.1',
          build: 'a',
          identifier: 'r1',
          image: '11111111-1111-1111-1111-111111111111',
        },
        {
          name: 'iOS 18.6',
          version: '18.6',
          build: 'b',
          identifier: 'r2',
          image: '22222222-2222-2222-2222-222222222222',
        },
        {
          name: 'iOS 17.5',
          version: '17.5',
          build: 'c',
          identifier: 'r3',
          image: '33333333-3333-3333-3333-333333333333',
        },
        { name: 'iOS 26.0', version: '26.0', build: 'd', identifier: 'r4' },
      ],
      launches: {},
    }
    const low = inventory({
      freeDisk: 10 * GB,
      xcodes: [
        xcode('25.4', 'Xcode.app'),
        xcode('26.0'),
        xcode('25.0'),
        xcode('26.1'),
        xcode('25.2'),
      ],
    })
    assert.deepEqual(
      reconcilePlan(t, { inventory: { ...low, system }, inUse: [] }).map(
        (item) => item.id,
      ),
      [
        'remove-xcode:25.0',
        'remove-xcode:25.2',
        'remove-xcode:26.0',
        'remove-runtime:iOS 17.5',
        'remove-runtime:iOS 18.6',
      ],
    )
    assert.deepEqual(
      reconcilePlan(t, {
        inventory: { ...low, system },
        inUse: ['/Applications/Xcode-25.2.app'],
      }).map((item) => item.id),
      ['remove-xcode:25.0', 'remove-xcode:26.0'],
    )
    assert.deepEqual(
      reconcilePlan(t, {
        inventory: { ...low, freeDisk: 100 * GB, system },
        inUse: [],
      }),
      [],
    )

    // Removal stops as soon as free disk is back above the threshold.
    const mac = new FakeMac(root())
    for (const version of ['25.0', '26.0'])
      fakeXcode(
        path.join(mac.applications, `Xcode-${version}.app`),
        version,
        'B',
      )
    let free = 10 * GB
    const plan = reconcilePlan(type({ diskThresholdGb: 40 }), {
      inventory: {
        ...inventory({ freeDisk: free, xcodes: scanXcodes(mac.applications) }),
        system: { runtimes: [], launches: {} },
      },
      inUse: [],
    })
    const results = await reconcile(plan, {
      ...itemContext(mac, xips.url, new Map()),
      helperReady: true,
      progress: () => undefined,
      freeDisk: () => free,
      thresholdBytes: 40 * GB,
      helper: async (op, args) => {
        free += 50 * GB
        return await mac.helper(op, args)
      },
    })
    assert.deepEqual(
      results.map((entry) => `${entry.item}:${entry.state}`),
      ['remove-xcode:25.0:done', 'remove-xcode:26.0:skipped'],
    )
    assert.deepEqual(mac.installed(), ['Xcode-26.0.app'])
    await assert.rejects(
      mac.helper('xcode.remove', { version: '24.0' }),
      /not installed/,
    )
    await assert.rejects(
      mac.helper('runtime.remove', { image: 'not-a-uuid' }),
      /UUID/,
    )
  })

  it('U9.9 lists the manual steps a node needs and what each blocks', () => {
    const state = (extra: Json = {}): Json => ({
      inventory: {
        ...inventory({
          xcodes: [
            {
              version: '27.0',
              build: 'X',
              path: '/Applications/Xcode-27.0.app',
              beta: false,
            },
          ],
        }),
        system: {
          runtimes: [],
          launches: {
            '/Applications/Xcode-27.0.app': {
              ok: false,
              error: 'requires macOS 27',
            },
          },
          ...extra,
        },
      },
      inUse: [],
    })
    const withBrew = type({ software: { brew: { formulae: ['jq'] } } })
    assert.deepEqual(
      checklist(withBrew, state(), false).map((item) => [item.id, item.blocks]),
      [
        ['helper', ['system']],
        ['xcode-launch:27.0', ['xcode:27.0']],
        ['brew', ['brew']],
      ],
    )
    assert.match(
      checklist(withBrew, state(), true)[0]!.title,
      /Xcode 27\.0 does not run on macOS 26\.1: requires macOS 27/,
    )
    assert.deepEqual(
      checklist(
        undefined,
        state({ brew: { formulae: [], casks: [] } }),
        true,
      ).map((item) => item.id),
      ['xcode-launch:27.0'],
    )
  })

  it('U9.11 resolves the Xcode a stage asks for: its own, .xcode-version, the type default, betas only where allowed', () => {
    const stage = (extra: Partial<GraphStage>): GraphStage =>
      ({ name: 's', on: { os: 'macos' }, ...extra }) as GraphStage
    const plain = type({})
    const betas = type({
      software: { xcode: ['26.1'], xcodeDefault: '26.1', allowBeta: true },
    })
    assert.equal(needsXcode(stage({ on: 'linux' })), false)
    assert.equal(
      needsXcode(stage({ on: 'mac-xcode', apple: {} as never })),
      true,
    )
    assert.equal(xcodeSpec(stage({ on: 'linux' }), plain), undefined)
    assert.equal(xcodeSpec(stage({}), plain), 'latest')
    assert.equal(xcodeSpec(stage({}), betas), '26.1')
    assert.equal(
      xcodeSpec(stage({ tools: { xcode: 'latest-beta' } }), plain),
      'latest',
    )
    assert.equal(
      xcodeSpec(stage({ tools: { xcode: 'latest-beta' } }), betas),
      'latest-beta',
    )
    assert.equal(
      xcodeSpec(stage({ tools: { xcode: '>=26 <27' } }), betas),
      '>=26 <27',
    )
    const graph = {
      workflows: [
        {
          name: 'build',
          stages: [
            stage({}),
            stage({ name: 'own', tools: { xcode: '26.0.1' } }),
            stage({ name: 'lin', on: 'linux' }),
          ],
        },
      ],
    } as unknown as Graph
    assert.equal(applyXcodeVersion(graph, undefined), undefined)
    assert.match(
      String(applyXcodeVersion(graph, '$(rm -rf /)\n')),
      /Ignoring \.xcode-version/,
    )
    assert.equal(applyXcodeVersion(graph, '26.1\n'), undefined)
    assert.deepEqual(
      graph.workflows[0]!.stages.map((entry) => entry.tools?.xcode),
      ['26.1', '26.0.1', undefined],
    )
    assert.throws(
      () => type({ software: { xcode: ['26.1'], xcodeDefault: '25' } }),
      /one of software.xcode/,
    )
    assert.throws(
      () => type({ software: { simulators: ['Android 15'] } }),
      /list of names/,
    )
    assert.throws(() => type({ diskThresholdGb: -1 }), /gigabytes/)
    assert.throws(
      () => type({ software: { allowBeta: 'yes' } }),
      /true or false/,
    )
    assert.throws(() => type({ software: { node: '24; rm' } }), /version/)
    assert.equal(storedNodeType('nope'), undefined)
    assert.deepEqual(
      storedNodeType({ androidLicensesAccepted: { by: 'paul', at: 1 } })
        ?.androidLicensesAccepted,
      { by: 'paul', at: 1 },
    )
  })

  it('U9.12 readies a stage’s Xcode: first launch only when asked, its version first in the log, a private simulator set', async () => {
    const mac = new FakeMac(root())
    const app = path.join(mac.applications, 'Xcode-26.1.app')
    fakeXcode(app, '26.1', '17B55')
    const developer = path.join(app, 'Contents', 'Developer')
    const log: string[] = []
    const options = {
      run: mac.run,
      helper: mac.helper,
      log: (text: string): number => log.push(text),
    }
    mac.needsFirstLaunch.add(app)
    const xcode = await prepareXcode(developer, options)
    assert.deepEqual(xcode, {
      version: '26.1',
      build: '17B55',
      path: app,
      sdks: ['iphoneos26.1', 'macosx26.1'],
    })
    assert.equal(log[0], `Running first launch for ${app}\n`)
    assert.equal(
      log[1],
      `Xcode 26.1\nBuild version 17B55\nXcode: ${app}\nSDKs: iphoneos26.1, macosx26.1\n`,
    )
    const launches = (): number =>
      mac.calls.filter((call) => call[2] === '-runFirstLaunch').length
    assert.equal(launches(), 1)
    await prepareXcode(developer, options)
    assert.equal(launches(), 1)
    mac.noLaunch.set('26.1', 'dyld: Symbol not found')
    await assert.rejects(
      prepareXcode(developer, options),
      /does not launch: dyld: Symbol not found/,
    )
    const set = simulatorSet(path.join(mac.work, 'stage'))
    assert(existsSync(set))
    await removeSimulatorSet(set, mac.run, { DEVELOPER_DIR: developer })
    assert(!existsSync(set))
    assert(
      mac.calls.some((call) =>
        call.join(' ').startsWith(`xcrun simctl --set ${set} delete all`),
      ),
    )
    assert(!mac.calls.some((call) => call.includes('xcode-select')))
  })

  it('U9.5 keeps exported runtimes on the master, refusing oversized or aborted uploads', async () => {
    const dir = root()
    const store = new RuntimeStore(path.join(dir, 'runtimes'), 10)
    assert.deepEqual(store.list(), [])
    assert.equal(store.open('iOS 26.1'), undefined)
    const stream = (): EventEmitter & {
      abort(reason: string): void
      aborted?: string
    } => {
      const out = new EventEmitter() as EventEmitter & {
        abort(reason: string): void
        aborted?: string
      }
      out.abort = (reason): void => {
        out.aborted = reason
      }
      return out
    }
    const ok = stream()
    const putting = store.put('iOS 26.1', ok as never)
    ok.emit('data', Buffer.from('runtime'))
    ok.emit('end')
    assert.equal(await putting, 7)
    assert.deepEqual(store.list(), [{ name: 'iOS 26.1', size: 7 }])
    assert(store.open('iOS 26.1') != null)
    const big = stream()
    const tooBig = store.put('iOS 18.6', big as never)
    big.emit('data', Buffer.alloc(11))
    await assert.rejects(tooBig, /too large/)
    assert.equal(big.aborted, 'The runtime image is too large')
    const dropped = stream()
    const aborted = store.put('iOS 18.6', dropped as never)
    dropped.emit('abort', 'link closed')
    await assert.rejects(aborted, /link closed/)
    assert.deepEqual(
      store.list().map((entry) => entry.name),
      ['iOS 26.1'],
    )
  })

  describe('on a cluster', () => {
    let c: Cluster
    let apple: FakeApple
    let a: FakeMac
    let b: FakeMac
    let sockets: { a: string; b: string }
    const masonfile = `
import { existsSync } from 'node:fs'
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { want: { type: 'string', default: 'exact' } } }, () => {})
  const want = String(m.params.want)
  const on = { type: 'mac-xcode' }
  const tools =
    want === 'exact' ? { xcode: '26.1' } :
    want === 'beta' ? { xcode: 'latest-beta' } :
    want === 'never' ? { xcode: '25.0' } :
    want === 'ondemand' ? { xcode: '26.3' } :
    want === 'sims' ? { xcode: '26.1', simulators: ['iOS 26.1'] } :
    want === 'rg' ? { xcode: '26.1', brew: ['ripgrep'] } : undefined
  m.stage('use', { on: want === 'macos' ? { os: 'macos' } : on, ...(tools == null ? {} : { tools }), run: use })
}
export async function use(ctx: Stage) {
  const set = ctx.node.simulatorSet
  return {
    node: ctx.node.name,
    developerDir: process.env.DEVELOPER_DIR ?? null,
    child: (await ctx.sh('printenv DEVELOPER_DIR', { quiet: true })).stdout.trim(),
    xcode: ctx.node.xcode ?? null,
    simulatorSet: set ?? null,
    simulatorEnv: process.env.MASON_SIMULATOR_SET ?? null,
    setExists: set == null ? null : existsSync(set),
  }
}
`
    before(async () => {
      const dir = root()
      apple = new FakeApple('builds@example.com', 'Apple-Password-9')
      apple.xcodes.set('26.3', { name: 'Xcode 26.3', build: '17E100' })
      await apple.start()
      a = new FakeMac(path.join(dir, 'a'))
      b = new FakeMac(path.join(dir, 'b'))
      for (const mac of [a, b]) {
        fakeXcode(path.join(mac.applications, 'Xcode.app'), '26.0.1', '17A400')
        fakeXcode(
          path.join(mac.applications, 'Xcode-26.1.app'),
          '26.1',
          '17B55',
        )
        fakeXcode(
          path.join(mac.applications, 'Xcode-25.0.app'),
          '25.0',
          '16A242',
        )
        mac.noLaunch.set('25.0', 'Xcode 25.0 requires macOS 25 or earlier')
      }
      fakeXcode(
        path.join(a.applications, 'Xcode-26.2-beta3.app'),
        '26.2',
        '17C5013d',
      )
      // On b, 26.1 does not run on its macOS.
      b.noLaunch.set('26.1', 'dyld: Library not loaded')
      sockets = {
        a: path.join(dir, 'a-helper.sock'),
        b: path.join(dir, 'b-helper.sock'),
      }
      writeFileSync(sockets.a, '')
      c = await cluster(path.join(dir, 'cluster'), {
        workers: [
          {
            name: 'mac-a',
            type: 'mac-xcode',
            workerOptions: {
              applications: a.applications,
              systemRun: a.run,
              helper: a.helper,
              helperSocket: sockets.a,
            },
          },
          {
            name: 'mac-b',
            type: 'mac-xcode',
            workerOptions: {
              applications: b.applications,
              systemRun: b.run,
              helper: b.helper,
              helperSocket: sockets.b,
              helperWatchMs: 50,
            },
          },
        ],
        masterOptions: { appleEndpoints: apple.endpoints },
      })
      const repo = c.repo('fixtures/xcodes')
      repo.commit({ 'Masonfile.ts': masonfile, '.xcode-version': '26.0.1\n' })
      repo.commit(
        { 'Masonfile.ts': masonfile, '.xcode-version': null },
        'nofile',
      )
      c.master.master!.saveProject(admin, 'xcodes', {
        repository: repo.url,
        rules: [{ pattern: '*', mode: 'request' }],
      })
      await c.master.master!.settings.set(admin, 'nodeTypes', {
        'mac-xcode': {},
      })
      // Each worker's background inventory reaches the master.
      await c.until(
        () =>
          ['mac-a', 'mac-b'].every(
            (name) =>
              c.master.master!.scheduler.inventoryOf(c.fingerprint(name))
                ?.system != null,
          ),
        20000,
        'system inventories',
      )
    })
    after(async () => {
      await c?.close()
      await apple?.close()
    })
    const start = async (want: string, branch = 'master'): Promise<string> => {
      const created = await c.api('POST', '/api/v2/runs', {
        project: 'xcodes',
        branch,
        params: { want },
      })
      assert.equal(created.status, 202, created.text)
      return created.json.id as string
    }
    const finish = async (id: string): Promise<Json> =>
      await c
        .until(
          () => {
            const run = c.master.master!.run(id) as Json
            return ['succeeded', 'failed', 'cancelled'].includes(run.status)
              ? run
              : undefined
          },
          60000,
          `run ${id}`,
        )
        .catch((error: Error) => {
          throw new Error(
            `${error.message}\n${JSON.stringify(c.master.master!.run(id))}\n${c.master.master!.scheduler.logs(id) ?? ''}`,
          )
        })
    const run = async (want: string, branch = 'master'): Promise<Json> =>
      await finish(await start(want, branch))
    const use = (value: Json): Json =>
      value.stages.find((stage: Json) => stage.name === 'use')
    const developer = (mac: FakeMac, name: string): string =>
      path.join(mac.applications, name, 'Contents', 'Developer')

    it('U9.11 places a stage only where its Xcode launches, and fails setup when it launches nowhere', async () => {
      for (let i = 0; i < 2; i++) {
        const exact = await run('exact')
        assert.equal(
          exact.status,
          'succeeded',
          c.master.master!.scheduler.logs(exact.id),
        )
        assert.equal(use(exact).output.node, 'mac-a')
        assert.equal(
          use(exact).output.developerDir,
          developer(a, 'Xcode-26.1.app'),
        )
      }
      const never = await run('never')
      assert.equal(never.status, 'failed')
      assert.match(
        never.reason,
        /use: Xcode 25\.0 does not launch on mac-(a|b) \(macOS [\d.]+\): Xcode 25\.0 requires macOS 25 or earlier/,
      )
      const details = c.master.master!.nodeDetails(
        c.fingerprint('mac-b'),
      ) as Json
      assert(
        details.checklist.some((item: Json) => item.id === 'xcode-launch:26.1'),
        JSON.stringify(details.checklist),
      )
      assert.equal(
        details.inventory.xcodes.find(
          (install: Json) => install.version === '26.1',
        ).launches,
        false,
      )
    })

    it('U9.11 uses .xcode-version, then the type default, and latest-beta only where the type allows betas', async () => {
      const file = await run('macos')
      assert.equal(
        file.status,
        'succeeded',
        c.master.master!.scheduler.logs(file.id),
      )
      assert.equal(use(file).output.xcode.version, '26.0.1')
      await c.master.master!.settings.set(admin, 'nodeTypes', {
        'mac-xcode': { software: { xcode: ['26.1'], xcodeDefault: '26.1' } },
      })
      const fallback = await run('macos', 'nofile')
      assert.equal(
        fallback.status,
        'succeeded',
        c.master.master!.scheduler.logs(fallback.id),
      )
      assert.equal(use(fallback).output.xcode.version, '26.1')
      assert.equal(use(fallback).output.node, 'mac-a')
      const latest = await run('beta')
      assert.equal(
        latest.status,
        'succeeded',
        c.master.master!.scheduler.logs(latest.id),
      )
      assert.notEqual(
        use(latest).output.developerDir,
        developer(a, 'Xcode-26.2-beta3.app'),
      )
      await c.master.master!.settings.set(admin, 'nodeTypes', {
        'mac-xcode': {
          software: { xcode: ['26.1'], xcodeDefault: '26.1', allowBeta: true },
        },
      })
      const beta = await run('beta')
      assert.equal(
        beta.status,
        'succeeded',
        c.master.master!.scheduler.logs(beta.id),
      )
      assert.equal(
        use(beta).output.developerDir,
        developer(a, 'Xcode-26.2-beta3.app'),
      )
    })

    it('U9.12 gives the stage its Xcode for every child process, logs it first, and a private simulator set it removes', async () => {
      const sims = await run('sims')
      assert.equal(
        sims.status,
        'succeeded',
        c.master.master!.scheduler.logs(sims.id),
      )
      const output = use(sims).output
      assert.equal(output.child, developer(a, 'Xcode-26.1.app'))
      assert.deepEqual(output.xcode, {
        version: '26.1',
        build: '17B55',
        path: path.join(a.applications, 'Xcode-26.1.app'),
        sdks: ['iphoneos26.1', 'macosx26.1'],
      })
      assert.equal(output.simulatorEnv, output.simulatorSet)
      assert.equal(output.setExists, true)
      assert(!existsSync(output.simulatorSet))
      assert(
        a.calls.some((call) =>
          call
            .join(' ')
            .startsWith(
              `xcrun simctl --set ${output.simulatorSet} shutdown all`,
            ),
        ),
      )
      const log = c.master.master!.scheduler.logs(sims.id)!
      const stageLog = log.slice(log.indexOf('── Stage use'))
      assert.match(
        stageLog,
        /^── Stage use[^\n]*\nXcode 26\.1\nBuild version 17B55\nXcode: [^\n]*Xcode-26\.1\.app\nSDKs: iphoneos26\.1, macosx26\.1\n/,
      )
      // The runtime was installed on demand while the stage prepared, and exported once to the master.
      assert.match(log, /installing simulators iOS 26\.1/)
      assert.deepEqual(
        c.master.master!.runtimes.list().map((entry) => entry.name),
        ['iOS 26.1'],
      )
      assert.equal(a.downloads, 1)
      assert(!a.calls.some((call) => call.includes('xcode-select')))

      a.needsFirstLaunch.add(path.join(a.applications, 'Xcode-26.1.app'))
      const first = await run('exact')
      assert.match(
        c.master.master!.scheduler.logs(first.id)!,
        /Running first launch for .*Xcode-26\.1\.app/,
      )
      const again = await run('exact')
      assert.doesNotMatch(
        c.master.master!.scheduler.logs(again.id)!,
        /Running first launch/,
      )
    })

    it('U9.3/U9.9 a stage that needs an install waits on the checklist while others run, then installs Xcode on demand', async () => {
      const master = c.master.master!
      await master.settings.set(admin, 'nodeTypes', {
        'mac-xcode': { software: { xcode: ['26.1'], xcodeDefault: '26.1' } },
      })
      const waiting = await start('ondemand')
      await c.until(
        () =>
          master.run(waiting) != null &&
          (master.run(waiting) as Json).stages.some(
            (stage: Json) => stage.name === 'use',
          ),
        20000,
        'the waiting stage',
      )
      // The Apple ID is not signed in: the master's checklist blocks downloads.
      // Another branch (one run per branch at a time) runs meanwhile.
      const other = await run('exact', 'nofile')
      assert.equal(other.status, 'succeeded')
      assert.equal(use(master.run(waiting) as Json).status, 'queued')
      const details = master.nodeDetails(c.fingerprint('mac-a')) as Json
      assert.deepEqual(details.checklist.map((item: Json) => item.id).sort(), [
        'apple',
        'xcode-launch:25.0',
      ])
      assert.deepEqual(
        (master.nodeDetails(c.fingerprint('mac-b')) as Json).checklist
          .map((item: Json) => item.id)
          .sort(),
        ['apple', 'helper', 'xcode-launch:25.0', 'xcode-launch:26.1'],
      )

      assert.equal(
        (
          await master.appleSignIn(
            admin,
            'builds@example.com',
            'Apple-Password-9',
          )
        ).state,
        'needsCode',
      )
      assert.equal(
        (await master.appleCode(admin, apple.code)).state,
        'signedIn',
      )
      const done = await finish(waiting)
      assert.equal(done.status, 'succeeded', master.scheduler.logs(waiting))
      assert.equal(use(done).output.node, 'mac-a')
      assert.equal(use(done).output.xcode.version, '26.3')
      assert(existsSync(path.join(a.applications, 'Xcode-26.3.app')))
      // The node downloaded from Apple with the one-file cookie only.
      assert.equal(apple.downloadCookies.length, 1)
      assert.match(apple.downloadCookies[0]!, /^ADCDownloadAuth=[0-9a-f]+$/)
      assert.doesNotMatch(
        master.scheduler.logs(waiting)!,
        /builds@example\.com|myacinfo/,
      )
      assert.equal(
        master.scheduler.requested(c.fingerprint('mac-a'), 'xcode', '26.3'),
        false,
      )
    })

    it('U9.3/U9.9 the master sends each node its type; a node without the helper waits until it has one', async () => {
      const master = c.master.master!
      await master.settings.set(admin, 'nodeTypes', {
        'mac-xcode': {
          software: {
            xcode: ['26.1'],
            xcodeDefault: '26.1',
            brew: { formulae: ['jq'] },
          },
          settings: { noSleep: true },
        },
      })
      const progress = (name: string): Json =>
        (master.nodeDetails(c.fingerprint(name)) as Json).reconcile?.items ?? {}
      await c.until(
        () =>
          progress('mac-a')['brew:jq']?.state === 'done' &&
          progress('mac-a')['setting:noSleep']?.state === 'done',
        20000,
        'mac-a reconciled',
      )
      await c.until(
        () => progress('mac-b')['brew:jq']?.state === 'blocked',
        20000,
        'mac-b blocked',
      )
      assert.deepEqual(a.brew!.formulae, ['jq'])
      assert.equal(b.brew!.formulae.length, 0)
      const inventoryA = master.scheduler.inventoryOf(c.fingerprint('mac-a'))!
      assert.deepEqual(inventoryA.system!.brew!.formulae, ['jq'])
      assert.equal(inventoryA.system!.settings!.noSleep, true)

      // The helper is installed on b; the next pass clears its checklist item and installs.
      writeFileSync(sockets.b, '')
      await master.settings.set(
        admin,
        'nodeTypes',
        master.settings.value('nodeTypes'),
      )
      await c.until(
        () => progress('mac-b')['brew:jq']?.state === 'done',
        20000,
        'mac-b reconciled',
      )
      await c.until(
        () =>
          !(master.nodeDetails(c.fingerprint('mac-b')) as Json).checklist.some(
            (item: Json) => item.id === 'helper',
          ),
        20000,
        'helper item cleared',
      )
      assert.deepEqual(b.brew!.formulae, ['jq'])
      rmSync(sockets.b)
    })

    it('U9.3 a helper installed after the worker started clears the checklist without a reconcile; a NoMac Mac says it has none by design', async () => {
      const master = c.master.master!
      const helperItem = (): Json | undefined =>
        (master.nodeDetails(c.fingerprint('mac-b')) as Json).checklist.find(
          (item: Json) => item.id === 'helper',
        )
      await c.until(() => helperItem() != null, 20000, 'helper item on b')
      // mason worker --install starts the worker, then the helper.
      writeFileSync(sockets.b, '')
      await c.until(() => helperItem() == null, 20000, 'helper item cleared')
      rmSync(sockets.b)
      await c.until(() => helperItem() != null, 20000, 'helper item back')
      assert.match(helperItem()!.title, /run sudo mason worker --install/)
      const fingerprint = c.fingerprint('mac-b')
      const host = master.registry.get(fingerprint)!.host
      master.database.db
        .prepare('UPDATE nodes SET host=? WHERE fingerprint=?')
        .run('nomac:ses_test', fingerprint)
      try {
        assert.deepEqual(helperItem(), NOMAC_HELPER)
      } finally {
        master.database.db
          .prepare('UPDATE nodes SET host=? WHERE fingerprint=?')
          .run(host, fingerprint)
      }
    })

    it('U9.3 installs a stage’s Homebrew formula on demand and refuses unwanted downloads and runtimes', async () => {
      const master = c.master.master!
      const rg = await run('rg')
      assert.equal(rg.status, 'succeeded', master.scheduler.logs(rg.id))
      assert.match(master.scheduler.logs(rg.id)!, /installing brew ripgrep/)
      assert(a.brew!.formulae.includes('ripgrep'))
      const methods = master.nodeStates.methods()
      const fakeLink = master.registry.link(c.fingerprint('mac-a'))!
      await assert.rejects(
        Promise.resolve(
          methods.requests!['xcode.authorize']!({ version: '24.0' }, fakeLink),
        ),
        /not wanted on this node/,
      )
      assert.throws(
        () =>
          methods.requests!['runtime.lookup']!(
            { name: 'iOS 26.1' },
            {} as never,
          ),
        /Only workers/,
      )
      assert.equal(
        (
          methods.requests!['runtime.lookup']!(
            { name: 'iOS 26.1' },
            fakeLink,
          ) as Json
        ).stored,
        true,
      )
      mkdirSync(path.join(c.master.dir, 'runtimes'), { recursive: true })
      assert.throws(
        () => master.runtimes.has('Android 15'),
        /Invalid simulator runtime name/,
      )
    })
  })
})
