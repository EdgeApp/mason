import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import {
  certificateHash,
  createCertificate,
  publicKeyPin,
} from './certificate.js'
import {
  controlRequest,
  controlSocketPath,
  NotRunning,
  serveControl,
} from './control.js'
import {
  LockHeld,
  lockDataDir,
  lockHolder,
  prepareDataDir,
  readPrivate,
  resolveDataDir,
  writePrivate,
} from './dataDir.js'
import {
  checkPairingSecret,
  clearSetupCode,
  fingerprint,
  loadIdentity,
  newSetupCode,
  pairingKey,
  parsePairingKey,
  spendPairingKey,
} from './identity.js'

let root: string
const cli = new URL('../cli.js', import.meta.url).pathname

describe('Node identity and data directory', function () {
  this.timeout(20000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'identity-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a well-formed self-signed P-256 certificate', () => {
    const now = new Date('2049-06-01T00:00:00Z')
    const { cert, key } = createCertificate(
      ['localhost', '127.0.0.1', '::1', 'fe80::1:2', '2001:db8::8'],
      now,
    )
    const x509 = new X509Certificate(cert)
    assert.equal(x509.subject, 'CN=mason-node')
    assert(x509.verify(x509.publicKey))
    assert.equal(x509.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1')
    assert.equal(new Date(x509.validFrom).getUTCFullYear(), 2049)
    // A validity end past 2049 is encoded as GeneralizedTime.
    assert.equal(new Date(x509.validTo).getUTCFullYear(), 2069)
    assert.match(x509.subjectAltName ?? '', /DNS:localhost/)
    assert.match(x509.subjectAltName ?? '', /IP Address:2001:DB8:0:0:0:0:0:8/)
    assert.match(x509.subjectAltName ?? '', /IP Address:0:0:0:0:0:0:0:1/)
    assert.match(key, /BEGIN PRIVATE KEY/)
    assert.equal(
      certificateHash(cert),
      createHash('sha256').update(x509.raw).digest('base64url'),
    )
    assert.equal(certificateHash(x509.raw), certificateHash(cert))
    assert.equal(publicKeyPin(x509.publicKey), publicKeyPin(cert))
    assert.match(publicKeyPin(cert), /^sha256\/\/[A-Za-z0-9+/]{43}=$/)
    const bare = new X509Certificate(createCertificate([]).cert)
    assert.equal(bare.subjectAltName, undefined)
    // Every body length parses, including one that fills its last PEM line exactly.
    const lengths = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const made = createCertificate([`mason-linux-cloud-${i}`])
      const body = made.cert.split('\n').slice(1, -2)
      assert(!body.includes(''), 'a blank line in the PEM body')
      lengths.add(body.join('').length % 64)
      assert.equal(
        new X509Certificate(made.cert).subjectAltName,
        `DNS:mason-linux-cloud-${i}`,
      )
    }
    assert(lengths.has(0), 'a body filling its last line was tried')
  })

  it('creates an owner-only data directory and identity once, and reuses it', () => {
    const dir = prepareDataDir(path.join(root, 'data'))
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    const first = loadIdentity(dir)
    for (const name of ['identity.key', 'identity.pub', 'tls.crt', 'tls.key'])
      assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600)
    assert.match(first.fingerprint, /^mldsa65:[A-Za-z0-9_-]{43}$/)
    assert.equal(first.privateKey.asymmetricKeyType, 'ml-dsa-65')
    const again = loadIdentity(dir)
    assert.equal(again.fingerprint, first.fingerprint)
    assert.equal(again.certificateHash, first.certificateHash)
    const renewed = loadIdentity(dir, { renew: true })
    assert.notEqual(renewed.fingerprint, first.fingerprint)
    assert.notEqual(renewed.certificateHash, first.certificateHash)
    assert.equal(
      fingerprint(createPublicKey(renewed.privateKey)),
      renewed.fingerprint,
    )
  })

  it('refuses insecure data directories and mismatched identity files', () => {
    const open = path.join(root, 'open')
    mkdirSync(open, { mode: 0o700 })
    chmodSync(open, 0o770)
    assert.throws(() => prepareDataDir(open), /private ownership/)
    chmodSync(open, 0o707)
    assert.throws(() => prepareDataDir(open), /private ownership/)
    const real = path.join(root, 'real')
    mkdirSync(real, { mode: 0o700 })
    symlinkSync(real, path.join(root, 'link'))
    assert.throws(() => prepareDataDir(path.join(root, 'link')), /Symlink/)
    assert.throws(
      () => prepareDataDir(path.join(root, 'link', 'below')),
      /Symlink/,
    )

    const dir = prepareDataDir(path.join(root, 'data'))
    loadIdentity(dir)
    const other = prepareDataDir(path.join(root, 'other'))
    loadIdentity(other)
    writeFileSync(
      path.join(dir, 'identity.pub'),
      readFileSync(path.join(other, 'identity.pub')),
    )
    assert.throws(() => loadIdentity(dir), /do not match/)
    loadIdentity(dir, { renew: true })
    writeFileSync(
      path.join(dir, 'tls.key'),
      readFileSync(path.join(other, 'tls.key')),
    )
    assert.throws(() => loadIdentity(dir), /certificate does not match/)
    chmodSync(path.join(dir, 'tls.key'), 0o644)
    assert.throws(() => loadIdentity(dir), /owner-only/)
  })

  it('writes private files without following symlinks', () => {
    const file = path.join(root, 'secret')
    writePrivate(file, 'one')
    assert.equal(readPrivate(file), 'one')
    mkdirSync(path.join(root, 'folder'))
    assert.throws(
      () => writePrivate(path.join(root, 'folder'), 'x'),
      /regular file/,
    )
    symlinkSync(file, path.join(root, 'alias'))
    assert.throws(() => writePrivate(path.join(root, 'alias'), 'x'), /Symlink/)
  })

  it('prints the same pairing key until it is spent, storing only a hash', () => {
    const dir = prepareDataDir(path.join(root, 'data'))
    const identity = loadIdentity(dir)
    const key = pairingKey(identity)
    const parsed = parsePairingKey(key)
    assert.equal(parsed.fingerprint, identity.fingerprint)
    assert.equal(parsed.certificateHash, identity.certificateHash)
    assert.equal(
      parsed.certificateHash,
      createHash('sha256')
        .update(new X509Certificate(identity.cert).raw)
        .digest('base64url'),
    )
    assert.equal(pairingKey(loadIdentity(dir)), key)
    for (const name of readdirSync(dir))
      assert(
        !readFileSync(path.join(dir, name))
          .toString('latin1')
          .includes(parsed.secret),
      )
    assert(checkPairingSecret(identity, parsed.secret))
    assert(
      !checkPairingSecret(
        identity,
        parsed.secret.slice(0, -1) + (parsed.secret.endsWith('A') ? 'B' : 'A'),
      ),
    )
    assert(!checkPairingSecret(identity, 'short'))
    spendPairingKey(identity)
    assert(!checkPairingSecret(identity, parsed.secret))
    const next = pairingKey(identity)
    assert.notEqual(next, key)
    const renewed = loadIdentity(dir, { renew: true })
    assert.notEqual(pairingKey(renewed), next)
    for (const bad of [
      'mason2:x',
      key.replace('mason1:', ''),
      key + 'x',
      key.replace('mldsa65:', 'rsa:'),
    ])
      assert.throws(() => parsePairingKey(bad), /Invalid pairing key/)
  })

  it('writes a fresh owner-only six-digit setup code on each start', () => {
    const dir = prepareDataDir(path.join(root, 'data'))
    const codes = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const code = newSetupCode(dir)
      assert.match(code, /^\d{6}$/)
      assert.equal(readPrivate(path.join(dir, 'setup-code')).trim(), code)
      codes.add(code)
    }
    assert(codes.size > 1)
    clearSetupCode(dir)
    assert(!existsSync(path.join(dir, 'setup-code')))
  })

  it('lets one process hold a data directory and names the holder', async () => {
    const dir = prepareDataDir(path.join(root, 'data'))
    const lock = lockDataDir(dir)
    assert.throws(
      () => lockDataDir(dir),
      (error: unknown) => {
        assert(error instanceof LockHeld)
        assert.equal(error.pid, process.pid)
        assert.match(error.message, new RegExp(`PID ${process.pid}`))
        return true
      },
    )
    assert.deepEqual(lockHolder(dir), { held: true, pid: process.pid })
    lock.release()
    lock.release()
    assert.deepEqual(lockHolder(dir), { held: false })

    // Another process: the refusal names its PID.
    const child = spawn(
      process.execPath,
      [
        cli,
        'worker',
        '--data',
        dir,
        '--link-port',
        '0',
        '--listen',
        '127.0.0.1',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let output = ''
    child.stdout.setEncoding('utf8')
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (output.includes('Pairing key:')) resolve()
      })
    })
    assert.throws(() => lockDataDir(dir), new RegExp(`PID ${child.pid}`))
    child.kill('SIGTERM')
    const [code] = (await once(child, 'exit')) as [number]
    assert.equal(code, 0)
    lockDataDir(dir).release()
    // A lock file that records no readable PID still refuses.
    const held = lockDataDir(dir)
    writeFileSync(path.join(dir, 'lock.pid'), 'not a pid', { mode: 0o600 })
    assert.throws(
      () => lockDataDir(dir),
      (error: unknown) => error instanceof LockHeld && error.pid == null,
    )
    held.release()
  })

  it('resolves the default data directory under the home directory', () => {
    assert.equal(
      resolveDataDir(undefined, '/Users/someone'),
      '/Users/someone/.mason',
    )
    assert.equal(
      resolveDataDir('relative/dir', '/x'),
      path.resolve('relative/dir'),
    )
  })

  it('serves operator commands on an owner-only control socket', async () => {
    // A short path keeps the socket inside the data directory.
    const short = mkdtempSync(path.join(realpathSync('/tmp'), 'mason-'))
    try {
      const dir = prepareDataDir(path.join(short, 'd'))
      assert.equal(controlSocketPath(dir), path.join(dir, 'control.sock'))
      await assert.rejects(controlRequest(dir, 'status'), NotRunning)
      const server = await serveControl(dir, {
        echo: (args) => args,
        fail: () => {
          throw new Error('Nope')
        },
        nothing: () => undefined,
      })
      assert.equal(lstatSync(server.path).mode & 0o777, 0o600)
      assert.deepEqual(await controlRequest(dir, 'echo', { a: 1 }), { a: 1 })
      assert.equal(await controlRequest(dir, 'nothing'), null)
      await assert.rejects(controlRequest(dir, 'fail'), /Nope/)
      await assert.rejects(
        controlRequest(dir, 'unknown'),
        /Unknown control command/,
      )
      await assert.rejects(
        controlRequest(dir, '__proto__'),
        /Unknown control command/,
      )
      await server.close()
      await assert.rejects(controlRequest(dir, 'echo'), NotRunning)
      // A stale socket file left by a crash is replaced.
      const stale = await serveControl(dir, {})
      writeFileSync(path.join(short, 'flag'), '')
      const again = await serveControl(dir, { echo: () => 'ok' })
      assert.equal(await controlRequest(dir, 'echo'), 'ok')
      await again.close()
      await stale.close()
      writeFileSync(path.join(dir, 'control.sock'), 'not a socket')
      await assert.rejects(serveControl(dir, {}), /not a socket/)
    } finally {
      rmSync(short, { recursive: true, force: true })
    }
  })

  it('moves the control socket out of long data directory paths', async () => {
    const dir = prepareDataDir(path.join(root, 'a'.repeat(60), 'data'))
    const socketPath = controlSocketPath(dir)
    assert.notEqual(path.dirname(socketPath), dir)
    assert(Buffer.byteLength(socketPath) < 100)
    assert.match(
      path.basename(path.dirname(socketPath)),
      new RegExp(`^mason-control-${process.getuid!()}$`),
    )
    const server = await serveControl(dir, { status: () => 'fine' })
    assert.equal(statSync(path.dirname(socketPath)).mode & 0o777, 0o700)
    assert.equal(await controlRequest(dir, 'status'), 'fine')
    await server.close()
    assert.equal(
      controlSocketPath(path.join(root, 'missing'.repeat(15))).length < 100,
      true,
    )
  })

  it('times out on a node that does not answer and rejects malformed replies', async () => {
    const short = mkdtempSync(path.join(realpathSync('/tmp'), 'mason-'))
    try {
      const dir = prepareDataDir(path.join(short, 'd'))
      const { createServer } = await import('node:net')
      const silent = createServer(() => undefined).listen(
        path.join(dir, 'control.sock'),
      )
      await once(silent, 'listening')
      await assert.rejects(
        controlRequest(dir, 'status', {}, 200),
        /did not answer/,
      )
      silent.close()
      const garbage = createServer((socket) => socket.end('not json\n')).listen(
        path.join(dir, 'control.sock'),
      )
      await once(garbage, 'listening')
      await assert.rejects(
        controlRequest(dir, 'status'),
        /Invalid control reply/,
      )
      garbage.close()
      const huge = await serveControl(dir, {})
      const { createConnection } = await import('node:net')
      const socket = createConnection(huge.path)
      await once(socket, 'connect')
      socket.write('x'.repeat(1024 * 1024 + 10))
      await once(socket, 'close')
      await huge.close()
    } finally {
      rmSync(short, { recursive: true, force: true })
    }
  })
})
