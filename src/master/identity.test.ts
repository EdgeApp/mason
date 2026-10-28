import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { loadIdentity } from '../node/identity.js'
import { nodeMain, type MainIO } from '../node/main.js'
import { pinnedAgent } from '../node/pinnedFetch.js'
import { startNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { applyPendingRestore, PENDING_RESTORE } from './backup.js'
import {
  IdentityMismatch,
  recordIdentity,
  restoreIdentity,
} from './identity.js'
import { localOperator } from './roles.js'
import { migrateMaster } from './schema.js'

const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))
const io = (): MainIO & { lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    system: (): never => {
      throw new Error('unused')
    },
    stopped: async () => undefined,
    program: () => [],
  }
}
const storedIdentity = (file: string): string | undefined => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (
      db.prepare("SELECT value FROM meta WHERE key='master_identity'").get() as
        | { value: string }
        | undefined
    )?.value
  } finally {
    db.close()
  }
}

describe("The master's identity travels with its database", function () {
  this.timeout(180_000)
  let c: Cluster
  let bare: string
  let original: string

  before(async () => {
    const dir = root('identity-')
    bare = path.join(dir, 'backup.git')
    execFileSync('git', ['init', '-q', '--bare', bare])
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [{ name: 'w', type: 'worker' }],
    })
    original = c.master.identity.fingerprint
    await c.master.master!.settings.set(localOperator, 'backup', {
      repository: bare,
      branch: 'identity',
    })
  })
  after(async () => {
    await c?.close()
  })

  it('U2.1 a new master stores its identity once; a restart keeps the stored one', async () => {
    const file = path.join(c.master.dir, 'master.sqlite')
    const first = storedIdentity(file)
    assert(first != null)
    const parsed = JSON.parse(first) as Record<string, string>
    assert.equal(parsed.fingerprint, original)
    assert.match(parsed.privateKey!, /BEGIN PRIVATE KEY/)
    assert.equal(parsed.cert, c.master.identity.cert)
    await c.restartMaster()
    assert.equal(storedIdentity(file), first)
  })

  it('U2.2 a backup restored with setup --restore starts as the same master, and its worker reconnects without pairing', async () => {
    const master = c.master.master!
    assert.equal((await master.backups.backup()).backedUp, true)
    const keyFile = path.join(c.root, 'backup.key')
    writeFileSync(keyFile, master.backups.keyText() + '\n', { mode: 0o600 })
    // The original stops first, as the restore tells an administrator to.
    await c.master.close()
    const data = path.join(c.root, 'restored')
    const restore = io()
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--restore',
          '--repository',
          bare,
          '--branch',
          'identity',
          '--key-file',
          keyFile,
          '--data',
          data,
        ],
        restore,
      ),
      0,
      restore.lines.join('\n'),
    )
    assert.match(
      restore.lines.join('\n'),
      new RegExp(
        `This master is ${original} again, so its nodes reconnect without pairing\\. Stop the master the backup came from`,
      ),
    )
    assert.equal(loadIdentity(data).fingerprint, original)
    const restored = await startNode(
      { role: 'master', data, port: 0, listen: '127.0.0.1', heartbeatMs: 0 },
      () => undefined,
    )
    try {
      assert.equal(restored.identity.fingerprint, original)
      const worker = c.fingerprint('w')
      await c.until(
        () => restored.master!.registry.link(worker),
        30_000,
        'the worker on the restored master',
      )
      assert.equal(
        restored
          .master!.registry.list()
          .find((node) => node.fingerprint === worker)?.connected,
        true,
      )
    } finally {
      await restored.close()
    }
  })

  it('U2.3 a database holding another master’s identity is refused with both fingerprints', async () => {
    const dir = root('mismatch-')
    const one = path.join(dir, 'one')
    const two = path.join(dir, 'two')
    mkdirSync(one, { mode: 0o700 })
    mkdirSync(two, { mode: 0o700 })
    const first = await startNode(
      {
        role: 'master',
        data: one,
        port: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
      },
      () => undefined,
    )
    const fingerprint = first.identity.fingerprint
    await first.close()
    // A database copied by hand next to another master's identity.
    const other = loadIdentity(two)
    copyFileSync(
      path.join(one, 'master.sqlite'),
      path.join(two, 'master.sqlite'),
    )
    await assert.rejects(
      startNode(
        {
          role: 'master',
          data: two,
          port: 0,
          listen: '127.0.0.1',
          heartbeatMs: 0,
        },
        () => undefined,
      ),
      (error: Error) =>
        error instanceof IdentityMismatch &&
        error.message.includes(fingerprint) &&
        error.message.includes(other.fingerprint),
    )
    // A new key on purpose replaces the stored identity.
    const renewed = await startNode(
      {
        role: 'master',
        data: two,
        port: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
        newKey: true,
      },
      () => undefined,
    )
    const replaced = renewed.identity.fingerprint
    await renewed.close()
    assert.notEqual(replaced, fingerprint)
    assert.equal(
      (
        JSON.parse(storedIdentity(path.join(two, 'master.sqlite'))!) as {
          fingerprint: string
        }
      ).fingerprint,
      replaced,
    )
    // Recording the same identity again changes nothing.
    const db = new DatabaseSync(path.join(two, 'master.sqlite'))
    recordIdentity(db, loadIdentity(two))
    db.close()
  })

  it('U2.4 the first-run Restore brings the identity back and warns to stop the old master', async () => {
    const data = path.join(c.root, 'web-restored')
    let restarted = 0
    const options = {
      role: 'master' as const,
      data,
      port: 0,
      listen: '127.0.0.1',
      heartbeatMs: 0,
      onRestore: (): void => {
        restarted++
      },
    }
    const node = await startNode(options, () => undefined)
    const fresh = node.identity.fingerprint
    assert.notEqual(fresh, original)
    const origin = node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
    try {
      const page = await fetch(origin + '/', {
        // @ts-expect-error undici's dispatcher option
        dispatcher: pinnedAgent(node.web!.certificate!.pin),
      })
      assert.match(
        await page.text(),
        /It comes back as the same master, so its nodes reconnect: stop the master the backup came from first\./,
      )
      const code = readFileSync(path.join(data, 'setup-code'), 'utf8').trim()
      const keyFile = path.join(c.root, 'backup.key')
      const done = await fetch(origin + '/api/setup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          repository: bare,
          branch: 'identity',
          key: readFileSync(keyFile, 'utf8').trim(),
        }),
        // @ts-expect-error undici's dispatcher option
        dispatcher: pinnedAgent(node.web!.certificate!.pin),
      })
      assert.equal(done.status, 202, await done.clone().text())
      assert.equal(restarted, 1)
    } finally {
      await node.close()
    }
    const lines: string[] = []
    const next = await startNode(options, (line) => lines.push(line))
    try {
      assert.equal(next.identity.fingerprint, original)
      assert(
        lines.some(
          (line) =>
            line === `Started from the restored backup as master ${original}`,
        ),
      )
    } finally {
      await next.close()
    }
  })

  it('restores nothing from a database without an identity, and refuses a tampered one', () => {
    const dir = root('legacy-')
    assert.equal(restoreIdentity(dir), undefined)
    const db = new DatabaseSync(path.join(dir, 'master.sqlite'))
    migrateMaster(db)
    db.close()
    assert.equal(restoreIdentity(dir), undefined)
    // A database from before identities were kept: nodes pair again.
    writeFileSync(
      path.join(dir, PENDING_RESTORE),
      readFileSync(path.join(dir, 'master.sqlite')),
    )
    const lines: string[] = []
    assert.equal(
      applyPendingRestore(dir, (line) => lines.push(line)),
      true,
    )
    assert.deepEqual(lines, [
      'Started from the restored backup; it holds no master identity, so nodes pair again',
    ])
    const tampered = new DatabaseSync(path.join(dir, 'master.sqlite'))
    tampered
      .prepare("INSERT INTO meta(key,value) VALUES('master_identity',?)")
      .run(
        JSON.stringify({
          fingerprint: 'mldsa65:not-this-key',
          publicKey: loadIdentity(root('other-')).publicKey.export({
            type: 'spki',
            format: 'pem',
          }),
        }),
      )
    tampered.close()
    assert.throws(() => restoreIdentity(dir), /does not match its fingerprint/)
    // A file that is not a master database holds no identity.
    const empty = root('empty-')
    new DatabaseSync(path.join(empty, 'master.sqlite')).close()
    assert.equal(restoreIdentity(empty), undefined)
  })
})
