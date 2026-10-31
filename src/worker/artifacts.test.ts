import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import { Link, LinkError, type Stream } from '../link/link.js'
import { memoryPair } from '../link/wire.js'
import type { StageAssignment } from '../pipeline/assignment.js'
import { desktop, manifest, zip } from '../upload/fixtures.test.js'
import {
  checkoutFile,
  checkoutPath,
  fetchArtifacts,
  publish,
  save,
  tests,
  type ArtifactContext,
} from './artifacts.js'
import { safe, select } from './stage.js'

const root = (): string =>
  mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'worker-artifacts-'),
  )

/**
 * The master's end of a worker's link: each artifact stream is read to its
 * end, recorded, and answered with the next scripted reply, as the master
 * relays the host's.
 */
class Master {
  readonly replies: Array<{ status: number; body: string | Buffer }> = []
  readonly sent: Array<{
    method: string
    params: Record<string, unknown>
    bytes: number
  }> = []
  readonly worker: Link
  constructor() {
    const [a, b] = memoryPair()
    const answer =
      (method: string) =>
      async (stream: Stream, params: unknown): Promise<void> => {
        const bytes = (await stream.collect()).length
        this.sent.push({
          method,
          params: params as Record<string, unknown>,
          bytes,
        })
        const reply = this.replies.shift() ?? {
          status: 500,
          body: JSON.stringify({ error: 'no reply scripted' }),
        }
        await stream.write(
          Buffer.concat([
            Buffer.from(`${JSON.stringify({ status: reply.status })}\n`),
            Buffer.from(reply.body),
          ]),
        )
        stream.end()
      }
    new Link(a, {
      localRole: 'master',
      peerRole: 'worker',
      dialer: true,
      methods: {
        streams: {
          'artifacts.publish': answer('artifacts.publish'),
          'artifacts.save': answer('artifacts.save'),
          'artifacts.download': answer('artifacts.download'),
        },
      },
    })
    this.worker = new Link(b, {
      localRole: 'worker',
      peerRole: 'master',
      dialer: false,
      methods: {},
    })
  }
}

describe('Stage file names', () => {
  it('U7.4 names a stage’s files by its key without characters tools read as escapes', () => {
    assert.equal(safe('run-1/ios-adhoc/1'), 'run-1_2fios-adhoc_2f1')
    assert.equal(safe('a_b'), 'a_5fb')
    // Distinct keys stay distinct.
    assert.notEqual(safe('a/b'), safe('a_2fb'))
    assert.doesNotMatch(safe('x %/:?'), /[%/: ?]/)
  })
})

