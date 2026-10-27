import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Identity } from '../node/identity.js'
import {
  compareSemver,
  fileSha256,
  signRelease,
  type ReleaseManifest,
} from '../release/install.js'
import { repository } from '../version.js'
import type { MasterDatabase } from './database.js'

const tarball =
  /^mason-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(darwin|linux)-(arm64|x64)\.tar\.gz$/

export interface StoredRelease {
  version: string
  platforms: string[]
  current: boolean
}

export interface SignedRelease extends ReleaseManifest {
  signature: string
  file: string
}

/** Reads `SHA256SUMS`: file name → digest. */
function sums(dir: string): Map<string, string> {
  const file = path.join(dir, 'SHA256SUMS')
  if (!existsSync(file)) throw new Error(`${dir} has no SHA256SUMS`)
  const out = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const match = /^([0-9a-f]{64}) [ *]?([A-Za-z0-9._-]+)$/.exec(line.trim())
    if (match == null)
      throw new Error(`SHA256SUMS has an unreadable line: ${line}`)
    out.set(match[2]!, match[1]!)
  }
  return out
}

/**
 * The master's release store, `<data>/releases/<version>/`: the releases
 * it serves through the host and pushes to workers. One is current.
 */
export class Releases {
  constructor(
    private readonly master: MasterDatabase,
    readonly root: string,
    private readonly identity: Identity,
    readonly ownVersion: string,
  ) {}

  versions(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter((name) => existsSync(path.join(this.root, name, 'SHA256SUMS')))
      .sort(compareSemver)
  }

  /** The platforms a stored release has tarballs for, `linux-x64`. */
  platforms(version: string): string[] {
    return readdirSync(path.join(this.root, version))
      .map((name) => tarball.exec(name))
      .filter((match): match is RegExpExecArray => match != null)
      .map((match) => `${match[2]}-${match[3]}`)
      .sort()
  }

  /** A stored release's files and their SHA-256 digests. */
  files(version: string): Record<string, string> {
    return Object.fromEntries(sums(path.join(this.root, version)))
  }

  list(): StoredRelease[] {
    const current = this.current()
    return this.versions().map((version) => ({
      version,
      platforms: this.platforms(version),
      current: version === current,
    }))
  }

  /**
   * Adds a release directory (the output of `scripts/release.ts`): every file
   * `SHA256SUMS` lists must be present and match, and the tarballs must be one
   * version. With `partial`, files absent from the directory are left out (the
   * copy `install.sh` keeps beside an install holds only its own platform).
   */
  async add(dir: string, options: { partial?: boolean } = {}): Promise<string> {
    const listed = sums(dir)
    let version: string | undefined
    const present: string[] = []
    for (const [name, digest] of listed) {
      const file = path.join(dir, name)
      if (!existsSync(file)) {
        if (options.partial) continue
        throw new Error(`${name} is listed in SHA256SUMS but missing`)
      }
      if ((await fileSha256(file)) !== digest)
        throw new Error(`${name} does not match SHA256SUMS`)
      const match = tarball.exec(name)
      if (match != null) {
        if (version != null && version !== match[1])
          throw new Error('The tarballs are of different versions')
        version = match[1]
      } else if (name !== 'install.sh')
        throw new Error(`${name} is not part of a Mason release`)
      present.push(name)
    }
    if (version == null) throw new Error('The release has no tarballs')
    if (!present.includes('install.sh'))
      throw new Error('The release has no install.sh')
    const target = path.join(this.root, version)
    const partial = `${target}.partial`
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true, mode: 0o700 })
    for (const name of present)
      copyFileSync(path.join(dir, name), path.join(partial, name))
    writeFileSync(
      path.join(partial, 'SHA256SUMS'),
      present.map((name) => `${listed.get(name)!}  ${name}`).join('\n') + '\n',
    )
    rmSync(target, { recursive: true, force: true })
    renameSync(partial, target)
    this.master.change('release', version)
    return version
  }

  /** Downloads a GitHub release of Mason's repository (`owner/name`) into the store. */
  async fetch(
    tag: string,
    token: string | undefined,
    scratch: string,
    api = 'https://api.github.com',
    repo: string | undefined = repository,
  ): Promise<string> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(tag)) throw new Error('Invalid tag')
    if (repo == null || !/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(
        'Name the repository releases come from (owner/name) with --repo, or in package.json',
      )
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token == null ? {} : { Authorization: `Bearer ${token}` }),
    }
    const response = await fetch(`${api}/repos/${repo}/releases/tags/${tag}`, {
      headers,
    })
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} for release ${tag}`)
    const release = (await response.json()) as {
      assets: Array<{ name: string; url: string }>
    }
    const dir = path.join(scratch, `release-${tag}-${process.pid}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      for (const asset of release.assets) {
        if (
          asset.name !== 'SHA256SUMS' &&
          asset.name !== 'install.sh' &&
          !tarball.test(asset.name)
        )
          continue
        const body = await fetch(asset.url, {
          headers: { ...headers, Accept: 'application/octet-stream' },
        })
        if (!body.ok)
          throw new Error(`GitHub answered ${body.status} for ${asset.name}`)
        writeFileSync(
          path.join(dir, asset.name),
          Buffer.from(await body.arrayBuffer()),
        )
      }
      return await this.add(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  setCurrent(version: string): void {
    if (!this.versions().includes(version))
      throw new Error(`Release ${version} is not in the store`)
    this.master.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('release_current',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(version)
    this.master.change('release', 'current')
  }

  /** The current release: the one set, else the master's own version when stored. */
  current(): string | undefined {
    const row = this.master.db
      .prepare("SELECT value FROM meta WHERE key='release_current'")
      .get()
    const set = row == null ? undefined : String(row.value)
    if (set != null && this.versions().includes(set)) return set
    return this.versions().includes(this.ownVersion)
      ? this.ownVersion
      : undefined
  }

  /** Stores the release `install.sh` left beside the master's own install, when there is one. */
  async importOwn(appRoot: string): Promise<string | undefined> {
    const copy = path.join(appRoot, 'release')
    if (
      this.versions().includes(this.ownVersion) ||
      !existsSync(path.join(copy, 'SHA256SUMS'))
    )
      return undefined
    return await this.add(copy, { partial: true })
  }

  /** A stored tarball with the master's signature over its version, platform and digest. */
  async signed(
    version: string,
    platform: string,
  ): Promise<SignedRelease | undefined> {
    const file = path.join(
      this.root,
      version,
      `mason-${version}-${platform}.tar.gz`,
    )
    if (!existsSync(file)) return undefined
    const manifest = {
      version,
      platform,
      sha256: sums(path.join(this.root, version)).get(path.basename(file))!,
    }
    return {
      ...manifest,
      signature: signRelease(manifest, this.identity.privateKey),
      file,
    }
  }
}
