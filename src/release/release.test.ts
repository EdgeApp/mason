import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { perform, type HelperContext } from '../helper/catalog.js'
import {
  helperPaths,
  helperRequest,
  serveHelper,
  systemContext,
} from '../helper/server.js'
import { MasterDatabase } from '../master/database.js'
import { Releases } from '../master/releases.js'
import { Updates } from '../master/updates.js'
import { migrateMaster } from '../master/schema.js'
import { loadIdentity } from '../node/identity.js'
import { nodeMain, type MainIO } from '../node/main.js'
import {
  installHelperService,
  uninstallHelperService,
  type ServiceSystem,
} from '../node/service.js'
import { cluster } from '../test/cluster.js'
import { releasesRepository, repository, repositoryName } from '../version.js'
import { buildRelease, releaseMain, tarballName } from './build.js'
import {
  checkOffer,
  receiveUpdate,
  type UpdateContext,
} from '../worker/update.js'
import { EventEmitter } from 'node:events'
import { createConnection, createServer as createSocketServer } from 'node:net'
import {
  compareSemver,
  releasePlatform,
  runningInstall,
  serviceProgram,
  signRelease,
  verifyRelease,
} from './install.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const repo = fileURLToPath(new URL('../..', import.meta.url))
const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'release-'))
const here = releasePlatform()
/** Runs a command without blocking this process, whose servers it talks to. */
async function run(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number; out: string; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { env })
    let out = ''
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('close', (code) => {
      resolve({ status: code ?? 1, out, stdout })
    })
  })
}

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex')

/** nodejs.org/dist in miniature: runtimes whose `node` is this test's Node. */
function nodeDist(dir: string, version: string): string {
  const dist = path.join(dir, 'dist', `v${version}`)
  mkdirSync(dist, { recursive: true })
  const lines: string[] = []
  for (const platform of [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ]) {
    const top = path.join(dir, 'runtime', `node-v${version}-${platform}`)
    mkdirSync(path.join(top, 'bin'), { recursive: true })
    mkdirSync(path.join(top, 'include'), { recursive: true })
    writeFileSync(
      path.join(top, 'bin', 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    )
    writeFileSync(path.join(top, 'bin', 'npm'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(path.join(top, 'LICENSE'), 'Node.js licence\n')
    const name = `node-v${version}-${platform}.tar.gz`
    execFileSync('tar', [
      '-czf',
      path.join(dist, name),
      '-C',
      path.join(dir, 'runtime'),
      `node-v${version}-${platform}`,
    ])
    lines.push(`${sha256(path.join(dist, name))}  ${name}`)
  }
  writeFileSync(path.join(dist, 'SHASUMS256.txt'), lines.join('\n') + '\n')
  return path.join(dir, 'dist')
}

function serve(
  dir: string,
  handle?: (
    url: URL,
    res: import('node:http').ServerResponse,
    req: import('node:http').IncomingMessage,
  ) => boolean,
): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://local')
      if (handle?.(url, res, req) === true) return
      const file = path.join(dir, decodeURIComponent(url.pathname))
      if (
        !file.startsWith(dir) ||
        !existsSync(file) ||
        !statSync(file).isFile()
      ) {
        res.writeHead(404).end()
        return
      }
      res.end(readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      })
    })
  })
}

/**
 * GitHub's release API, pretty-printed as GitHub answers, for TeamStationApp/mason-releases (public) and
 * TeamStationApp/mason (private: nothing without a token). A wrong token is
 * refused everywhere, as GitHub does.
 */
function githubApi(
  releases: Record<string, string>,
  tampered = new Set<string>(),
): (
  url: URL,
  res: import('node:http').ServerResponse,
  req: import('node:http').IncomingMessage,
) => boolean {
  // GitHub numbers assets; this remembers which file each number is.
  const assets: Array<[string, string]> = []
  return (url, res, req) => {
    const repo = /^\/repos\/(TeamStationApp\/mason(?:-releases)?)\//.exec(
      url.pathname,
    )?.[1]
    if (repo == null) return false
    const authorization = req.headers.authorization
    if (authorization != null && authorization !== 'Bearer read-token') {
      res.writeHead(401).end('{"message":"Bad credentials"}')
      return true
    }
    if (repo === 'TeamStationApp/mason' && authorization == null) {
      res.writeHead(404).end('{"message":"Not Found"}')
      return true
    }
    const base = `http://${req.headers.host!}/repos/${repo}`
    const asset = /\/releases\/assets\/(\d+)$/.exec(url.pathname)
    if (asset != null) {
      const [version, name] = assets[Number(asset[1])]!
      const file = path.join(releases[version]!, name)
      const body = readFileSync(file)
      res.end(
        tampered.has(name) ? Buffer.concat([body, Buffer.from('x')]) : body,
      )
      return true
    }
    const route = /\/releases\/(latest|tags\/v(.+))$/.exec(url.pathname)
    if (route == null) return false
    const version =
      route[1] === 'latest'
        ? Object.keys(releases).sort(compareSemver).pop()!
        : route[2]!
    if (releases[version] == null) {
      res.writeHead(404).end()
      return true
    }
    const names = readFileSync(
      path.join(releases[version], 'SHA256SUMS'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/)[1]!)
    res.end(
      JSON.stringify(
        {
          url: `${base}/releases/1`,
          tag_name: `v${version}`,
          assets: [...names, 'SHA256SUMS'].map((name) => ({
            url: `${base}/releases/assets/${assets.push([version, name]) - 1}`,
            id: assets.length - 1,
            node_id: 'x',
            name,
            uploader: { login: 'paul' },
          })),
        },
        null,
        2,
      ),
    )
    return true
  }
}

function io(
  extra: Partial<MainIO> = {},
): MainIO & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    system: (): ServiceSystem => {
      throw new Error('no system')
    },
    stopped: async () => undefined,
    program: () => ['/opt/mason/current/mason'],
    ...extra,
  }
}

/**
 * The AppleDouble (`._`) entries in a tarball, read from its headers: macOS's
 * tar folds them back into extended attributes when it lists one.
 */
function appleDouble(tarball: string): string[] {
  const raw = gunzipSync(readFileSync(tarball))
  const names: string[] = []
  for (let at = 0; at + 512 <= raw.length; ) {
    const name = raw.toString('utf8', at, at + 100).replace(/\0.*$/s, '')
    if (name === '') break
    const size = parseInt(raw.toString('ascii', at + 124, at + 136), 8) || 0
    names.push(name)
    at += 512 + Math.ceil(size / 512) * 512
  }
  assert(names.length > 0)
  return names.filter((name) => /(^|\/)\._/.test(name))
}

