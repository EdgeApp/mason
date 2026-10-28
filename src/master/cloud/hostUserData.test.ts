import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import { asHostInput, fqdn, hostUserData } from './hosts.js'

/**
 * Runs a host's first-boot script against a fake root, with `curl`,
 * `apt-get`, `gpg`, `systemctl`, `caddy` and `mason` stubbed; each stub logs
 * its arguments.
 */
function boot(script: string): { root: string; calls: () => string[] } {
  const root = mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'host-boot-'),
  )
  const bin = path.join(root, 'stub-bin')
  for (const dir of [
    'root',
    'etc/caddy',
    'etc/apt/sources.list.d',
    'usr/share/keyrings',
    'stub-bin',
  ])
    mkdirSync(path.join(root, dir), { recursive: true })
  const log = path.join(root, 'calls.log')
  const stub = (name: string, body = ''): void => {
    writeFileSync(
      path.join(bin, name),
      `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`,
    )
    chmodSync(path.join(bin, name), 0o755)
  }
  // curl writes the installer, or prints the droplet's address for metadata.
  stub(
    'curl',
    `out=''; for ((i=1; i<=$#; i++)); do if [[ \${!i} == -o ]]; then j=$((i+1)); out=\${!j}; fi; done
case "$*" in *169.254.169.254*) echo 203.0.113.20; exit 0 ;; esac
if [[ -n $out ]]; then echo 'echo installed "$@"' > "$out"; else echo stub; fi`,
  )
  stub('gpg', 'cat > /dev/null')
  stub(
    'apt-get',
    `case "$*" in *install*caddy*) touch ${JSON.stringify(path.join(bin, 'caddy-installed'))} ;; esac`,
  )
  stub('systemctl')
  // `command -v caddy` finds it only once apt-get installed it.
  stub(
    'mason',
    `mkdir -p "$MASON_HOST_ROOT/var/lib/mason/.mason" && touch "$MASON_HOST_ROOT/var/lib/mason/.mason/identity.key"`,
  )
  const run = (): void => {
    if (existsSync(path.join(bin, 'caddy-installed'))) stub('caddy')
    execFileSync('/bin/bash', ['-c', script], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        MASON_HOST_ROOT: root,
      },
    })
  }
  run()
  run()
  return {
    root,
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
  }
}

describe('A cloud host’s first boot', function () {
  this.timeout(30_000)

  it('U4.4 installs the pinned release and Caddy, pairs the host once, and serves the DNS name or the address', () => {
    const pairing = JSON.stringify({
      cert: 'CERT',
      key: 'KEY',
      secret: 'SECRET',
    })
    const named = boot(
      hostUserData({
        repository: 'example/mason',
        version: '0.2.0-dev.4',
        pairing,
        dnsName: 'builds.example.com',
        linkPort: 9310,
      }),
    )
    const calls = named.calls()
    assert(
      calls.includes(
        `curl -fsSL https://github.com/example/mason/releases/latest/download/install.sh -o ${named.root}/root/mason-install.sh`,
      ),
    )
    // Caddy is installed once; Mason's host is installed once, with the pairing file.
    assert.equal(
      calls.filter((call) => /^apt-get .* install caddy$/.test(call)).length,
      1,
    )
    const installs = calls.filter((call) =>
      call.startsWith('mason host --install'),
    )
    assert.deepEqual(installs, [
      `mason host --install --pairing-file ${named.root}/root/mason-pairing.json --listen 127.0.0.1 --port 9200 --web-plain --link-listen 0.0.0.0 --link-port 9310`,
    ])
    assert.equal(
      calls.filter((call) => call.startsWith('systemctl reload caddy')).length,
      2,
    )
    assert.equal(
      readFileSync(path.join(named.root, 'etc/caddy/Caddyfile'), 'utf8'),
      'builds.example.com {\n\treverse_proxy 127.0.0.1:9200\n}\n',
    )
    // The pairing material and the installer do not stay on disk.
    assert(!existsSync(path.join(named.root, 'root/mason-pairing.json')))
    assert(!existsSync(path.join(named.root, 'root/mason-install.sh')))
    const script = hostUserData({
      repository: 'example/mason',
      version: '0.2.0-dev.4',
      pairing,
      linkPort: 9310,
    })
    assert.match(
      script,
      /bash "\$root\/root\/mason-install.sh" --version 0\.2\.0-dev\.4/,
    )
    assert.match(script, /^SECRET|"secret":"SECRET"/m)
    const bare = boot(script)
    assert.equal(
      readFileSync(path.join(bare.root, 'etc/caddy/Caddyfile'), 'utf8'),
      'https://203.0.113.20 {\n\ttls internal\n\treverse_proxy 127.0.0.1:9200\n}\n',
    )
  })

  it('validates a host to make and names its DNS record', () => {
    const host = asHostInput({
      name: 'test-host',
      account: 'digitalocean',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      dns: { domain: 'example.com', name: 'builds.test' },
    })
    assert.deepEqual(host, {
      name: 'test-host',
      account: 'digitalocean',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
      dns: { domain: 'example.com', name: 'builds.test' },
    })
    assert.equal(
      asHostInput({ ...host, image: 'debian-12-x64' }).image,
      'debian-12-x64',
    )
    assert.throws(
      () => asHostInput({ ...host, name: 'Bad Name' }),
      /host.name is invalid/,
    )
    assert.throws(() => asHostInput(undefined), /host.name is invalid/)
    assert.throws(
      () =>
        asHostInput({ ...host, dns: { domain: 'not a domain', name: 'x' } }),
      /host.dns.domain is a domain name/,
    )
    assert.throws(
      () =>
        asHostInput({ ...host, dns: { domain: 'example.com', name: 'a..b' } }),
      /host.dns.name is a record name/,
    )
    assert.equal(
      fqdn({ dns_domain: 'example.com', dns_name: 'builds' }),
      'builds.example.com',
    )
    assert.equal(
      fqdn({ dns_domain: 'example.com', dns_name: '@' }),
      'example.com',
    )
    assert.equal(fqdn({ dns_domain: null, dns_name: null }), undefined)
  })
})
