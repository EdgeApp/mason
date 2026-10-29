import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import { after, before, describe, it } from 'mocha'
import { cluster, type Cluster } from '../test/cluster.js'
import { platformOs } from './baseInventory.js'
import { fullInventory, scanXcodes } from './inventory.js'
import { LicencesNotAccepted } from './tools/android.js'
import {
  ChecksumMismatch,
  extract,
  type InstallContext,
} from './tools/common.js'
import {
  install,
  installedTools,
  missingTools,
  toolEnvironment,
} from './tools/index.js'
import {
  compareVersions,
  newestMatch,
  selectXcode,
  type XcodeInstall,
} from './tools/versions.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'tools-'))
const os = platformOs()
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

function plist(values: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>${Object.entries(values)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('')}</dict></plist>
`
}

/** An `/Applications` with two Xcodes, a beta and something else. */
function applications(dir: string): string {
  const add = (name: string, version: string, build: string): void => {
    mkdirSync(path.join(dir, name, 'Contents'), { recursive: true })
    writeFileSync(
      path.join(dir, name, 'Contents', 'Info.plist'),
      plist({ CFBundleShortVersionString: version }),
    )
    writeFileSync(
      path.join(dir, name, 'Contents', 'version.plist'),
      plist({ ProductBuildVersion: build }),
    )
  }
  add('Xcode.app', '26.0.1', '17A400')
  add('Xcode-26.1.app', '26.1', '17B55')
  add('Xcode-beta.app', '26.2', '17C5013d')
  mkdirSync(path.join(dir, 'Safari.app'), { recursive: true })
  mkdirSync(path.join(dir, 'Xcode-broken.app'), { recursive: true })
  return dir
}

/**
 * A local stand-in for nodejs.org, static.rust-lang.org, api.adoptium.net
 * and Google's Android repository, serving real archives with real digests.
 */
async function toolServer(dir: string): Promise<{
  server: Server
  base: string
  corrupt: Set<string>
}> {
  const files = new Map<string, Buffer>()
  const corrupt = new Set<string>()
  const tarball = (
    name: string,
    top: string,
    build: (dir: string) => void,
  ): Buffer => {
    const work = path.join(dir, 'build', name)
    mkdirSync(path.join(work, top), { recursive: true })
    build(path.join(work, top))
    const out = path.join(dir, 'build', `${name}.tar.gz`)
    execFileSync('tar', ['-czf', out, '-C', work, top])
    return readFileSync(out)
  }
  const script = (file: string, body: string): void => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }
  const platform = os === 'macos' ? 'darwin' : 'linux'
  const nodeName = `node-v24.11.1-${platform}-${arch}.tar.gz`
  const node = tarball('node', `node-v24.11.1-${platform}-${arch}`, (top) => {
    script(path.join(top, 'bin', 'node'), 'echo v24.11.1')
  })
  files.set(
    '/node/index.json',
    Buffer.from(
      JSON.stringify([
        { version: 'v24.11.1', lts: 'Krypton' },
        { version: 'v24.9.0', lts: false },
        { version: 'v22.20.0', lts: 'Jod' },
      ]),
    ),
  )
  files.set(`/node/v24.11.1/${nodeName}`, node)
  const nodeSum = createHash('sha256').update(node).digest('hex')
  files.set(
    '/node/v24.11.1/SHASUMS256.txt',
    Buffer.from(
      `${'0'.repeat(64)}  node-v24.11.1-other.tar.gz\n${nodeSum}  ${nodeName}\n`,
    ),
  )
  const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${os === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`
  const rustup = Buffer.from(
    '#!/bin/sh\nfor a; do last=$a; done\nmkdir -p "$CARGO_HOME/bin" "$RUSTUP_HOME/toolchains/$last"\nprintf "#!/bin/sh\\necho cargo $last\\n" > "$CARGO_HOME/bin/cargo"\nchmod +x "$CARGO_HOME/bin/cargo"\necho "installed toolchain $last"\n',
  )
  files.set(`/rust/rustup/dist/${target}/rustup-init`, rustup)
  files.set(
    `/rust/rustup/dist/${target}/rustup-init.sha256`,
    Buffer.from(
      `${createHash('sha256').update(rustup).digest('hex')}  rustup-init\n`,
    ),
  )
  const jdk = tarball('jdk', 'jdk-21.0.5+11', (top) => {
    const home = os === 'macos' ? path.join(top, 'Contents', 'Home') : top
    script(path.join(home, 'bin', 'java'), 'echo openjdk 21.0.5')
  })
  files.set('/adoptium/jdk.tar.gz', jdk)
  const toolsZip = path.join(dir, 'build', 'cmdline.zip')
  script(
    path.join(dir, 'build', 'zip', 'cmdline-tools', 'bin', 'sdkmanager'),
    [
      'root=""',
      'for a; do case "$a" in --sdk_root=*) root="${a#--sdk_root=}";; --licenses) echo "All SDK package licenses accepted"; exit 0;; *) pkgs="$pkgs $a";; esac; done',
      'for p in $pkgs; do mkdir -p "$root/$(echo $p | tr ";" "/")"; echo "Installed $p"; done',
      '[ -n "$JAVA_HOME" ] && echo "using $JAVA_HOME"',
    ].join('\n'),
  )
  execFileSync('zip', ['-qr', toolsZip, 'cmdline-tools'], {
    cwd: path.join(dir, 'build', 'zip'),
  })
  const zip = readFileSync(toolsZip)
  files.set('/android/commandlinetools.zip', zip)
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const triple = `${cpu}-${os === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`
  const sums: string[] = [
    `${'0'.repeat(64)}  cpython-3.12.9+20261026-other-install_only.tar.gz`,
  ]
  for (const version of ['3.12.4', '3.12.7', '3.13.1']) {
    const name = `cpython-${version}+20261026-${triple}-install_only.tar.gz`
    const build = tarball(`python-${version}`, 'python', (top) => {
      script(path.join(top, 'bin', 'python3'), `echo Python ${version}`)
    })
    files.set(`/python/download/${encodeURIComponent(name)}`, build)
    sums.push(`${createHash('sha256').update(build).digest('hex')}  ${name}`)
  }
  files.set('/python/download/SHA256SUMS', Buffer.from(sums.join('\n') + '\n'))
  const goOs = os === 'macos' ? 'darwin' : 'linux'
  const goArch = arch === 'arm64' ? 'arm64' : 'amd64'
  const goReleases: Json[] = []
  for (const [version, stable] of [
    ['1.24rc1', false],
    ['1.23.4', true],
    ['1.22.9', true],
  ] as const) {
    const filename = `go${version}.${goOs}-${goArch}.tar.gz`
    const build = tarball(`go-${version}`, 'go', (top) => {
      script(path.join(top, 'bin', 'go'), `echo go version go${version}`)
    })
    files.set(`/go/${filename}`, build)
    goReleases.push({
      version: `go${version}`,
      stable,
      files: [
        {
          filename: `go${version}.src.tar.gz`,
          os: '',
          arch: '',
          sha256: '0'.repeat(64),
          kind: 'source',
        },
        {
          filename,
          os: goOs,
          arch: goArch,
          sha256: createHash('sha256').update(build).digest('hex'),
          kind: 'archive',
        },
      ],
    })
  }
  let server!: Server
  const base = await new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://local')
      if (url.pathname === '/adoptium/v3/assets/latest/21/hotspot') {
        const link = `${base}/adoptium/jdk.tar.gz`
        res.end(
          JSON.stringify([
            {
              binary: {
                package: {
                  link,
                  name: 'OpenJDK21U-jdk.tar.gz',
                  checksum: corrupt.has('java')
                    ? 'f'.repeat(64)
                    : createHash('sha256').update(jdk).digest('hex'),
                },
              },
              version: { semver: '21.0.5+11' },
            },
          ]),
        )
        return
      }
      if (url.pathname === '/python/latest-release.json') {
        res.end(
          JSON.stringify({
            tag: '20261026',
            asset_url_prefix: corrupt.has('python-index')
              ? 'file:///etc'
              : `${base}/python/download`,
          }),
        )
        return
      }
      if (url.pathname === '/go/' && url.searchParams.get('mode') === 'json') {
        res.end(JSON.stringify(goReleases))
        return
      }
      if (url.pathname === '/android/repository2-3.xml') {
        const host = os === 'macos' ? 'macosx' : 'linux'
        res.end(`<?xml version="1.0"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <remotePackage path="platforms;android-35"><archives><archive><complete><url>x.zip</url><checksum>00</checksum></complete></archive></archives></remotePackage>
  <remotePackage path="cmdline-tools;latest">
    <archives>
      <archive><complete><size>1</size><checksum type="sha1">${'0'.repeat(40)}</checksum><url>other.zip</url></complete><host-os>windows</host-os></archive>
      <archive><complete><size>1</size><checksum type="sha1">${'1'.repeat(40)}</checksum><url>wrong-cpu.zip</url></complete><host-os>${host}</host-os><host-arch>${arch === 'arm64' ? 'x64' : 'aarch64'}</host-arch></archive>
      <archive><complete><size>${zip.length}</size><checksum type="sha1">${createHash('sha1').update(zip).digest('hex')}</checksum><url>commandlinetools.zip</url></complete><host-os>${host}</host-os><host-arch>${arch === 'arm64' ? 'aarch64' : 'x64'}</host-arch></archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>`)
        return
      }
      const body = files.get(url.pathname)
      if (body == null) {
        res.writeHead(404).end()
        return
      }
      res.end(
        corrupt.has(url.pathname)
          ? Buffer.concat([body, Buffer.from('tampered')])
          : body,
      )
    })
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
  return { server, base, corrupt }
}

