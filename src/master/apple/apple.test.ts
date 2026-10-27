import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import type { MainIO } from '../../node/main.js'
import { nodeMain } from '../../node/main.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeApple } from '../../test/fakeApple.js'
import {
  CookieJar,
  derivePassword,
  fromBytes,
  hashcash,
  modPow,
  sha256,
  srpClient,
  srpG,
  srpK,
  srpM1,
  srpN,
  srpU,
  srpX,
  toBytes,
  xcodeVersionOf,
} from './developerDownloads.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'apple-'))

const appleId = 'builds@example.com'
const password = 'Apple-Password-9'

function io(
  extra: Partial<MainIO> = {},
): MainIO & { lines: string[]; errors: string[]; prompts: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  const prompts: string[] = []
  return {
    lines,
    errors,
    prompts,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    system: (): never => {
      throw new Error('unused')
    },
    stopped: async () => undefined,
    program: () => [],
    ...extra,
  }
}

describe('Apple ID downloads', () => {
  it('U9.6 SRP with s2k agrees with a verifier, hashcash meets its bits, and the jar scopes cookies', () => {
    const salt = Buffer.from('0123456789abcdef')
    const p = derivePassword(password, 's2k', salt, 1000)
    assert.notDeepEqual(p, derivePassword(password, 's2k_fo', salt, 1000))
    const v = modPow(srpG, srpX(salt, p), srpN)
    const client = srpClient()
    const b = 12345678901234567890n
    const B = (srpK * v + modPow(srpG, b, srpN)) % srpN
    const { M1 } = client.proof(appleId, salt, p, B)
    const S = modPow(
      (client.A * modPow(v, srpU(client.A, B), srpN)) % srpN,
      b,
      srpN,
    )
    assert.deepEqual(M1, srpM1(appleId, salt, client.A, B, sha256(toBytes(S))))
    const wrong = srpClient().proof(
      appleId,
      salt,
      derivePassword('nope', 's2k', salt, 1000),
      B,
    )
    assert.notDeepEqual(wrong.M1, M1)
    assert.throws(() => client.proof(appleId, salt, p, 0n), /invalid SRP/)
    assert.equal(fromBytes(Buffer.alloc(0)), 0n)

    const stamp = hashcash(11, 'abc', new Date('2026-10-20T10:11:12Z'))
    assert.match(stamp, /^1:11:20261020101112:abc::\d+$/)
    const digest = createHash('sha1').update(stamp).digest()
    assert.equal(digest[0], 0)
    assert.equal(digest[1]! >> 5, 0)

    const jar = new CookieJar()
    const headers = new Headers()
    headers.append('Set-Cookie', 'a=1; Domain=.apple.com; Path=/')
    headers.append('Set-Cookie', 'b=2; Path=/devcenter')
    headers.append('Set-Cookie', 'gone=3; Max-Age=0')
    headers.append('Set-Cookie', 'evil=4; Domain=example.com')
    jar.store(new URL('https://idmsa.apple.com/x'), headers, 1000)
    assert.equal(
      jar.header(new URL('https://developer.apple.com/'), 1000),
      'a=1',
    )
    assert.equal(
      jar.header(new URL('https://idmsa.apple.com/devcenter/y'), 1000),
      'a=1; b=2',
    )
    assert.equal(jar.get('gone'), undefined)
    assert.equal(jar.get('evil'), undefined)

    assert.equal(xcodeVersionOf('Xcode 26.1'), '26.1')
    assert.equal(xcodeVersionOf('Xcode 26.2 beta 3'), '26.2-beta3')
    assert.equal(xcodeVersionOf('Xcode 26.1 Release Candidate'), '26.1-rc')
    assert.equal(xcodeVersionOf('Command Line Tools for Xcode 26.1'), undefined)
  })

  describe('on a master', () => {
    let c: Cluster
    let apple: FakeApple
    before(async () => {
      apple = new FakeApple(appleId, password)
      await apple.start()
      c = await cluster(root(), {
        workers: [],
        masterOptions: { appleEndpoints: apple.endpoints },
      })
    })
    after(async () => {
      await c?.close()
      await apple?.close()
    })

    it('U9.6 signs in with two-factor, stores the session encrypted, and hands out only one file’s authorization', async () => {
      const master = c.master.master!
      assert.deepEqual(master.apple.status(), { state: 'signedOut' })
      await assert.rejects(
        master.apple.signIn('not-an-email', password),
        /email/,
      )
      let status = await master.appleSignIn(
        { role: 'admin', label: 'paul' },
        appleId,
        'wrong password',
      )
      assert.equal(status.state, 'failed')
      assert.match(String(status.notice), /refused the sign-in/)
      // The widget key comes from the sign-out redirect, asked without cookies.
      assert.deepEqual(apple.signoutCookies, [''])
      // Without it, the older configuration endpoint; without either, a reason.
      apple.widgetKeyFrom = 'config'
      status = await master.appleSignIn(
        { role: 'admin', label: 'paul' },
        appleId,
        'wrong password',
      )
      assert.match(String(status.notice), /refused the sign-in/)
      apple.widgetKeyFrom = 'empty'
      await assert.rejects(
        master.appleSignIn({ role: 'admin', label: 'paul' }, appleId, password),
        /has no widget key/,
      )
      apple.widgetKeyFrom = 'gone'
      await assert.rejects(
        master.appleSignIn({ role: 'admin', label: 'paul' }, appleId, password),
        /sign-in configuration failed \(404\)/,
      )
      apple.widgetKeyFrom = 'signout'

      status = await master.appleSignIn(
        { role: 'admin', label: 'paul' },
        appleId,
        password,
      )
      assert.equal(status.state, 'needsCode')
      assert.equal(status.codeVia, 'a trusted device')
      assert.match(String(status.notice), /two-factor code/)
      // Backups are not configured in this test; only the Apple notice matters here.
      const notices = (): string[] =>
        master.notices().filter((line) => !/backed up/.test(line))
      assert.deepEqual(notices(), [status.notice])
      await assert.rejects(master.apple.submitCode('12'), /six digits/)
      await assert.rejects(
        master.apple.submitCode('000000'),
        /did not accept the code/,
      )
      assert.equal(master.apple.status().state, 'needsCode')
      status = await master.appleCode(
        { role: 'admin', label: 'paul' },
        apple.code,
      )
      assert.equal(status.state, 'signedIn')
      assert.deepEqual(notices(), [])
      await assert.rejects(
        master.apple.submitCode(apple.code),
        /No sign-in is waiting/,
      )

      assert.deepEqual(
        (await master.apple.xcodes()).map((entry) => [
          entry.version,
          entry.beta,
        ]),
        [
          ['26.1', false],
          ['26.2-beta3', true],
        ],
      )
      const auth = await master.apple.authorize('26.1')
      assert.match(auth.cookie, /^ADCDownloadAuth=[0-9a-f]+$/)
      assert.equal(
        auth.url,
        `${apple.endpoints.download}/Developer_Tools/Xcode_26.1/Xcode_26.1.xip`,
      )
      // The node downloads with that cookie alone.
      const xip = await fetch(auth.url, { headers: { Cookie: auth.cookie } })
      assert.equal(xip.status, 200)
      assert.equal(await xip.text(), 'xcode:26.1:17B55')
      assert.deepEqual(apple.downloadCookies, [auth.cookie])
      await assert.rejects(
        master.apple.authorize('99.0'),
        /offers no Xcode 99\.0/,
      )

      // Nothing of the password or the session is readable outside the sealed record.
      const db = master.database.db
      const dump = JSON.stringify(
        ['settings', 'change_log', 'audit', 'meta', 'job_stages'].flatMap(
          (table) => db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      )
      assert(!dump.includes(password))
      assert(!dump.includes('myacinfo'))
      assert(!dump.includes(auth.cookie.split('=')[1]!))
      assert.deepEqual(master.settings.value('apple'), { appleId })
      const key = readFileSync(path.join(c.master.dir, 'apple.key'), 'utf8')
      assert.equal(Buffer.from(key.trim(), 'base64').length, 32)
    })

    it('U9.6 raises a renewal notice when the session lapses, in the API and mason status, and clears it with a code', async () => {
      const master = c.master.master!
      apple.expire()
      const status = await master.apple.check()
      assert.equal(status.state, 'needsCode')
      assert.match(
        String(status.notice),
        /two-factor code for builds@example\.com/,
      )
      await assert.rejects(master.apple.authorize('26.1'), /two-factor code/)

      const cli = io()
      assert.equal(await nodeMain(['status', '--data', c.master.dir], cli), 0)
      assert(
        cli.lines.includes(`Notice: ${String(status.notice)}`),
        cli.lines.join('\n'),
      )
      const shown = await c.api('GET', '/api/v2/apple/session')
      assert.equal(shown.status, 200)
      assert.equal(shown.json.state, 'needsCode')
      assert.equal(shown.json.notice, status.notice)
      assert.equal(JSON.stringify(shown.json).includes(password), false)

      const answered = await c.api('POST', '/api/v2/apple/session/code', {
        code: apple.code,
      })
      assert.equal(answered.status, 200, answered.text)
      assert.equal(answered.json.state, 'signedIn')
    })

    it('U9.6 mason apple sign-in reads the password and the two-factor code, and the API is for managers and admins', async () => {
      const master = c.master.master!
      await master.apple.signOut()
      apple.expire()
      const answers = ['000000', apple.code]
      const cli = io({
        stdin: async () => `${password}\n`,
        prompt: async (question) => {
          cli.prompts.push(question)
          return answers.shift()!
        },
      })
      assert.equal(
        await nodeMain(
          [
            'apple',
            'sign-in',
            '--data',
            c.master.dir,
            '--apple-id',
            appleId,
            '--password-stdin',
          ],
          cli,
        ),
        0,
        cli.errors.join('\n'),
      )
      assert.deepEqual(cli.prompts, [
        'Two-factor code (sent to a trusted device): ',
        'Two-factor code (sent to a trusted device): ',
      ])
      assert.match(cli.errors.join('\n'), /did not accept the code/)
      assert(cli.lines.includes('State: signedIn'), cli.lines.join('\n'))
      const shown = io()
      assert.equal(
        await nodeMain(
          ['apple', 'status', '--data', c.master.dir, '--json'],
          shown,
        ),
        0,
      )
      assert.equal(JSON.parse(shown.lines[0]!).state, 'signedIn')

      const developer = master.keys.create(
        { role: 'admin', label: 'paul' },
        { role: 'developer' },
      ).token
      const manager = master.keys.create(
        { role: 'admin', label: 'paul' },
        { role: 'manager' },
      ).token
      for (const [method, route, body] of [
        ['GET', '/api/v2/apple/session', undefined],
        ['POST', '/api/v2/apple/session', { appleId, password }],
        ['POST', '/api/v2/apple/session/code', { code: apple.code }],
      ] as const)
        assert.equal(
          (await c.api(method, route, body, developer)).status,
          403,
          route,
        )
      const asManager = await c.api(
        'GET',
        '/api/v2/apple/session',
        undefined,
        manager,
      )
      assert.equal(asManager.status, 200)
      assert.equal((asManager.json as Json).state, 'signedIn')
      apple.expire()
      const again = await c.api(
        'POST',
        '/api/v2/apple/session',
        { password },
        manager,
      )
      assert.equal(again.status, 200, again.text)
      assert.equal(again.json.state, 'needsCode')
      assert.equal(
        (
          await c.api(
            'POST',
            '/api/v2/apple/session/code',
            { code: apple.code },
            manager,
          )
        ).json.state,
        'signedIn',
      )

      const out = io()
      assert.equal(
        await nodeMain(['apple', 'sign-out', '--data', c.master.dir], out),
        0,
      )
      assert.equal(master.apple.status().state, 'signedOut')
      assert.equal(
        master.database.db
          .prepare("SELECT 1 FROM meta WHERE key='apple_session'")
          .get(),
        undefined,
      )
    })
  })
})