describe('Worker artifact calls', function () {
  this.timeout(30_000)
  const master = new Master()

  const context = (
    overrides: Partial<ArtifactContext> = {},
    uploads: StageAssignment['uploads'] | null = undefined,
  ): ArtifactContext & {
    journalled: Array<[string, string]>
    logs: string[]
  } => {
    const dir = root()
    const journalled: Array<[string, string]> = []
    const logs: string[] = []
    return {
      assignment: {
        key: 'job/ship/1',
        token: 't',
        job: 'job',
        ...(uploads === null
          ? {}
          : {
              uploads: uploads ?? {
                token: 'stage-token',
                origin: 'https://host.example',
                reservations: [
                  {
                    id: 'a'.repeat(32),
                    app: 'test.example.app',
                    platform: 'macos',
                    buildNumber: '7',
                  },
                ],
              },
            }),
      } as StageAssignment,
      dir,
      scratch: path.join(dir, '.scratch'),
      request: async (): Promise<never> => {
        throw new LinkError('The master is not connected', 'closed')
      },
      stream: (method, params) => master.worker.openStream(method, params),
      connected: async (): Promise<void> => undefined,
      journal: (kind, data): void => {
        journalled.push([kind, data])
      },
      select,
      log: (text): void => {
        logs.push(text)
      },
      journalled,
      logs,
      ...overrides,
    }
  }

  it('U12.16 publishes a variant with its package’s own number inside the run’s block, and refuses one outside it before sending', async () => {
    const reservation = {
      id: 'b'.repeat(32),
      app: 'test.example.app',
      platform: 'android',
      buildNumber: '100',
      block: 3,
    }
    const ctx = context(
      {},
      {
        token: 'stage-token',
        origin: 'https://host.example',
        reservations: [reservation],
      },
    )
    const apk = (code: number): Buffer =>
      zip([['AndroidManifest.xml', manifest(false, false, code)]])
    writeFileSync(path.join(ctx.dir, 'arm64.apk'), apk(102))
    writeFileSync(path.join(ctx.dir, 'past.apk'), apk(103))
    const sends = master.sent.length
    master.replies.push({
      status: 201,
      body: JSON.stringify({
        buildId: 9,
        url: 'https://host.example/apps/1',
        installUrl: 'https://host.example/apps/1/branches/bWFpbg',
        visible: true,
      }),
    })
    const result = await publish(ctx, {
      app: 'test.example.app',
      platform: 'android',
      path: 'arm64.apk',
      variant: 'arm64-v8a',
    })
    assert.deepEqual(result, {
      buildId: 9,
      url: 'https://host.example/apps/1',
      installUrl: 'https://host.example/apps/1/branches/bWFpbg',
      visible: true,
      variant: 'arm64-v8a',
    })
    // The whole file goes to the master, with what it grants it by.
    const sent = master.sent.at(-1)!
    assert.equal(sent.method, 'artifacts.publish')
    assert.equal(sent.bytes, apk(102).length)
    assert.equal(sent.params.buildNumber, '102')
    assert.equal(sent.params.variant, 'arm64-v8a')
    assert.equal(sent.params.key, 'job/ship/1')
    assert.match(String(sent.params.digest), /^[0-9a-f]{64}$/)
    // Refused before anything is sent: past the block, a mismatched number, a bad name.
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'android',
        path: 'past.apk',
      }),
      /103 is outside the run's block 100–102/,
    )
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'android',
        path: 'arm64.apk',
        buildNumber: '101',
      }),
      /arm64\.apk is build 102, not 101/,
    )
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'android',
        path: 'arm64.apk',
        variant: 'not a name',
      }),
      /A variant is 1 to 32 letters/,
    )
    assert.equal(master.sent.length, sends + 1)
  })

  it('U12.7 waits while the master is away, then publishes through it; a staged publication is journalled once', async () => {
    let away = 2
    let waited = 0
    const ctx = context({
      stream: (method, params) => {
        if (away-- > 0)
          throw new LinkError('The master is not connected', 'closed')
        return master.worker.openStream(method, params)
      },
      connected: async () => {
        waited++
      },
    })
    writeFileSync(path.join(ctx.dir, 'app.dmg'), desktop('dmg'))
    master.replies.push({
      status: 202,
      body: JSON.stringify({ staged: true, url: 'https://host/' }),
    })
    const result = await publish(ctx, {
      app: 'test.example.app',
      platform: 'macos',
      path: 'app.dmg',
      version: '1.0',
      changelog: 'Fixes',
    })
    assert.deepEqual(result, {
      buildId: 0,
      url: 'https://host/',
      installUrl: 'https://host/',
      visible: false,
      variant: '',
    })
    assert.equal(waited, 2)
    const sent = master.sent.at(-1)!
    assert.equal(sent.params.buildNumber, '7')
    assert.equal(sent.params.changelog, 'Fixes')
    // The stage's token stays on the node: the master grants the file.
    assert.equal(sent.params.uploadToken, undefined)
    assert.deepEqual(
      ctx.journalled.map(([kind]) => kind),
      ['publication'],
    )
    assert.match(
      ctx.logs.join(''),
      /The master is unreachable; waiting to send artifacts\.publish/,
    )
    // An absolute path inside the checkout, as ctx.apple.archive gives, is the same file.
    master.replies.push({
      status: 202,
      body: JSON.stringify({ staged: true, url: 'https://host/' }),
    })
    await publish(ctx, {
      app: 'test.example.app',
      platform: 'macos',
      path: path.join(ctx.dir, 'app.dmg'),
      version: '1.0',
    })
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'macos',
        path: path.join(path.dirname(ctx.dir), 'elsewhere.dmg'),
        version: '1.0',
      }),
      /outside the checkout/,
    )
    assert.equal(checkoutPath(ctx.dir, 'a/b'), 'a/b')
    // An export named after its product, with a space.
    writeFileSync(path.join(ctx.dir, 'TS App.dmg'), desktop('dmg'))
    master.replies.push({
      status: 202,
      body: JSON.stringify({ staged: true, url: 'https://host/' }),
    })
    await publish(ctx, {
      app: 'test.example.app',
      platform: 'macos',
      path: path.join(ctx.dir, 'TS App.dmg'),
      version: '1.0',
    })
    assert.equal(checkoutFile('build/TS App.ipa'), 'build/TS App.ipa')
    assert.throws(() => checkoutFile('.git/config'), /Unsafe relative path/)
    assert.throws(() => checkoutFile('a/.GIT/x'), /Unsafe relative path/)
    assert.throws(() => checkoutFile('a\0b'), /Invalid text/)
    assert.throws(() => checkoutPath(ctx.dir, ctx.dir), /outside the checkout/)
    // A refusal names the host's reason, even when it is not JSON.
    master.replies.push({ status: 400, body: 'not json' })
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'macos',
        path: 'app.dmg',
        version: '1.0',
      }),
      /refused app\.dmg: not json/,
    )
  })

  it('U12.1 refuses a publication the stage cannot make, and one the master refuses', async () => {
    const ctx = context()
    writeFileSync(path.join(ctx.dir, 'app.dmg'), desktop('dmg'))
    await assert.rejects(
      publish(context({}, null), {
        app: 'x',
        platform: 'macos',
        path: 'app.dmg',
      }),
      /cannot publish/,
    )
    await assert.rejects(
      publish(ctx, {
        app: 'other.app',
        platform: 'macos',
        path: 'app.dmg',
        version: '1',
      }),
      /no macos publication of other\.app/,
    )
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'macos',
        path: 'app.dmg',
      }),
      /needs its version/,
    )
    master.replies.push({
      status: 400,
      body: JSON.stringify({ error: 'Already published' }),
    })
    await assert.rejects(
      publish(ctx, {
        app: 'test.example.app',
        platform: 'macos',
        path: 'app.dmg',
        version: '1',
      }),
      /refused app\.dmg: Already published/,
    )
    // Anything but the link going away fails the call at once.
    const broken = context({
      stream: () => {
        throw new Error('boom')
      },
    })
    writeFileSync(path.join(broken.dir, 'app.dmg'), desktop('dmg'))
    await assert.rejects(
      publish(broken, {
        app: 'test.example.app',
        platform: 'macos',
        path: 'app.dmg',
        version: '1',
      }),
      /boom/,
    )
  })

  it('U12.8 saves artifacts through the master, waiting while it is away, and reports refusals', async () => {
    const ctx = context()
    mkdirSync(path.join(ctx.dir, 'out'))
    writeFileSync(path.join(ctx.dir, 'out', 'a.txt'), 'a')
    await assert.rejects(
      save(ctx, 'none', 'missing/**', {}),
      /matched no files/,
    )
    await assert.rejects(
      save(context({}, null), 'x', 'out/**', {}),
      /cannot save/,
    )
    master.replies.push({
      status: 403,
      body: JSON.stringify({ error: 'The token is for another run' }),
    })
    await assert.rejects(
      save(ctx, 'out', 'out/**', { kind: 'data' }),
      /another run/,
    )
    // The link drops mid-stream once, then the master answers.
    let dropped = false
    const offline = context({
      stream: (method, params) => {
        const stream = master.worker.openStream(method, params)
        if (!dropped) {
          dropped = true
          stream.abort('Link closed')
        }
        return stream
      },
    })
    mkdirSync(path.join(offline.dir, 'out'))
    writeFileSync(path.join(offline.dir, 'out', 'a.txt'), 'a')
    // The master has no host for a moment, then relays the archive.
    master.replies.push(
      { status: 503, body: JSON.stringify({ error: 'No host is connected' }) },
      { status: 201, body: '{}' },
    )
    await save(offline, 'out', 'out/**', {
      kind: 'report',
      entry: 'a.txt',
      visibleTo: 'testers',
    })
    const sent = master.sent.at(-1)!
    assert.equal(sent.method, 'artifacts.save')
    assert.deepEqual(
      [sent.params.name, sent.params.kind, sent.params.entry],
      ['out', 'report', 'a.txt'],
    )
    assert.equal(sent.params.visibleTo, 'testers')
    assert.equal(sent.params.uploadToken, 'stage-token')
    assert(sent.bytes > 0)
    assert.match(offline.logs.join(''), /Saved artifact out \(1 files\)/)
    assert.match(
      offline.logs.join(''),
      /The host is unreachable \(No host is connected\); waiting to send artifacts\.save/,
    )
  })

  it('U12.14/U12.9 waits for the master before fetching, unpacks what it relays, reports a refusal, and journals test results while it is away', async () => {
    let calls = 0
    let waited = 0
    const packed = root()
    mkdirSync(path.join(packed, 'report'))
    writeFileSync(path.join(packed, 'report', 'index.html'), '<p>ok</p>')
    const archive = path.join(packed, 'report.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', packed, 'report'])
    const bytes = readFileSync(archive)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const ctx = context({
      request: async <T>(): Promise<T> => {
        calls++
        if (calls === 1)
          throw new LinkError('The master is not connected', 'closed')
        return {
          grant: 'g',
          url: 'https://host.example/api/artifacts/download?grant=g',
          digest,
          size: bytes.length,
          name: 'results',
        } as T
      },
      connected: async () => {
        waited++
      },
    })
    master.replies.push({ status: 200, body: bytes })
    const files = await fetchArtifacts(
      ctx,
      { workflow: 'build', name: 'results' },
      'got',
    )
    assert.deepEqual(files, [path.join(ctx.dir, 'got', 'report', 'index.html')])
    assert.equal(waited, 1)
    assert.deepEqual(master.sent.at(-1)!.params.grant, 'g')
    master.replies.push({ status: 404, body: 'gone' })
    await assert.rejects(
      fetchArtifacts(ctx, { workflow: 'build', name: 'results' }, 'got'),
      /refused artifact results: gone/,
    )
    master.replies.push({ status: 200, body: 'other bytes' })
    await assert.rejects(
      fetchArtifacts(ctx, { workflow: 'build', name: 'results' }, 'got'),
      /does not match its digest/,
    )
    const refusing = context({
      request: async () => {
        throw new LinkError('No run matches', 'failed')
      },
    })
    await assert.rejects(
      fetchArtifacts(refusing, { workflow: 'build', name: 'x' }, 'got'),
      /No run matches/,
    )
    const offline = context()
    writeFileSync(
      path.join(offline.dir, 'results.tap'),
      '1..2\nok 1 a\nnot ok 2 b\n',
    )
    const summary = await tests(offline, 'tap', 'results.tap')
    assert.equal(summary.failed, 1)
    assert.deepEqual(
      offline.journalled.map(([kind]) => kind),
      ['tests'],
    )
    await assert.rejects(
      tests(offline, 'junit', 'none.xml'),
      /No junit results match/,
    )
    const broken = context({
      request: async () => {
        throw new Error('boom')
      },
    })
    writeFileSync(path.join(broken.dir, 'results.tap'), '1..1\nok 1 a\n')
    await assert.rejects(tests(broken, 'tap', 'results.tap'), /boom/)
  })
})
