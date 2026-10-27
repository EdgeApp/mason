import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { LinkError } from '../link/link.js'
import type { StageAssignment } from '../pipeline/assignment.js'
import { desktop } from '../upload/fixtures.test.js'
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

/** A host that answers each upload with the next scripted reply. */
class Host {
  server!: Server
  origin = ''
  readonly replies: Array<{ status: number; body: string }> = []
  readonly headers: Array<Record<string, string | string[] | undefined>> = []
  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      this.headers.push(req.headers)
      req.resume()
      req.on('end', () => {
        const reply = this.replies.shift() ?? {
          status: 500,
          body: 'no reply scripted',
        }
        res.writeHead(reply.status)
        res.end(reply.body)
      })
    })
    await new Promise<void>((resolve) =>
      this.server.listen(port, '127.0.0.1', resolve),
    )
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
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
  const host = new Host()
  before(async () => {
    await host.start()
  })
  after(() => {
    host.server.close()
  })

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
                origin: host.origin,
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

  it('U12.7 publishes by the stage token while the master is away and journals the staged publication once', async () => {
    const ctx = context()
    writeFileSync(path.join(ctx.dir, 'app.dmg'), desktop('dmg'))
    host.replies.push({
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
    })
    const sent = host.headers.at(-1)!
    assert.equal(sent['x-mason-token'], 'stage-token')
    assert.equal(sent['x-mason-build-number'], '7')
    assert.equal(sent['x-mason-changelog'], 'Fixes')
    assert.deepEqual(
      ctx.journalled.map(([kind]) => kind),
      ['publication'],
    )
    assert.match(ctx.logs.join(''), /uploading app\.dmg with the stage’s token/)
    // An absolute path inside the checkout, as ctx.apple.archive gives, is the same file.
    host.replies.push({
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
    host.replies.push({
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
    host.replies.push({ status: 400, body: 'not json' })
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

  it('U12.1 refuses a publication the stage cannot make', async () => {
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
    const failing = context({
      request: async () => {
        throw new LinkError('Refused', 'failed')
      },
    })
    writeFileSync(path.join(failing.dir, 'app.dmg'), desktop('dmg'))
    await assert.rejects(
      publish(failing, {
        app: 'test.example.app',
        platform: 'macos',
        path: 'app.dmg',
        version: '1',
      }),
      /Refused/,
    )
  })

  it('U12.8 saves artifacts, retrying while the host is unreachable, and reports refusals', async () => {
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
    host.replies.push({
      status: 403,
      body: JSON.stringify({ error: 'The token is for another run' }),
    })
    await assert.rejects(
      save(ctx, 'out', 'out/**', { kind: 'data' }),
      /another run/,
    )
    // A host that is down at first, then answers.
    const late = new Host()
    await late.start()
    const port = Number(new URL(late.origin).port)
    late.server.close()
    const offline = context(
      {},
      { token: 't', origin: `http://127.0.0.1:${port}`, reservations: [] },
    )
    mkdirSync(path.join(offline.dir, 'out'))
    writeFileSync(path.join(offline.dir, 'out', 'a.txt'), 'a')
    setTimeout(() => {
      void late
        .start(port)
        .then(() => late.replies.push({ status: 201, body: '{}' }))
    }, 500)
    await save(offline, 'out', 'out/**', {
      kind: 'report',
      entry: 'a.txt',
      visibleTo: 'testers',
    })
    assert.equal(late.headers[0]!['x-mason-visible-to'], 'testers')
    assert.equal(late.headers[0]!['x-mason-entry'], 'a.txt')
    late.server.close()
  })

  it('U12.14/U12.9 waits for the master before fetching, reports a host refusal, and journals test results while it is away', async () => {
    let calls = 0
    let waited = 0
    const ctx = context({
      request: async <T>(): Promise<T> => {
        calls++
        if (calls === 1)
          throw new LinkError('The master is not connected', 'closed')
        return {
          grant: 'g',
          url: `${host.origin}/api/artifacts/download?grant=g`,
          digest: 'd',
          size: 1,
          name: 'results',
        } as T
      },
      connected: async () => {
        waited++
      },
    })
    host.replies.push({ status: 404, body: 'gone' })
    await assert.rejects(
      fetchArtifacts(ctx, { workflow: 'build', name: 'results' }, 'got'),
      /refused artifact results: HTTP 404/,
    )
    assert.equal(waited, 1)
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