describe('Releases, install.sh and updates', function () {
  this.timeout(300000)
  let work: string
  let dist: string
  let distServer: { server: Server; base: string }
  let distBase: string
  after(() => {
    distServer?.server.close()
  })
  const releases: Record<string, string> = {}

  before(async () => {
    work = root()
    dist = nodeDist(work, '24.22.0')
    distServer = await serve(dist)
    distBase = distServer.base
    for (const version of ['0.1.1', '0.1.2']) {
      const out = path.join(work, 'out', version)
      await buildRelease({
        repo,
        version,
        out,
        platforms: [here as never, 'linux-x64'],
        nodeVersion: '24.22.0',
        nodeSource: distBase,
        modules: path.join(repo, 'node_modules'),
        buildArgon2X64: async () => {
          const fake = path.join(work, 'argon2-x64.node')
          writeFileSync(fake, 'x64')
          return fake
        },
      })
      releases[version] = out
    }
  })

  it('U9.1 builds self-contained tarballs, install.sh and SHA256SUMS', () => {
    const out = releases['0.1.1']!
    const sums = readFileSync(path.join(out, 'SHA256SUMS'), 'utf8')
    for (const name of [
      tarballName('0.1.1', here as never),
      tarballName('0.1.1', 'linux-x64'),
      'install.sh',
    ])
      assert.match(
        sums,
        new RegExp(
          `^${sha256(path.join(out, name))}  ${name.replace(/\./g, '\\.')}$`,
          'm',
        ),
      )
    const list = execFileSync(
      'tar',
      ['-tzf', path.join(out, tarballName('0.1.1', 'linux-x64'))],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    for (const entry of [
      'mason-0.1.1/mason',
      'mason-0.1.1/node/bin/node',
      'mason-0.1.1/lib/cli.js',
      'mason-0.1.1/package.json',
      'mason-0.1.1/THIRD_PARTY_LICENCES.md',
      'mason-0.1.1/src/devices/apple-roots.pem',
    ])
      assert(list.includes(entry + '\n'), entry)
    assert(
      list.includes('mason-0.1.1/node_modules/argon2/prebuilds/linux-x64/'),
    )
    assert(
      !list.includes('prebuilds/darwin-arm64/'),
      'only this platform’s argon2',
    )
    assert(
      !list.includes('node_modules/argon2/build/'),
      'no argon2 compiled for the building computer',
    )
    assert.deepEqual(
      appleDouble(path.join(out, tarballName('0.1.1', 'linux-x64'))),
      [],
    )
    assert(!list.includes('node/bin/npm'))
    // The installed release still knows where its releases are published.
    const unpacked = path.join(root(), 'pkg')
    mkdirSync(unpacked)
    execFileSync('tar', [
      '-xzf',
      path.join(out, tarballName('0.1.1', 'linux-x64')),
      '-C',
      unpacked,
      'mason-0.1.1/package.json',
    ])
    assert.equal(
      (
        JSON.parse(
          readFileSync(
            path.join(unpacked, 'mason-0.1.1', 'package.json'),
            'utf8',
          ),
        ) as { masonReleases?: string }
      ).masonReleases,
      'TeamStationApp/mason-releases',
    )
    assert(!list.includes('node/include/'))
    assert(!/mason-0\.1\.1\/lib\/[^\n]*\.test\.js\n/.test(list))
    assert(!list.includes('mason-0.1.1/lib/test/'))
  })

  it('U9.1 builds the darwin-x64 argon2 binary the package does not ship', async () => {
    const out = path.join(work, 'x64')
    // argon2 as `npm ci` leaves it on the building computer: compiled into
    // build/, and on macOS with a file carrying an extended attribute.
    const modules = path.join(work, 'x64-modules')
    cpSync(
      path.join(repo, 'node_modules', 'argon2'),
      path.join(modules, 'argon2'),
      { recursive: true },
    )
    mkdirSync(path.join(modules, 'argon2', 'build', 'Release'), {
      recursive: true,
    })
    writeFileSync(
      path.join(modules, 'argon2', 'build', 'Release', 'argon2.node'),
      'host binary',
    )
    if (process.platform === 'darwin')
      execFileSync('xattr', [
        '-w',
        'com.example.mason',
        'test',
        path.join(modules, 'argon2', 'package.json'),
      ])
    await buildRelease({
      repo,
      version: '0.1.9',
      out,
      platforms: ['darwin-x64'],
      nodeVersion: '24.22.0',
      nodeSource: distBase,
      modules,
      buildArgon2X64: async () => {
        const fake = path.join(work, 'argon2-x64.node')
        writeFileSync(fake, 'x64 binary')
        return fake
      },
    })
    const list = execFileSync(
      'tar',
      ['-tzf', path.join(out, tarballName('0.1.9', 'darwin-x64'))],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    assert(
      list.includes(
        'mason-0.1.9/node_modules/argon2/prebuilds/darwin-x64/argon2.node\n',
      ),
    )
    assert(!list.includes('node_modules/argon2/build/'))
    assert.deepEqual(
      appleDouble(path.join(out, tarballName('0.1.9', 'darwin-x64'))),
      [],
    )
    await assert.rejects(
      buildRelease({ repo, version: 'one', out, nodeSource: distBase }),
      /not a semver version/,
    )
  })

  describe('install.sh', () => {
    let github: { server: Server; base: string }
    let host: { server: Server; base: string }
    const tampered = new Set<string>()
    before(async () => {
      github = await serve(work, githubApi(releases, tampered))
      const hostDir = path.join(work, 'host')
      mkdirSync(path.join(hostDir, 'releases'), { recursive: true })
      symlinkSync(releases['0.1.2']!, path.join(hostDir, 'releases', 'current'))
      symlinkSync(
        path.join(releases['0.1.2']!, 'install.sh'),
        path.join(hostDir, 'install.sh'),
      )
      host = await serve(hostDir)
    })
    after(() => {
      github.server.close()
      host.server.close()
    })
    const bash = async (
      args: string[],
      env: Record<string, string>,
      home: string,
    ): Promise<{ status: number; out: string }> =>
      await run(
        'bash',
        [path.join(releases['0.1.1']!, 'install.sh'), ...args],
        {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: home,
          TMPDIR: path.join(home, 'tmp'),
          MASON_GITHUB_API: github.base,
          ...env,
        },
      )

    it('U9.1 installs a release with a GitHub token, links mason, runs without Node or npm, and is idempotent', async () => {
      const home = root()
      mkdirSync(path.join(home, 'tmp'))
      const first = await bash(
        ['--user', '--version', '0.1.1'],
        { GITHUB_TOKEN: 'read-token' },
        home,
      )
      assert.equal(first.status, 0, first.out)
      assert.match(
        first.out,
        /Installed Mason 0\.1\.1 in .*\.mason\/app\/0\.1\.1/,
      )
      const link = path.join(home, '.local', 'bin', 'mason')
      assert.equal(
        readlinkSync(link),
        path.join(home, '.mason', 'app', 'current', 'mason'),
      )
      assert.equal(
        readlinkSync(path.join(home, '.mason', 'app', 'current')),
        '0.1.1',
      )
      // The launcher runs the release's own Node; PATH has no node at all.
      const help = await run(link, ['help'], {
        PATH: '/usr/bin:/bin',
        HOME: home,
      })
      assert.equal(help.status, 0, help.out)
      assert.match(help.stdout, /mason worker \[options\]/)
      assert.equal(
        readFileSync(
          path.join(home, '.mason', 'app', '0.1.1', 'release', 'SHA256SUMS'),
          'utf8',
        ),
        readFileSync(path.join(releases['0.1.1']!, 'SHA256SUMS'), 'utf8'),
      )
      const again = await bash(
        ['--user', '--version', '0.1.1'],
        { GITHUB_TOKEN: 'read-token' },
        home,
      )
      assert.equal(again.status, 0)
      assert.match(again.out, /already installed/)
      const latest = await bash(
        ['--user'],
        { GITHUB_TOKEN: 'read-token' },
        home,
      )
      assert.match(latest.out, /Installed Mason 0\.1\.2/)
      assert.equal(
        readlinkSync(path.join(home, '.mason', 'app', 'current')),
        '0.1.2',
      )
    })

    it('U9.1 installs from the public releases with no token, needs one for a private repository, refuses a mismatch, and installs from a host with none', async () => {
      const home = root()
      mkdirSync(path.join(home, 'tmp'))
      const openHome = root()
      mkdirSync(path.join(openHome, 'tmp'))
      const open = await bash(['--user'], {}, openHome)
      assert.equal(open.status, 0, open.out)
      assert.match(open.out, /Installed Mason 0\.1\.2/)
      const none = await bash(
        ['--user'],
        { MASON_REPO: 'TeamStationApp/mason' },
        home,
      )
      assert.notEqual(none.status, 0)
      assert.match(
        none.out,
        /TeamStationApp\/mason has no latest release \(a private repository needs GITHUB_TOKEN, or 'gh auth login'\)/,
      )
      const wrong = await bash(['--user'], { GITHUB_TOKEN: 'other' }, home)
      assert.match(wrong.out, /has no latest release this token can read/)
      tampered.add(tarballName('0.1.2', here as never))
      try {
        const bad = await bash(['--user'], { GITHUB_TOKEN: 'read-token' }, home)
        assert.notEqual(bad.status, 0)
        assert.match(bad.out, /checksum mismatch .*refusing to install it/)
        assert.equal(
          existsSync(path.join(home, '.mason', 'app', '0.1.2')),
          false,
        )
      } finally {
        tampered.clear()
      }
      const prefix = path.join(home, 'opt')
      const bin = path.join(home, 'bin')
      const fromHost = await bash(
        ['--from', host.base],
        { MASON_PREFIX: prefix, MASON_BIN: bin },
        home,
      )
      assert.equal(fromHost.status, 0, fromHost.out)
      assert.match(fromHost.out, /Installed Mason 0\.1\.2 in .*\/opt\/0\.1\.2/)
      assert.match(fromHost.out, /sudo mason worker --install/)
      assert.equal(
        readlinkSync(path.join(bin, 'mason')),
        path.join(prefix, 'current', 'mason'),
      )
      assert.match(
        (await bash(['--bogus'], {}, home)).out,
        /unknown option --bogus/,
      )
      assert.match(
        (
          await bash(
            ['--user', '--version', '9.9.9'],
            { GITHUB_TOKEN: 'read-token' },
            home,
          )
        ).out,
        /has no 9\.9\.9 release this token can read\n/,
      )
      // A token never appears in what install.sh prints.
      const leaked = await bash(
        ['--user'],
        { GITHUB_TOKEN: 'secret-token-x' },
        home,
      )
      assert(!leaked.out.includes('secret-token-x'), leaked.out)
    })

    it('U9.1 mason update installs the newer release and keeps the data directory', async () => {
      const home = root()
      mkdirSync(path.join(home, 'tmp'))
      assert.equal(
        (
          await bash(
            ['--user', '--version', '0.1.1'],
            { GITHUB_TOKEN: 'read-token' },
            home,
          )
        ).status,
        0,
      )
      const data = path.join(home, '.mason', 'data-kept')
      mkdirSync(data, { recursive: true })
      writeFileSync(path.join(data, 'keep.txt'), 'kept')
      const prefix = path.join(home, '.mason', 'app')
      const ran: string[][] = []
      const saved = { ...process.env }
      Object.assign(process.env, {
        HOME: home,
        TMPDIR: path.join(home, 'tmp'),
        GITHUB_TOKEN: 'read-token',
        MASON_GITHUB_API: github.base,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      })
      try {
        const out = io({
          install: () => ({
            kind: 'user',
            appRoot: path.join(prefix, '0.1.1'),
            prefix,
          }),
          system: () =>
            ({
              platform: 'darwin',
              run: (command: string, args: string[]) =>
                ran.push([command, ...args]),
            }) as unknown as ServiceSystem,
        })
        assert.equal(await nodeMain(['update'], out), 0, out.errors.join('\n'))
        assert.equal(readlinkSync(path.join(prefix, 'current')), '0.1.2')
        assert.deepEqual(
          ran.map((call) => call[3]?.split('/').pop()),
          ['app.mason.master', 'app.mason.worker', 'app.mason.host'],
        )
        assert.equal(readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'kept')
        assert.match(out.lines.join('\n'), /data directories are unchanged/)
        const checkout = io({
          install: () => ({ kind: 'checkout', appRoot: repo }),
        })
        assert.equal(await nodeMain(['update'], checkout), 1)
        assert.match(checkout.errors.join(''), /source checkout/)
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in saved)) delete process.env[key]
        Object.assign(process.env, saved)
      }
    })
  })

  it('U9.14 stores releases only when SHA256SUMS matches, and serves one as current', async () => {
    const dir = root()
    const db = new MasterDatabase(new DatabaseSync(path.join(dir, 'm.sqlite')))
    migrateMaster(db.db)
    mkdirSync(path.join(dir, 'id'))
    const identity = loadIdentity(path.join(dir, 'id'))
    const store = new Releases(
      db,
      path.join(dir, 'releases'),
      identity,
      '0.1.2',
    )
    assert.equal(store.current(), undefined)
    assert.equal(await store.add(releases['0.1.1']!), '0.1.1')
    assert.equal(
      store.current(),
      undefined,
      'the master’s own version is not stored yet',
    )
    assert.throws(
      () => store.setCurrent('0.2.0'),
      /0\.2\.0 is not in the store/,
    )
    store.setCurrent('0.1.1')
    assert.equal(store.current(), '0.1.1')
    assert.deepEqual(store.list(), [
      {
        version: '0.1.1',
        platforms: [here, 'linux-x64'].sort(),
        current: true,
      },
    ])
    const bad = path.join(dir, 'bad')
    mkdirSync(bad)
    for (const name of [
      'SHA256SUMS',
      'install.sh',
      tarballName('0.1.2', 'linux-x64'),
    ])
      writeFileSync(
        path.join(bad, name),
        readFileSync(path.join(releases['0.1.2']!, name)),
      )
    await assert.rejects(store.add(bad), /listed in SHA256SUMS but missing/)
    writeFileSync(
      path.join(bad, tarballName('0.1.2', here as never)),
      'tampered',
    )
    await assert.rejects(store.add(bad), /does not match SHA256SUMS/)
    const github = await serve(work, githubApi(releases))
    try {
      assert.equal(
        await store.fetch('v0.1.2', 'read-token', dir, github.base),
        '0.1.2',
      )
      await assert.rejects(
        store.fetch('v0.1.2', 'wrong', dir, github.base),
        /GitHub answered 401/,
      )
      await assert.rejects(
        store.fetch('bad tag', 'read-token', dir, github.base),
        /Invalid tag/,
      )
      // Another repository is asked for its own releases; none named is refused.
      await assert.rejects(
        store.fetch(
          'v0.1.2',
          undefined,
          dir,
          github.base,
          'TeamStationApp/mason',
        ),
        /GitHub answered 404/,
      )
      await assert.rejects(
        store.fetch('v0.1.2', 'read-token', dir, github.base, 'not a repo'),
        /Name the repository/,
      )
      assert.equal(repository, 'TeamStationApp/mason-releases')
      assert.equal(
        releasesRepository({ version: '1', repository: 'github:a/b' }),
        'a/b',
      )
      assert.equal(
        releasesRepository({
          version: '1',
          repository: 'github:a/b',
          masonReleases: 'a/b-releases',
        }),
        'a/b-releases',
      )
      for (const [given, name] of [
        ['https://github.com/a/b.git', 'a/b'],
        ['git@github.com:a/b.git', 'a/b'],
        ['github:a/b', 'a/b'],
        ['https://gitlab.example.test/a/b.git', undefined],
      ] as const)
        assert.equal(repositoryName(given), name)
      assert.equal(repositoryName({ url: 'https://github.com/c/d' }), 'c/d')
      assert.equal(repositoryName(undefined), undefined)
    } finally {
      github.server.close()
    }
    db.db.prepare("DELETE FROM meta WHERE key='release_current'").run()
    assert.equal(
      store.current(),
      '0.1.2',
      'with nothing set, the master’s own stored version is current',
    )
    const signed = (await store.signed('0.1.2', 'linux-x64'))!
    assert(verifyRelease(signed, signed.signature, identity.publicKey))
    assert.equal(await store.signed('0.1.2', 'windows-x64'), undefined)
    // The copy install.sh leaves beside an install has only its own platform.
    const own = new Releases(db, path.join(dir, 'own'), identity, '0.1.1')
    const appRoot = path.join(dir, 'app')
    mkdirSync(path.join(appRoot, 'release'), { recursive: true })
    for (const name of [
      'SHA256SUMS',
      'install.sh',
      tarballName('0.1.1', here as never),
    ])
      writeFileSync(
        path.join(appRoot, 'release', name),
        readFileSync(path.join(releases['0.1.1']!, name)),
      )
    assert.equal(await own.importOwn(appRoot), '0.1.1')
    assert.deepEqual(own.list()[0]!.platforms, [here])
    assert.equal(await own.importOwn(appRoot), undefined)
  })

  describe('the privileged helper', () => {
    const user = {
      name: process.env.USER ?? 'paul',
      uid: process.getuid!(),
      gid: process.getgid!(),
      home: '/tmp',
    }
    const context = (
      dir: string,
    ): HelperContext & {
      ran: string[][]
      restarted: number
      signed: boolean
    } => {
      const out = {
        platform: 'darwin' as const,
        user,
        paths: {
          keyFile: path.join(dir, 'Mason', 'master.pub'),
          prefix: path.join(dir, 'opt'),
          bindir: path.join(dir, 'bin'),
          applications: path.join(dir, 'Applications'),
          work: path.join(dir, 'work'),
        },
        ran: [] as string[][],
        restarted: 0,
        signed: true,
        async run(
          command: string,
          args: string[],
          options: {
            asUser?: boolean
            env?: Record<string, string>
            cwd?: string
          } = {},
        ): Promise<{ stdout: string; stderr: string }> {
          out.ran.push([
            command,
            ...args,
            ...(options.asUser ? ['(as user)'] : []),
            ...(options.env?.DEVELOPER_DIR == null
              ? []
              : [`DEVELOPER_DIR=${options.env.DEVELOPER_DIR}`]),
          ])
          if (command === 'pkgutil')
            return {
              stdout: out.signed
                ? 'Status: signed Apple Software\n'
                : 'Status: no signature\n',
              stderr: '',
            }
          if (command === 'xip')
            mkdirSync(path.join(options.cwd!, 'Xcode.app', 'Contents'), {
              recursive: true,
            })
          if (command === 'softwareupdate' && args[0] === '--list')
            return {
              stdout: '* Label: Command Line Tools for Xcode-26.1\n',
              stderr: '',
            }
          return { stdout: '', stderr: '' }
        },
        async restartService(): Promise<void> {
          out.restarted++
        },
      }
      return out
    }

    it('U9.2 keeps the first master key and installs only releases that key signed, of the same major and not older', async () => {
      const dir = root()
      const ctx = context(dir)
      mkdirSync(path.join(dir, 'master'))
      mkdirSync(path.join(dir, 'other'))
      const master = loadIdentity(path.join(dir, 'master'))
      const other = loadIdentity(path.join(dir, 'other'))
      const spki = (key: typeof master.publicKey): string =>
        key.export({ type: 'spki', format: 'der' }).toString('base64')
      const tarball = path.join(
        releases['0.1.2']!,
        tarballName('0.1.2', here as never),
      )
      const manifest = {
        version: '0.1.2',
        platform: here,
        sha256: sha256(tarball),
      }
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball,
            manifest,
            signature: signRelease(manifest, master.privateKey),
          },
          ctx,
        ),
        /No master key is set/,
      )
      assert.deepEqual(
        await perform('key.set', { publicKey: spki(master.publicKey) }, ctx),
        { stored: true },
      )
      assert.deepEqual(
        await perform('key.set', { publicKey: spki(master.publicKey) }, ctx),
        { stored: false },
      )
      await assert.rejects(
        perform('key.set', { publicKey: spki(other.publicKey) }, ctx),
        /already set; replace it with sudo mason worker --new-key/,
      )
      await assert.rejects(
        perform('key.set', { publicKey: 'nonsense' }, ctx),
        /Not a public key/,
      )
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball,
            manifest,
            signature: signRelease(manifest, other.privateKey),
          },
          ctx,
        ),
        /does not verify with the master key/,
      )
      const installed = (await perform(
        'release.install',
        {
          tarball,
          manifest,
          signature: signRelease(manifest, master.privateKey),
        },
        ctx,
      )) as Json
      assert.equal(installed.installed, path.join(ctx.paths.prefix, '0.1.2'))
      assert.equal(
        readlinkSync(path.join(ctx.paths.prefix, 'current')),
        '0.1.2',
      )
      assert.equal(
        readlinkSync(path.join(ctx.paths.bindir, 'mason')),
        path.join(ctx.paths.prefix, 'current', 'mason'),
      )
      // The service restarts a second after the answer.
      assert.equal(ctx.restarted, 0)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      assert.equal(ctx.restarted, 1)
      const older = {
        ...manifest,
        version: '0.1.1',
        sha256: sha256(
          path.join(releases['0.1.1']!, tarballName('0.1.1', here as never)),
        ),
      }
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball: path.join(
              releases['0.1.1']!,
              tarballName('0.1.1', here as never),
            ),
            manifest: older,
            signature: signRelease(older, master.privateKey),
          },
          ctx,
        ),
        /older than 0\.1\.2/,
      )
      const next = { ...manifest, version: '1.0.0' }
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball,
            manifest: next,
            signature: signRelease(next, master.privateKey),
          },
          ctx,
        ),
        /another major version/,
      )
      const lie = { ...manifest, sha256: 'a'.repeat(64) }
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball,
            manifest: lie,
            signature: signRelease(lie, master.privateKey),
          },
          ctx,
        ),
        /does not match its signed digest/,
      )
      const link = path.join(dir, 'link.tar.gz')
      symlinkSync(tarball, link)
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball: link,
            manifest,
            signature: signRelease(manifest, master.privateKey),
          },
          ctx,
        ),
        /Not a regular file/,
      )
      await assert.rejects(
        perform(
          'release.install',
          {
            tarball: 'relative.tar.gz',
            manifest,
            signature: signRelease(manifest, master.privateKey),
          },
          ctx,
        ),
        /absolute path/,
      )
    })

    it('U9.2/U9.4/U9.7/U9.8 performs only catalog operations, with validated arguments', async () => {
      const dir = root()
      const ctx = context(dir)
      mkdirSync(ctx.paths.applications, { recursive: true })
      await assert.rejects(
        perform('shell', { command: 'rm -rf /' }, ctx),
        /shell is not a helper operation/,
      )
      await assert.rejects(
        perform('constructor', {}, ctx),
        /not a helper operation/,
      )
      await assert.rejects(
        perform('brew.install', { formulae: ['jq; rm -rf /'] }, ctx),
        /package names/,
      )
      await assert.rejects(
        perform('brew.install', { formulae: [] }, ctx),
        /package names/,
      )
      await assert.rejects(
        perform('settings.apply', { name: 'autoLogin' }, ctx),
        /Unknown setting/,
      )
      await assert.rejects(
        perform('xcode.license', { path: '/etc' }, ctx),
        /directly in/,
      )
      await assert.rejects(
        perform('xcode.install', { version: '26; reboot', xip: '/x' }, ctx),
        /Invalid Xcode version/,
      )
      const xip = path.join(dir, 'Xcode_26.1.xip')
      writeFileSync(xip, 'archive')
      ctx.signed = false
      await assert.rejects(
        perform('xcode.install', { version: '26.1', xip }, ctx),
        /not signed by Apple/,
      )
      ctx.signed = true
      assert.deepEqual(
        await perform('xcode.install', { version: '26.1', xip }, ctx),
        { installed: path.join(ctx.paths.applications, 'Xcode-26.1.app') },
      )
      const developer = `DEVELOPER_DIR=${path.join(ctx.paths.applications, 'Xcode-26.1.app', 'Contents', 'Developer')}`
      assert.deepEqual(
        ctx.ran.filter((call) => call[0] === 'xcodebuild'),
        [
          ['xcodebuild', '-license', 'accept', developer],
          ['xcodebuild', '-runFirstLaunch', developer],
        ],
      )
      assert(
        !ctx.ran.some((call) => call[0] === 'xcode-select'),
        'xcode-select is never run',
      )
      await perform(
        'brew.install',
        { formulae: ['jq'], casks: ['temurin'] },
        ctx,
      )
      await perform('apt.install', { packages: ['zip', 'unzip'] }, ctx)
      await perform('dnf.install', { packages: ['zip'] }, ctx)
      await perform('clt.install', {}, ctx)
      await perform('rosetta.install', {}, ctx)
      for (const name of ['noSleep', 'devToolsSecurity', 'automationMode'])
        await perform('settings.apply', { name }, ctx)
      await perform(
        'runtime.import',
        {
          file: xip,
          xcode: path.join(ctx.paths.applications, 'Xcode-26.1.app'),
        },
        ctx,
      )
      await assert.rejects(
        perform('docker.install', {}, ctx),
        /installed by the computer’s owner/,
      )
      assert.deepEqual(
        await perform('xcode.remove', { version: '26.1' }, ctx),
        { removed: path.join(ctx.paths.applications, 'Xcode-26.1.app') },
      )
      await assert.rejects(
        perform('xcode.remove', { version: '26.1' }, ctx),
        /not installed/,
      )
      assert.deepEqual(
        ctx.ran
          .filter(
            (call) =>
              call[0] !== 'pkgutil' &&
              call[0] !== 'xip' &&
              call[0] !== 'xcodebuild',
          )
          .map((call) => call.join(' ')),
        [
          'brew install jq (as user)',
          'brew install --cask temurin (as user)',
          'apt-get update',
          'apt-get install -y zip unzip',
          'dnf install -y zip',
          'softwareupdate --list',
          'softwareupdate --install Command Line Tools for Xcode-26.1',
          'softwareupdate --install-rosetta --agree-to-license',
          'pmset -a sleep 0',
          'DevToolsSecurity -enable',
          'automationmodetool enable-automationmode-without-authentication',
        ],
      )
      const linux = { ...context(dir), platform: 'linux' as const }
      await perform('docker.install', {}, linux)
      assert.deepEqual(
        linux.ran.map((call) => call[0]),
        ['apt-get', 'usermod', 'systemctl'],
      )
      await assert.rejects(perform('clt.install', {}, linux), /for macOS/)
      await assert.rejects(perform('rosetta.install', {}, linux), /for macOS/)
    })

    it('U9.2 answers only on an owner-only socket', async () => {
      const dir = root()
      const socket = path.join(dir, 'run', 'helper.sock')
      const server = await serveHelper(socket, context(dir))
      try {
        assert.equal(lstatSync(socket).mode & 0o777, 0o600)
        assert.equal(lstatSync(path.dirname(socket)).mode & 0o022, 0)
        await assert.rejects(
          helperRequest(socket, 'shell', {}),
          /not a helper operation/,
        )
        assert.deepEqual(
          await helperRequest(socket, 'settings.apply', { name: 'noSleep' }),
          null,
        )
        await assert.rejects(
          helperRequest(path.join(dir, 'none.sock'), 'x', {}),
          /helper is not installed/,
        )
      } finally {
        server.close()
      }
    })

    it('U9.2 worker --install adds the helper’s root service and --uninstall removes it and its key', () => {
      const writes: Array<[string, string, number]> = []
      const ran: string[][] = []
      const removed: string[] = []
      const system = (platform: 'darwin' | 'linux'): ServiceSystem => ({
        platform,
        euid: 0,
        env: { SUDO_USER: 'paul' },
        user: () => ({ uid: 501, gid: 20, home: '/Users/paul' }),
        createSystemUser: () => undefined,
        groupExists: () => false,
        writeFile: (file, content, owner) =>
          writes.push([file, content, owner.uid]),
        removeFile: (file) => removed.push(file),
        makeDirectory: () => undefined,
        run: (command, args) => ran.push([command, ...args]),
      })
      const mac = installHelperService(
        { program: ['/opt/mason/current/mason'] },
        system('darwin'),
      )
      assert.equal(mac.file, '/Library/LaunchDaemons/app.mason.helper.plist')
      const [file, plist, owner] = writes[0]!
      assert.equal(file, mac.file)
      assert.equal(owner, 0)
      assert.match(
        plist,
        /<string>\/opt\/mason\/current\/mason<\/string>\s*<string>helper<\/string>\s*<string>--user<\/string>\s*<string>paul<\/string>/,
      )
      assert.match(plist, /<key>UserName<\/key><string>root<\/string>/)
      assert.deepEqual(ran.at(-1), [
        'launchctl',
        'bootstrap',
        'system',
        mac.file,
      ])
      const linux = installHelperService(
        { program: ['/opt/mason/current/mason'] },
        system('linux'),
      )
      assert.equal(linux.file, '/etc/systemd/system/mason-helper.service')
      assert.match(
        writes[1]![1],
        /ExecStart=\/opt\/mason\/current\/mason helper --user paul/,
      )
      uninstallHelperService(
        system('darwin'),
        '/Library/Application Support/Mason/master.pub',
      )
      assert.deepEqual(removed, [
        '/Library/Application Support/Mason/master.pub',
        '/Library/LaunchDaemons/app.mason.helper.plist',
      ])
      assert.throws(
        () => uninstallHelperService({ ...system('darwin'), euid: 501 }, 'x'),
        /needs root/,
      )
      assert.deepEqual(
        serviceProgram(
          { kind: 'system', appRoot: '/opt/mason/0.1.2', prefix: '/opt/mason' },
          '/n',
          '/c',
        ),
        ['/opt/mason/current/mason'],
      )
      assert.deepEqual(
        serviceProgram({ kind: 'checkout', appRoot: repo }, '/n', '/c'),
        ['/n', '/c'],
      )
      assert.equal(runningInstall(repo).kind, 'checkout')
    })
  })

  it('U9.13 records an update installed when the worker comes back on its version after the link closed', async () => {
    const dir = root()
    const file = path.join(dir, 'mason-0.1.1-linux-x64.tar.gz')
    writeFileSync(file, 'tarball')
    let version = '0.1.0'
    const node = { fingerprint: 'fp', role: 'worker', name: 'pool-1' }
    // The helper installs and restarts the worker: the link closes before the answer.
    const link = {
      openStream: (): EventEmitter => {
        const stream = Object.assign(new EventEmitter(), {
          write: async (): Promise<void> => undefined,
          end: (): void => {
            setImmediate(() => stream.emit('abort', 'Link closed'))
          },
        })
        return stream
      },
    }
    const updates = new Updates(
      { list: () => [node], link: () => link } as never,
      {
        current: () => '0.1.1',
        signed: async () => ({
          version: '0.1.1',
          platform: 'linux-x64',
          sha256: 'x',
          signature: 's',
          file,
        }),
      } as never,
      () => ({ version, os: 'linux', arch: 'x64' }) as never,
      () => false,
    )
    await updates.tick()
    assert.deepEqual(
      { ...updates.state('fp'), at: 0 },
      { version: '0.1.1', status: 'failed', reason: 'Link closed', at: 0 },
    )
    version = '0.1.1'
    await updates.tick()
    assert.equal(updates.state('fp')?.status, 'installed')
    assert.equal(updates.state('fp')?.reason, undefined)
  })

  it('U9.13 pushes the current release to idle workers, signed, and they install and restart into it', async () => {
    const dir = root()
    const restarts: string[] = []
    const prefixes = {
      alpha: path.join(dir, 'alpha-app'),
      beta: path.join(dir, 'beta-app'),
    }
    const c = await cluster(dir, {
      workers: [
        {
          name: 'alpha',
          type: 'linux',
          workerOptions: {
            install: {
              kind: 'user',
              appRoot: path.join(prefixes.alpha, '0.1.0'),
              prefix: prefixes.alpha,
            },
            restart: (): void => {
              restarts.push('alpha')
            },
          },
        },
        {
          name: 'beta',
          type: 'linux',
          workerOptions: {
            install: { kind: 'checkout', appRoot: repo },
            restart: (): void => {
              restarts.push('beta')
            },
          },
        },
      ],
    })
    try {
      const master = c.master.master!
      await master.releases.add(releases['0.1.1']!)
      master.releases.setCurrent('0.1.1')
      await master.updates.tick()
      await c.until(
        () =>
          master.updates.state(c.fingerprint('alpha'))?.status === 'installed'
            ? true
            : undefined,
        60000,
        'alpha installed',
      )
      assert.equal(readlinkSync(path.join(prefixes.alpha, 'current')), '0.1.1')
      assert(existsSync(path.join(prefixes.alpha, '0.1.1', 'mason')))
      await c.until(() => restarts.includes('alpha'), 5000, 'restart')
      const beta = await c.until(
        () => master.updates.state(c.fingerprint('beta')),
        30000,
        'beta state',
      )
      assert.equal(beta.status, 'failed')
      assert.match(beta.reason!, /source checkout/)
      const nodes = (await c.api('GET', '/api/v2/nodes')).json
      assert.equal(
        nodes.find((node: Json) => node.name === 'alpha').update.status,
        'installed',
      )
      // A tarball changed after it was stored is refused by the worker's digest check.
      const tarball = path.join(
        master.releases.root,
        '0.1.1',
        tarballName('0.1.1', here as never),
      )
      chmodSync(tarball, 0o600)
      writeFileSync(
        tarball,
        Buffer.concat([readFileSync(tarball), Buffer.from('x')]),
      )
      const tampered = await master.updates.push(
        c.fingerprint('alpha'),
        '0.1.1',
        here,
      )
      assert.equal(tampered.status, 'failed')
      assert.match(tampered.reason!, /not newer than|does not match/)
    } finally {
      await c.close()
    }
  })

  describe('release tooling paths', () => {
    it('U9.1 scripts/release.ts installs production modules with npm ci, refuses bad arguments, and publishes with gh', async () => {
      const out = path.join(work, 'main')
      const published: string[][] = []
      const write = process.stdout.write.bind(process.stdout)
      process.stdout.write = (() => true) as typeof process.stdout.write
      try {
        assert.equal(
          await releaseMain(
            [
              '--version',
              '0.1.8',
              '--out',
              out,
              '--platform',
              here,
              '--publish',
              'v0.1.8',
            ],
            repo,
            {
              build: { nodeVersion: '24.22.0', nodeSource: distBase },
              gh: async (args) => {
                published.push(args)
              },
            },
          ),
          0,
        )
      } finally {
        process.stdout.write = write
      }
      assert.deepEqual(published[0]!.slice(0, 5), [
        'release',
        'create',
        'v0.1.8',
        '--repo',
        'TeamStationApp/mason-releases',
      ])
      assert(published[0]!.includes(path.join(out, 'SHA256SUMS')))
      const list = execFileSync(
        'tar',
        ['-tzf', path.join(out, tarballName('0.1.8', here as never))],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      )
      assert(list.includes('mason-0.1.8/node_modules/express/'))
      assert(
        !list.includes('mason-0.1.8/node_modules/mocha/'),
        'no development modules',
      )
      const error = console.error
      console.error = (): void => undefined
      try {
        assert.equal(await releaseMain(['--out', out], repo), 2)
      } finally {
        console.error = error
      }
      await assert.rejects(
        releaseMain(
          ['--version', '0.1.8', '--out', out, '--platform', 'windows-x64'],
          repo,
        ),
        /Unknown platform windows-x64/,
      )
      await assert.rejects(
        buildRelease({ repo: work, version: '0.1.8', out }),
        /Build lib\/ first/,
      )
    })

    it('U9.2 runs helper commands as root or as the Mason user through sudo, and restarts the worker service', async () => {
      const ran: Array<{
        file: string
        args: string[]
        cwd?: string
        input?: string
      }> = []
      const program = async (
        file: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string },
      ): Promise<{ stdout: string; stderr: string }> => {
        ran.push({
          file,
          args,
          ...(options.cwd == null ? {} : { cwd: options.cwd }),
          ...(options.input == null ? {} : { input: options.input }),
        })
        return { stdout: 'ok', stderr: '' }
      }
      const user = { name: 'mason', uid: 502, gid: 20, home: '/Users/mason' }
      const mac = systemContext(
        'darwin',
        user,
        { applications: '/tmp/apps' },
        program,
      )
      assert.equal(mac.paths.applications, '/tmp/apps')
      assert.equal(
        mac.paths.keyFile,
        '/Library/Application Support/Mason/master.pub',
      )
      assert.deepEqual(
        await mac.run('xcodebuild', ['-license', 'accept'], {
          cwd: '/tmp',
          input: 'y',
        }),
        { stdout: 'ok', stderr: '' },
      )
      await mac.run('brew', ['install', 'jq'], { asUser: true })
      await mac.restartService()
      const linux = systemContext('linux', user, {}, program)
      assert.equal(linux.paths.keyFile, '/etc/mason/master.pub')
      assert.deepEqual(helperPaths('linux'), {
        socket: '/run/mason/helper.sock',
        keyFile: '/etc/mason/master.pub',
        work: '/var/lib/mason-helper/work',
      })
      await linux.restartService()
      assert.deepEqual(ran, [
        {
          file: 'xcodebuild',
          args: ['-license', 'accept'],
          cwd: '/tmp',
          input: 'y',
        },
        {
          file: 'sudo',
          args: ['-u', 'mason', '-H', '--', 'brew', 'install', 'jq'],
        },
        {
          file: 'launchctl',
          args: ['kickstart', '-k', 'gui/502/app.mason.worker'],
        },
        { file: 'systemctl', args: ['restart', 'mason-worker'] },
      ])
      // The default runs the program itself.
      const real = systemContext('darwin', user)
      assert.equal(
        (await real.run('/bin/cat', [], { input: 'piped' })).stdout,
        'piped',
      )

      // Unreadable and oversized requests end the connection; a silent helper times out.
      const dir = root()
      const socket = path.join(dir, 'helper.sock')
      const server = await serveHelper(socket, mac)
      try {
        const reply = await new Promise<string>((resolve) => {
          const connection = createConnection(socket)
          let text = ''
          connection.setEncoding('utf8')
          connection.on('data', (chunk: string) => (text += chunk))
          connection.on('close', () => resolve(text))
          connection.write('not json\n')
        })
        assert.deepEqual(JSON.parse(reply), {
          ok: false,
          error: 'Unreadable request',
        })
        const closed = await new Promise<boolean>((resolve) => {
          const connection = createConnection(socket)
          connection.on('close', () => resolve(true))
          connection.on('error', () => undefined)
          connection.write('x'.repeat(1024 * 1024 + 10))
        })
        assert(closed)
      } finally {
        server.close()
      }
      const held: Array<import('node:net').Socket> = []
      const silent = createSocketServer((socket) => {
        held.push(socket)
      }).listen(path.join(dir, 'silent.sock'))
      await new Promise((resolve) => silent.once('listening', resolve))
      try {
        await assert.rejects(
          helperRequest(path.join(dir, 'silent.sock'), 'key.set', {}, 200),
          /did not answer/,
        )
      } finally {
        for (const socket of held) socket.destroy()
        silent.close()
      }
    })

    it('U9.2 mason helper runs only as root and needs the service user', async () => {
      const fake = (euid: number): ServiceSystem =>
        ({
          euid,
          platform: 'darwin',
          user: () => undefined,
        }) as unknown as ServiceSystem
      const cli = io({ system: () => fake(501) })
      assert.equal(await nodeMain(['helper', '--user', 'mason'], cli), 1)
      assert.match(cli.errors.join('\n'), /The helper runs as root/)
      const root0 = io({ system: () => fake(0) })
      assert.equal(await nodeMain(['helper'], root0), 1)
      assert.match(root0.errors.join('\n'), /Usage: mason helper --user <name>/)
    })

    it('U9.14 mason releases list, add and current through the master', async () => {
      const c = await cluster(root(), { workers: [] })
      try {
        const data = c.master.dir
        const cli = io()
        assert.equal(
          await nodeMain(['releases', 'list', '--data', data], cli),
          0,
        )
        assert.equal(
          await nodeMain(
            ['releases', 'add', releases['0.1.1']!, '--data', data],
            cli,
          ),
          0,
        )
        assert.equal(
          await nodeMain(
            ['releases', 'add', releases['0.1.2']!, '--data', data],
            cli,
          ),
          0,
        )
        assert.equal(
          await nodeMain(['releases', 'current', '0.1.1', '--data', data], cli),
          0,
        )
        assert.equal(
          await nodeMain(['releases', 'current', '--data', data], cli),
          0,
        )
        assert.equal(
          await nodeMain(['releases', 'list', '--data', data], cli),
          0,
        )
        assert.equal(
          await nodeMain(['releases', 'list', '--data', data, '--json'], cli),
          0,
        )
        assert.equal(
          await nodeMain(
            ['releases', 'fetch', 'v0.0.0-none', '--data', data],
            cli,
          ),
          1,
        )
        assert.equal(
          await nodeMain(['releases', 'bogus', '--data', data], cli),
          1,
        )
        assert.deepEqual(cli.lines.slice(0, 7), [
          'No releases are stored.',
          'Stored release 0.1.1',
          'Stored release 0.1.2',
          'Current release: 0.1.1',
          'Current release: 0.1.1',
          `* 0.1.1  ${[here, 'linux-x64'].sort().join(' ')}`,
          `  0.1.2  ${[here, 'linux-x64'].sort().join(' ')}`,
        ])
        assert.equal(JSON.parse(cli.lines[7]!).length, 2)
        assert.match(cli.errors.join('\n'), /Usage:/)
      } finally {
        await c.close()
      }
    })

    it('U9.13 refuses an offer before any bytes move, and installs a system release through the helper, giving it the master key first', async () => {
      const dir = root()
      mkdirSync(path.join(dir, 'master'))
      mkdirSync(path.join(dir, 'other'))
      const master = loadIdentity(path.join(dir, 'master'))
      const other = loadIdentity(path.join(dir, 'other'))
      const spki = (key: typeof master.publicKey): string =>
        key.export({ type: 'spki', format: 'der' }).toString('base64')
      const tarball = path.join(
        releases['0.1.2']!,
        tarballName('0.1.2', here as never),
      )
      const manifest = {
        version: '0.1.2',
        platform: here,
        sha256: sha256(tarball),
      }
      const signature = signRelease(manifest, master.privateKey)
      const base: UpdateContext = {
        masterKey: () => master.publicKey,
        version: '0.1.1',
        busy: () => false,
        install: {
          kind: 'system',
          appRoot: path.join(dir, 'opt', '0.1.1'),
          prefix: path.join(dir, 'opt'),
        },
        scratch: path.join(dir, 'scratch'),
        helperSocket: path.join(dir, 'helper.sock'),
        restart: () => undefined,
      }
      const refused = (
        patch: Partial<UpdateContext>,
        offer = manifest,
        sig = signature,
      ): string => {
        try {
          checkOffer(offer, sig, { ...base, ...patch })
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      }
      assert.equal(refused({}), 'accepted')
      assert.match(refused({ masterKey: () => undefined }), /no master key/)
      assert.match(
        refused({}, manifest, signRelease(manifest, other.privateKey)),
        /does not verify/,
      )
      assert.match(refused({ version: '1.0.0' }), /another major version/)
      assert.match(refused({ version: '0.1.2' }), /not newer/)
      const foreign = {
        ...manifest,
        platform: here === 'linux-x64' ? 'darwin-arm64' : 'linux-x64',
      }
      assert.match(
        refused({}, foreign, signRelease(foreign, master.privateKey)),
        /does not run on/,
      )
      assert.match(
        refused({ install: { kind: 'checkout', appRoot: repo } }),
        /source checkout/,
      )
      assert.match(refused({ busy: () => true }), /stage is running/)

      // A system install goes to the helper, which checks the signature again.
      const user = {
        name: process.env.USER ?? 'paul',
        uid: process.getuid!(),
        gid: process.getgid!(),
        home: dir,
      }
      let restarted = 0
      const helper: HelperContext = {
        platform: 'darwin',
        user,
        paths: {
          keyFile: path.join(dir, 'Mason', 'master.pub'),
          prefix: path.join(dir, 'opt'),
          bindir: path.join(dir, 'bin'),
          applications: path.join(dir, 'Applications'),
          work: path.join(dir, 'work'),
        },
        run: async () => ({ stdout: '', stderr: '' }),
        restartService: async () => {
          restarted++
        },
      }
      // The helper has no master key yet: it was not listening when the worker paired.
      const server = await serveHelper(base.helperSocket, helper)
      try {
        const stream = new EventEmitter() as EventEmitter & {
          written: Buffer[]
          ended: boolean
          aborted?: string
          write(chunk: Buffer): Promise<void>
          end(): void
          abort(reason: string): void
        }
        stream.written = []
        stream.ended = false
        stream.write = async (chunk): Promise<void> => {
          stream.written.push(chunk)
        }
        stream.end = (): void => {
          stream.ended = true
        }
        stream.abort = (reason): void => {
          stream.aborted = reason
        }
        const receiving = receiveUpdate(
          stream as never,
          { manifest, signature },
          base,
        )
        await new Promise((resolve) => setImmediate(resolve))
        stream.emit('data', readFileSync(tarball))
        stream.emit('end')
        await receiving
        assert.equal(stream.aborted, undefined)
        assert.deepEqual(JSON.parse(Buffer.concat(stream.written).toString()), {
          installed: '0.1.2',
        })
        assert.equal(readlinkSync(path.join(dir, 'opt', 'current')), '0.1.2')
        // The helper answers before it restarts the worker's service.
        assert.equal(restarted, 0)
        const deadline = Date.now() + 5000
        while (restarted === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(restarted, 1)
        assert.equal(
          readFileSync(helper.paths.keyFile, 'utf8').trim(),
          spki(master.publicKey),
        )
        // A tarball that does not match its digest is refused.
        const bad = Object.assign(new EventEmitter(), {
          write: stream.write,
          end: stream.end,
          abort: stream.abort,
        }) as typeof stream
        const failing = receiveUpdate(
          bad as never,
          { manifest, signature },
          base,
        )
        await new Promise((resolve) => setImmediate(resolve))
        bad.emit('data', Buffer.from('not the release'))
        bad.emit('end')
        await failing
        assert.match(String(stream.aborted), /does not match its signed digest/)
        // A helper that trusts another master refuses the update.
        writeFileSync(helper.paths.keyFile, spki(other.publicKey) + '\n')
        stream.aborted = undefined
        const keyed = Object.assign(new EventEmitter(), {
          write: stream.write,
          end: stream.end,
          abort: stream.abort,
        }) as typeof stream
        const refusing = receiveUpdate(
          keyed as never,
          { manifest, signature },
          base,
        )
        await new Promise((resolve) => setImmediate(resolve))
        keyed.emit('data', readFileSync(tarball))
        keyed.emit('end')
        await refusing
        assert.match(String(stream.aborted), /A master key is already set/)
        assert.equal(restarted, 1)
      } finally {
        server.close()
      }
    })
  })
})