describe('Worker tooling', function () {
  this.timeout(120000)
  let served: Awaited<ReturnType<typeof toolServer>>
  let sources: InstallContext['sources']
  before(async () => {
    served = await toolServer(root())
    sources = {
      node: `${served.base}/node`,
      rust: `${served.base}/rust`,
      adoptium: `${served.base}/adoptium`,
      android: `${served.base}/android`,
      python: `${served.base}/python`,
      go: `${served.base}/go`,
    }
  })
  after(() => {
    served.server.close()
  })
  const context = (toolsDir: string, log: string[] = []): InstallContext => ({
    toolsDir,
    sources,
    os,
    arch,
    log: (text) => log.push(text),
  })

  it('U8.1 lists installed Xcodes and the tools directory beside the base inventory', () => {
    const dir = root()
    const xcodes = scanXcodes(applications(path.join(dir, 'Applications')))
    assert.deepEqual(
      xcodes.map((xcode) => [
        path.basename(xcode.path),
        xcode.version,
        xcode.build,
        xcode.beta,
      ]),
      [
        ['Xcode-26.1.app', '26.1', '17B55', false],
        ['Xcode-beta.app', '26.2', '17C5013d', true],
        ['Xcode.app', '26.0.1', '17A400', false],
      ],
    )
    assert.deepEqual(scanXcodes(path.join(dir, 'missing')), [])
    const tools = path.join(dir, 'tools')
    mkdirSync(path.join(tools, 'node', '24.9.0'), { recursive: true })
    writeFileSync(
      path.join(tools, 'node', '24.9.0', '.mason-tool.json'),
      '{"tool":"node","version":"24.9.0"}',
    )
    mkdirSync(path.join(tools, 'node', 'half-installed'), { recursive: true })
    mkdirSync(path.join(tools, 'android', 'sdk', 'platforms', 'android-35'), {
      recursive: true,
    })
    mkdirSync(path.join(tools, 'android', 'sdk', 'platform-tools'), {
      recursive: true,
    })
    const inventory = fullInventory(
      {
        name: 'n',
        type: 't',
        labels: [],
        os: 'macos',
        osVersion: '26.0',
        arch: 'arm64',
        hostname: 'h',
        freeDisk: 1,
        slots: 1,
        version: '1',
      },
      { applications: path.join(dir, 'Applications'), toolsDir: tools },
    )
    assert.equal(inventory.xcodes.length, 3)
    assert.deepEqual(inventory.tools, {
      node: ['24.9.0'],
      rust: [],
      java: [],
      python: [],
      go: [],
      android: ['platform-tools', 'platforms;android-35'],
    })
    assert.deepEqual(
      fullInventory({ ...inventory, os: 'linux' }, { toolsDir: tools }).xcodes,
      [],
    )
  })

  it('U8.2 installs Node.js after checking SHASUMS256.txt, and rejects a tampered archive', async () => {
    const tools = path.join(root(), 'tools')
    const log: string[] = []
    assert.equal(
      await install({ tool: 'node', version: '24' }, context(tools, log)),
      '24.11.1',
    )
    assert.equal(
      execFileSync(path.join(tools, 'node', '24.11.1', 'bin', 'node'), {
        encoding: 'utf8',
      }).trim(),
      'v24.11.1',
    )
    assert.match(log.join(''), /Verified sha256 [0-9a-f]{64}/)
    assert.deepEqual(installedTools(tools).node, ['24.11.1'])
    await assert.rejects(
      install({ tool: 'node', version: '19' }, context(tools)),
      /No Node.js release matches 19/,
    )
    const fresh = path.join(root(), 'tools')
    served.corrupt.add(
      `/node/v24.11.1/node-v24.11.1-${os === 'macos' ? 'darwin' : 'linux'}-${arch}.tar.gz`,
    )
    try {
      await assert.rejects(
        install({ tool: 'node', version: '24.11.1' }, context(fresh)),
        (error: Error) =>
          error instanceof ChecksumMismatch &&
          /Checksum mismatch for node-v24\.11\.1/.test(error.message),
      )
    } finally {
      served.corrupt.clear()
    }
    assert.deepEqual(installedTools(fresh).node, [])
    assert.equal(existsSync(path.join(fresh, 'node', '24.11.1')), false)
  })

  it('U2.1/U2.2 installs Python and Go side by side after their checksums, newest match first', async () => {
    const tools = path.join(root(), 'tools')
    const log: string[] = []
    assert.equal(
      await install({ tool: 'python', version: '3.12' }, context(tools, log)),
      '3.12.7',
    )
    assert.equal(
      await install({ tool: 'python', version: '3.12.4' }, context(tools)),
      '3.12.4',
    )
    assert.equal(
      await install({ tool: 'go', version: '1.23' }, context(tools)),
      '1.23.4',
    )
    assert.equal(
      await install({ tool: 'go', version: '1.22.9' }, context(tools)),
      '1.22.9',
    )
    assert.match(log.join(''), /Verified sha256 [0-9a-f]{64}/)
    assert.deepEqual(installedTools(tools).python, ['3.12.4', '3.12.7'])
    assert.deepEqual(installedTools(tools).go, ['1.22.9', '1.23.4'])
    assert.equal(
      execFileSync(path.join(tools, 'python', '3.12.4', 'bin', 'python3'), {
        encoding: 'utf8',
      }).trim(),
      'Python 3.12.4',
    )
    const env = toolEnvironment(
      { python: '3.12', go: '1.22' },
      tools,
      '/usr/bin',
      null,
    )
    assert.equal(env.GOROOT, path.join(tools, 'go', '1.22.9'))
    assert.equal(env.GOTOOLCHAIN, 'local')
    assert.equal(env.PYTHONNOUSERSITE, '1')
    assert(env.PATH!.startsWith(path.join(tools, 'python', '3.12.7', 'bin')))
    assert.deepEqual(
      missingTools(
        { python: '3.13', go: '1.23' },
        { ...installedTools(tools) },
      ),
      [{ tool: 'python', version: '3.13' }],
    )
    await assert.rejects(
      install({ tool: 'python', version: '3.11' }, context(tools)),
      /Python 3\.11 is not in python-build-standalone 20261026/,
    )
    await assert.rejects(
      install({ tool: 'python', version: '3' }, context(tools)),
      /Invalid Python version/,
    )
    await assert.rejects(
      install({ tool: 'go', version: '1.24' }, context(tools)),
      /No Go release matches 1\.24/,
    )
    await assert.rejects(
      install({ tool: 'go', version: 'x' }, context(tools)),
      /Invalid Go version/,
    )
    served.corrupt.add('python-index')
    served.corrupt.add(
      `/go/go1.23.4.${os === 'macos' ? 'darwin' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`,
    )
    const fresh = path.join(root(), 'tools')
    try {
      await assert.rejects(
        install({ tool: 'python', version: '3.13' }, context(fresh)),
        /names no download location/,
      )
      await assert.rejects(
        install({ tool: 'go', version: '1.23' }, context(fresh)),
        ChecksumMismatch,
      )
    } finally {
      served.corrupt.clear()
    }
    assert.deepEqual(installedTools(fresh).go, [])
  })

  it('U8.3 installs Rust and Java after their checksums, and Android only where the node type accepted its licences', async () => {
    const tools = path.join(root(), 'tools')
    const log: string[] = []
    assert.equal(
      await install({ tool: 'rust', version: '1.82.0' }, context(tools, log)),
      '1.82.0',
    )
    assert.match(log.join(''), /installed toolchain 1\.82\.0/)
    await assert.rejects(
      install({ tool: 'rust', version: '../up' }, context(tools)),
      /Invalid Rust toolchain/,
    )
    assert.equal(
      await install({ tool: 'java', version: '21' }, context(tools)),
      '21.0.5',
    )
    await assert.rejects(
      install({ tool: 'java', version: '17' }, context(tools)),
      /answered 404/,
    )
    await assert.rejects(
      install({ tool: 'java', version: 'x' }, context(tools)),
      /Invalid Java version/,
    )
    served.corrupt.add('java')
    try {
      await assert.rejects(
        install(
          { tool: 'java', version: '21' },
          context(path.join(root(), 'tools')),
        ),
        ChecksumMismatch,
      )
    } finally {
      served.corrupt.clear()
    }
    await assert.rejects(
      install(
        {
          tool: 'android',
          packages: ['platforms;android-35'],
          nodeType: 'mac-xcode',
        },
        context(tools),
      ),
      (error: Error) =>
        error instanceof LicencesNotAccepted &&
        /not accepted for node type mac-xcode/.test(error.message),
    )
    const android: string[] = []
    await install(
      {
        tool: 'android',
        packages: ['platforms;android-35', 'build-tools;35.0.0'],
        nodeType: 'mac-xcode',
        acceptLicences: true,
      },
      context(tools, android),
    )
    assert.match(android.join(''), /Verified sha1/)
    assert.match(android.join(''), /All SDK package licenses accepted/)
    assert.match(android.join(''), /using .*java\/21\.0\.5/)
    assert.deepEqual(installedTools(tools), {
      node: [],
      rust: ['1.82.0'],
      java: ['21.0.5'],
      python: [],
      go: [],
      android: [
        'build-tools;35.0.0',
        'cmdline-tools;latest',
        'platforms;android-35',
      ],
    })
    await assert.rejects(
      install(
        { tool: 'android', packages: ['../evil'], acceptLicences: true },
        context(tools),
      ),
      /Invalid Android package name/,
    )
    const env = toolEnvironment(
      {
        rust: '1.82.0',
        java: '21',
        android: ['platforms;android-35'],
        node: '24',
      },
      tools,
      '/usr/bin',
    )
    assert.equal(
      env.JAVA_HOME,
      path.join(
        tools,
        'java',
        '21.0.5',
        ...(os === 'macos' ? ['Contents', 'Home'] : []),
      ),
    )
    assert.equal(env.ANDROID_HOME, path.join(tools, 'android', 'sdk'))
    assert.equal(env.CARGO_HOME, path.join(tools, 'rust', '1.82.0', 'cargo'))
    assert(env.PATH!.endsWith(':/usr/bin'))
    assert(
      env.PATH!.startsWith(path.join(tools, 'rust', '1.82.0', 'cargo', 'bin')),
    )
    assert.deepEqual(toolEnvironment(undefined, tools, '/usr/bin'), {})
    assert.deepEqual(
      toolEnvironment({ xcode: 'latest' }, tools, '/usr/bin'),
      {},
    )
    // Homebrew formulae: Homebrew's bin follows the tools, before the service's PATH.
    assert.deepEqual(
      toolEnvironment(
        { brew: ['cocoapods'] },
        tools,
        '/usr/bin',
        '/opt/homebrew/bin/brew',
      ),
      { PATH: '/opt/homebrew/bin:/usr/bin' },
    )
    const withRust = toolEnvironment(
      { rust: '1.82.0', brew: ['cocoapods'] },
      tools,
      '/usr/bin',
      '/opt/homebrew/bin/brew',
    ).PATH!
    assert(
      withRust.startsWith(path.join(tools, 'rust', '1.82.0', 'cargo', 'bin')),
    )
    assert(withRust.endsWith(':/opt/homebrew/bin:/usr/bin'))
    // No Homebrew on the computer, or no formulae: PATH is left alone.
    assert.deepEqual(
      toolEnvironment({ brew: ['cocoapods'] }, tools, '/usr/bin', null),
      {},
    )
    assert.deepEqual(
      toolEnvironment(
        { brew: [] },
        tools,
        '/usr/bin',
        '/opt/homebrew/bin/brew',
      ),
      {},
    )
  })

  it('U8.3 unpacks zips in-process, keeping modes and links, and nothing outside the target', async () => {
    const dir = root()
    const tree = path.join(dir, 'tree')
    mkdirSync(path.join(tree, 'tools', 'bin'), { recursive: true })
    writeFileSync(path.join(tree, 'tools', 'bin', 'run'), '#!/bin/sh\n')
    chmodSync(path.join(tree, 'tools', 'bin', 'run'), 0o755)
    writeFileSync(path.join(tree, 'tools', 'notes.txt'), 'notes')
    symlinkSync('bin/run', path.join(tree, 'tools', 'current'))
    const zip = (name: string, ...entries: string[]): string => {
      const file = path.join(dir, name)
      execFileSync('zip', ['-qry', file, ...entries], { cwd: tree })
      return file
    }
    const into = path.join(dir, 'out')
    const good = zip('good.zip', 'tools')
    // No unzip, or any other program, is needed.
    const saved = process.env.PATH
    process.env.PATH = path.join(dir, 'empty')
    try {
      await extract(good, into)
    } finally {
      process.env.PATH = saved
    }
    assert.equal(
      statSync(path.join(into, 'tools', 'bin', 'run')).mode & 0o777,
      0o755,
    )
    assert.equal(
      readFileSync(path.join(into, 'tools', 'notes.txt'), 'utf8'),
      'notes',
    )
    assert.equal(readlinkSync(path.join(into, 'tools', 'current')), 'bin/run')
    // Unpacking again replaces what is there.
    await extract(path.join(dir, 'good.zip'), into)
    assert(lstatSync(path.join(into, 'tools', 'current')).isSymbolicLink())

    // A link that leaves the target is refused.
    symlinkSync('../../../outside', path.join(tree, 'escape'))
    await assert.rejects(
      extract(zip('link.zip', 'escape'), path.join(dir, 'link')),
      /escape links outside the archive's directory/,
    )
    // So is an entry named outside it (the name patched to ../ in place).
    writeFileSync(path.join(tree, 'xx'), 'x')
    const named = zip('named.zip', 'xx')
    writeFileSync(
      named,
      Buffer.from(
        readFileSync(named).toString('latin1').replaceAll('xx', '..'),
        'latin1',
      ),
    )
    await assert.rejects(
      extract(named, path.join(dir, 'named')),
      /invalid relative path/,
    )
    assert(!existsSync(path.join(dir, 'outside')))
  })

  it('U8.4 picks the newest Xcode a range accepts', () => {
    const installs: XcodeInstall[] = [
      { version: '26.0.1', build: '17A400', path: '/A/Xcode.app', beta: false },
      {
        version: '26.1',
        build: '17B55',
        path: '/A/Xcode-26.1.app',
        beta: false,
      },
      {
        version: '26.2',
        build: '17C5013d',
        path: '/A/Xcode-beta.app',
        beta: true,
      },
      {
        version: '16.4',
        build: '16F6',
        path: '/A/Xcode-16.4.app',
        beta: false,
      },
    ]
    const pick = (spec: string): string | undefined =>
      selectXcode(spec, installs)?.version
    assert.equal(pick('latest'), '26.1')
    assert.equal(pick('latest-beta'), '26.2')
    assert.equal(pick('26'), '26.1')
    assert.equal(pick('26.0'), '26.0.1')
    assert.equal(pick('17B55'), '26.1')
    assert.equal(pick('>=16 <26'), '16.4')
    assert.equal(pick('>26.0 <=26.1'), '26.1')
    assert.equal(pick('=26.0.1'), '26.0.1')
    assert.equal(pick('27'), undefined)
    assert(compareVersions('26.10', '26.9') > 0)
    assert.equal(newestMatch('24', ['24.9.0', '24.11.1', '22.1.0']), '24.11.1')
    assert.equal(newestMatch('21', ['21.0.5+11']), '21.0.5+11')
  })

  it('U8.6 calls only the closed set of installers', async () => {
    await assert.rejects(
      install({ tool: 'perl' as never, version: '5' }, context(root())),
      /perl is not a tool Mason installs/,
    )
    assert.deepEqual(
      missingTools(
        {
          node: '24',
          java: '21',
          rust: '1.82.0',
          android: ['platforms;android-35'],
          xcode: '26',
          brew: ['jq'],
        },
        {
          node: ['24.1.0'],
          java: [],
          rust: ['1.82.0'],
          python: [],
          go: [],
          android: ['platforms;android-35'],
        },
      ),
      [{ tool: 'java', version: '21' }],
    )
    assert.deepEqual(
      missingTools(undefined, {
        node: [],
        java: [],
        rust: [],
        python: [],
        go: [],
        android: [],
      }),
      [],
    )
  })

  describe('on a cluster', () => {
    let c: Cluster
    let apps: string
    before(async () => {
      const dir = root()
      apps = applications(path.join(dir, 'Applications'))
      c = await cluster(dir, {
        workers: [
          {
            name: 'tooled',
            type: 'mac-xcode',
            workerOptions: { applications: apps, toolSources: sources },
          },
          {
            name: 'bare',
            type: 'mac-xcode',
            workerOptions: {
              applications: path.join(dir, 'none'),
              toolSources: sources,
            },
          },
        ],
      })
      const repo = c.repo('fixtures/tools')
      repo.commit({
        '.nvmrc': 'lts/*\n',
        'rust-toolchain.toml': '[toolchain]\nchannel = "1.82.0"\n',
        '.python-version': '3.13\n',
        'go.mod': 'module example.com/x\n\ngo 1.22\n',
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { want: { type: 'string', default: 'node' } } }, () => {})
  const want = String(m.params.want)
  const tools =
    want === 'node' ? { node: '24', java: '21' } :
    want === 'project' ? { node: 'project', rust: 'project' } :
    want === 'pygo' ? { python: 'project', go: 'project' } :
    want === 'py312' ? { python: '3.12' } :
    want === 'android' ? { android: ['platforms;android-35'] } :
    want === 'xcode' ? { xcode: '26.1' } :
    want === 'nox' ? { xcode: '99' } : {}
  m.stage('use', { on: 'mac-xcode', tools, run: use })
}
export async function use(ctx: Stage) {
  const sh = async (line: string) => (await ctx.sh(line, { quiet: true, allowFailure: true })).stdout.trim()
  return {
    node: ctx.node.name,
    nodeVersion: await sh('node --version'),
    python: await sh('python3 --version'),
    go: await sh('go version'),
    nodeBinary: process.env.NODE_BINARY ?? null,
    cargo: process.env.CARGO_HOME ?? null,
    javaHome: process.env.JAVA_HOME ?? null,
    developerDir: process.env.DEVELOPER_DIR ?? null,
    android: process.env.ANDROID_HOME ?? null,
  }
}
`,
      })
      c.master.master!.saveProject({ role: 'admin', label: 'test' }, 'tools', {
        repository: repo.url,
        rules: [{ pattern: 'master', mode: 'request' }],
      })
    })
    after(async () => {
      await c?.close()
    })
    const runWith = async (want: string): Promise<Json> => {
      const created = await c.api('POST', '/api/v2/runs', {
        project: 'tools',
        params: { want },
      })
      assert.equal(created.status, 202, created.text)
      const seen = new Set<string>()
      return await c.until(
        () => {
          const run = c.master.master!.run(created.json.id) as Json
          for (const stage of run.stages)
            seen.add(`${stage.name}:${stage.status}`)
          return ['succeeded', 'failed', 'cancelled'].includes(run.status)
            ? { ...run, seen }
            : undefined
        },
        60000,
        'the tools run',
      )
    }
    const use = (run: Json): Json =>
      run.stages.find((stage: Json) => stage.name === 'use')

    it('U8.5/U8.7 installs missing tools while the stage is preparing, then runs with them first on PATH', async () => {
      const run = await runWith('node')
      assert.equal(
        run.status,
        'succeeded',
        c.master.master!.scheduler.logs(run.id),
      )
      assert(run.seen.has('use:preparing'), [...run.seen].join(' '))
      const output = use(run).output
      assert.equal(output.nodeVersion, 'v24.11.1')
      assert.match(output.nodeBinary, /tools\/node\/24\.11\.1\/bin\/node$/)
      assert.match(output.javaHome, /tools\/java\/21\.0\.5/)
      const log = c.master.master!.scheduler.logs(run.id)!
      assert.match(
        log,
        /── Preparing use on (tooled|bare): installing node 24, java 21 ──/,
      )
      assert.match(log, /Verified sha256/)
      const worker = output.node as string
      const inventory = JSON.parse(
        String(
          c.master
            .master!.database.db.prepare(
              'SELECT inventory FROM worker_inventory WHERE fingerprint=?',
            )
            .get(c.fingerprint(worker))!.inventory,
        ),
      )
      assert.deepEqual(inventory.tools.node, ['24.11.1'])
      // The worker that has the tools now is preferred, and nothing is installed again.
      const again = await runWith('node')
      assert.equal(use(again).output.node, worker)
      assert(!again.seen.has('use:preparing'))
    })

    it('U1.3 a stage with tools project runs with the Node.js and Rust the repository pins', async () => {
      const run = await runWith('project')
      const log = c.master.master!.scheduler.logs(run.id)!
      assert.equal(run.status, 'succeeded', log)
      assert.match(log, /node 24 from \.nvmrc for tools\.node 'project'/)
      assert.match(
        log,
        /rust 1\.82\.0 from rust-toolchain\.toml for tools\.rust 'project'/,
      )
      assert.match(use(run).output.cargo, /tools\/rust\/1\.82\.0\/cargo$/)
      const output = use(run).output
      assert.equal(output.nodeVersion, 'v24.11.1')
      assert.match(output.nodeBinary, /tools\/node\/24\.11\.1\/bin\/node$/)
    })

    it('U2.3 Python and Go come from .python-version and go.mod; another stage on the node runs its own Python', async () => {
      const run = await runWith('pygo')
      const log = c.master.master!.scheduler.logs(run.id)!
      assert.equal(run.status, 'succeeded', log)
      assert.match(log, /python 3\.13 from \.python-version/)
      assert.match(log, /go 1\.22 from go\.mod/)
      assert.equal(use(run).output.python, 'Python 3.13.1')
      assert.equal(use(run).output.go, 'go version go1.22.9')
      const other = await runWith('py312')
      assert.equal(other.status, 'succeeded')
      assert.equal(use(other).output.node, use(run).output.node)
      assert.equal(use(other).output.python, 'Python 3.12.7')
    })

    it('U8.5 fails the stage with the installer log when an install fails', async () => {
      served.corrupt.add('/android/commandlinetools.zip')
      try {
        await c.master.master!.settings.set(
          { role: 'admin', label: 'paul' },
          'nodeTypes',
          {
            'mac-xcode': { androidLicensesAccepted: true },
          },
        )
        const run = await runWith('android')
        assert.equal(run.status, 'failed')
        assert.match(
          use(run).reason,
          /Checksum mismatch for commandlinetools\.zip/,
        )
        assert.match(
          c.master.master!.scheduler.logs(run.id)!,
          /Downloading .*commandlinetools\.zip/,
        )
      } finally {
        served.corrupt.clear()
      }
      const accepted = c.master.master!.settings.value('nodeTypes')![
        'mac-xcode'
      ] as Json
      assert.deepEqual(Object.keys(accepted.androidLicensesAccepted), [
        'by',
        'at',
      ])
      assert.equal(accepted.androidLicensesAccepted.by, 'paul')
      const ok = await runWith('android')
      assert.equal(
        ok.status,
        'succeeded',
        c.master.master!.scheduler.logs(ok.id),
      )
      assert.match(use(ok).output.android, /tools\/android\/sdk$/)
      await c.master.master!.settings.set(
        { role: 'admin', label: 'paul' },
        'nodeTypes',
        { 'mac-xcode': {} },
      )
      assert.equal(
        c.master.master!.settings.value('nodeTypes')!['mac-xcode'] != null,
        true,
      )
      await assert.rejects(
        c.master.master!.settings.set(
          { role: 'admin', label: 'paul' },
          'nodeTypes',
          { 'mac-xcode': { androidLicensesAccepted: 'yes' } },
        ),
        /true or false/,
      )
      await assert.rejects(
        c.master.master!.settings.set(
          { role: 'admin', label: 'paul' },
          'nodeTypes',
          [],
        ),
        /maps node type names/,
      )
      await assert.rejects(
        c.master.master!.settings.set(
          { role: 'admin', label: 'paul' },
          'nodeTypes',
          { 'Bad Type': {} },
        ),
        /Invalid node type/,
      )
    })

    it('U8.4/U8.7 runs on the node with the Xcode a range needs, and fails when no connected node has one', async () => {
      const run = await runWith('xcode')
      assert.equal(
        run.status,
        'succeeded',
        c.master.master!.scheduler.logs(run.id),
      )
      assert.equal(use(run).output.node, 'tooled')
      assert.equal(
        use(run).output.developerDir,
        path.join(apps, 'Xcode-26.1.app', 'Contents', 'Developer'),
      )
      const none = await runWith('nox')
      assert.equal(none.status, 'failed')
      assert.equal(
        use(none).reason,
        'No connected node for this stage has or can install an Xcode matching 99',
      )
    })

    it('U8.6 refuses an install outside the closed set over the link', async () => {
      const link = c.master.master!.registry.link(c.fingerprint('bare'))!
      const answer = (await link.request('tools.install', {
        tool: 'perl',
        version: '5',
      })) as Json
      assert.equal(answer.ok, false)
      assert.equal(answer.error, 'perl is not a tool Mason installs')
      assert.deepEqual(Object.keys(answer.inventory.tools), [
        'node',
        'rust',
        'java',
        'python',
        'go',
        'android',
      ])
    })
  })
})
