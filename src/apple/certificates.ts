import { execFile } from 'node:child_process'
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  pbkdf2Sync,
  X509Certificate,
} from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { MasterDatabase } from '../master/database.js'
import type { AppStoreConnect } from './connect.js'

export const certificateKinds = [
  'development',
  'distribution',
  'developerIdApplication',
  'developerIdInstaller',
] as const
export type CertificateKind = (typeof certificateKinds)[number]

/** App Store Connect's certificate types for the kinds Mason signs with. */
const appleTypes: Record<CertificateKind, string> = {
  development: 'DEVELOPMENT',
  distribution: 'DISTRIBUTION',
  developerIdApplication: 'DEVELOPER_ID_APPLICATION',
  developerIdInstaller: 'DEVELOPER_ID_INSTALLER',
}

/** A certificate as the API shows it: never its private key. */
export interface CertificateView {
  id: number
  team: string
  kind: CertificateKind
  appleId?: string
  serial: string
  name: string
  sha1: string
  expiresAt: number
  source: 'p12' | 'match' | 'created'
  revoked: boolean
}

/** The signing identity a stage receives: the certificate and its key, PEM. */
export interface Identity {
  name: string
  sha1: string
  certificate: string
  privateKey: string
}

/** Runs a tool with input on stdin and secrets in its environment only. */
export type Tool = (
  file: string,
  args: string[],
  options?: { input?: Buffer | string; env?: NodeJS.ProcessEnv },
) => Promise<Buffer>
export const runTool: Tool = async (file, args, options = {}) =>
  await new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error != null)
          reject(
            new Error(
              `${path.basename(file)} ${args[0]} failed: ${stderr.toString().trim().split('\n').pop() ?? error.message}`,
            ),
          )
        else resolve(stdout)
      },
    )
    child.stdin?.end(options.input ?? '')
  })

/**
 * Runs a tool whose arguments name `/dev/stdin` with its input in a private
 * file instead: Node hands a child its stdin as a socket on Linux, which
 * `/dev/stdin` cannot open. The file is removed when the tool ends.
 */
export async function fileInput(
  args: string[],
  input: Buffer | string,
  scratch: string,
  run: (args: string[]) => Promise<Buffer>,
): Promise<Buffer> {
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(path.join(scratch, 'input-'))
  try {
    const file = path.join(dir, 'input')
    writeFileSync(file, input, { mode: 0o600 })
    return await run(args.map((arg) => (arg === '/dev/stdin' ? file : arg)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The kind a certificate's common name says it is. */
export function kindOf(commonName: string): CertificateKind {
  if (/^(Apple Development|iPhone Developer|Mac Developer):/.test(commonName))
    return 'development'
  if (/^(Apple Distribution|iPhone Distribution):/.test(commonName))
    return 'distribution'
  if (/^Developer ID Application:/.test(commonName))
    return 'developerIdApplication'
  if (/^Developer ID Installer:/.test(commonName)) return 'developerIdInstaller'
  throw new Error(`${commonName} is not a signing certificate Mason uses`)
}

const field = (subject: string, name: string): string | undefined =>
  subject
    .split('\n')
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)

/**
 * Decrypts a file from a Fastlane Match repository: version 2
 * (`match_encrypted_v2__`, PBKDF2-SHA256 and AES-256-GCM) or version 1
 * (`Salted__`, OpenSSL's AES-256-CBC key derivation with MD5, then SHA-256).
 */
export function matchDecrypt(base64: string, passphrase: string): Buffer {
  const stored = Buffer.from(base64, 'base64')
  const v2 = Buffer.from('match_encrypted_v2__')
  if (stored.subarray(0, v2.length).equals(v2)) {
    const salt = stored.subarray(20, 28)
    const tag = stored.subarray(28, 44)
    const material = pbkdf2Sync(
      passphrase,
      salt,
      10_000,
      32 + 12 + 24,
      'sha256',
    )
    const decipher = createDecipheriv(
      'aes-256-gcm',
      material.subarray(0, 32),
      material.subarray(32, 44),
    )
    decipher.setAAD(material.subarray(44))
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([
        decipher.update(stored.subarray(44)),
        decipher.final(),
      ])
    } catch {
      throw new Error('The Match passphrase does not open this file')
    }
  }
  if (!stored.subarray(0, 8).equals(Buffer.from('Salted__')))
    throw new Error('Not a Fastlane Match file')
  const salt = stored.subarray(8, 16)
  for (const hash of ['md5', 'sha256']) {
    // OpenSSL's EVP_BytesToKey with one iteration.
    let derived = Buffer.alloc(0)
    let block = Buffer.alloc(0)
    while (derived.length < 48) {
      block = createHash(hash)
        .update(Buffer.concat([block, Buffer.from(passphrase), salt]))
        .digest()
      derived = Buffer.concat([derived, block])
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-cbc',
        derived.subarray(0, 32),
        derived.subarray(32, 48),
      )
      return Buffer.concat([
        decipher.update(stored.subarray(16)),
        decipher.final(),
      ])
    } catch {
      continue
    }
  }
  throw new Error('The Match passphrase does not open this file')
}

/**
 * Signing certificates per Apple team, with their private keys, kept only
 * in the master database: imported from a `.p12` or a Fastlane Match
 * repository, or created with a key generated here and a CSR sent through
 * App Store Connect.
 */
export class Certificates {
  constructor(
    private readonly master: MasterDatabase,
    private readonly options: {
      connect: (team: string) => AppStoreConnect | undefined
      tool?: Tool
      openssl?: string
      /** Clones a Match repository into a directory. */
      clone?: (
        repository: string,
        branch: string,
        into: string,
      ) => Promise<void>
      scratch?: string
    },
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }
  private async openssl(
    args: string[],
    input?: Buffer | string,
    env?: NodeJS.ProcessEnv,
  ): Promise<Buffer> {
    const run = async (
      list: string[],
      stdin: Buffer | string | undefined,
    ): Promise<Buffer> =>
      await (this.options.tool ?? runTool)(
        this.options.openssl ?? 'openssl',
        list,
        {
          ...(stdin == null ? {} : { input: stdin }),
          ...(env == null ? {} : { env }),
        },
      )
    return input != null && args.includes('/dev/stdin')
      ? await fileInput(
          args,
          input,
          this.options.scratch ?? tmpdir(),
          async (list) => await run(list, undefined),
        )
      : await run(args, input)
  }

  list(): CertificateView[] {
    return this.db
      .prepare(
        'SELECT * FROM apple_certificates ORDER BY team_id,kind,expires_at DESC',
      )
      .all()
      .map((row) => view(row))
  }

  /** Imports a `.p12` (certificate and private key) with its password. */
  async importP12(
    team: string,
    p12: Buffer,
    password: string,
  ): Promise<CertificateView> {
    const read = async (what: string[]): Promise<string> => {
      const args = [
        'pkcs12',
        '-in',
        '/dev/stdin',
        ...what,
        '-passin',
        'env:MASON_P12_PASSWORD',
      ]
      const env = { MASON_P12_PASSWORD: password }
      try {
        return (await this.openssl(args, p12, env)).toString()
      } catch {
        // Older keychain exports use ciphers OpenSSL 3 keeps in its legacy provider.
        try {
          return (await this.openssl([...args, '-legacy'], p12, env)).toString()
        } catch {
          throw new Error(
            'The .p12 password is wrong or the file is not a .p12',
          )
        }
      }
    }
    const certificate = await read(['-clcerts', '-nokeys'])
    const privateKey = await read(['-nocerts', '-nodes'])
    return await this.store(team, certificate, privateKey, 'p12')
  }

  /**
   * Imports the certificates of a Fastlane Match repository: each
   * `certs/<type>/<certificate ID>.cer` with its key in `.p12`.
   */
  async importMatch(
    team: string,
    repository: string,
    passphrase: string,
    branch = 'master',
  ): Promise<CertificateView[]> {
    if (this.options.clone == null)
      throw new Error('Match import is unavailable')
    const dir = mkdtempSync(
      path.join(this.options.scratch ?? tmpdir(), 'match-'),
    )
    try {
      await this.options.clone(repository, branch, dir)
      const out: CertificateView[] = []
      const certs = path.join(dir, 'certs')
      for (const type of safeList(certs)) {
        for (const file of safeList(path.join(certs, type))) {
          if (!file.endsWith('.cer')) continue
          const id = file.slice(0, -4)
          const keyFile = path.join(certs, type, `${id}.p12`)
          if (!/^[A-Z0-9]{10}$/.test(id) || !safeFile(keyFile)) continue
          const der = matchDecrypt(
            readFileSync(path.join(certs, type, file), 'utf8'),
            passphrase,
          )
          const keyP12 = matchDecrypt(readFileSync(keyFile, 'utf8'), passphrase)
          const privateKey = (
            await this.openssl(
              [
                'pkcs12',
                '-in',
                '/dev/stdin',
                '-nocerts',
                '-nodes',
                '-passin',
                'pass:',
              ],
              keyP12,
            ).catch(
              async () =>
                await this.openssl(
                  [
                    'pkcs12',
                    '-in',
                    '/dev/stdin',
                    '-nocerts',
                    '-nodes',
                    '-passin',
                    'pass:',
                    '-legacy',
                  ],
                  keyP12,
                ),
            )
          ).toString()
          out.push(
            await this.store(
              team,
              new X509Certificate(der).toString(),
              privateKey,
              'match',
              id,
            ),
          )
        }
      }
      if (out.length === 0)
        throw new Error('The Match repository holds no certificates')
      return out
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Makes a certificate: a key generated here and a CSR sent through App Store Connect. */
  async create(team: string, kind: CertificateKind): Promise<CertificateView> {
    const connect = this.options.connect(team)
    if (connect == null)
      throw new Error(`Team ${team} has no App Store Connect key`)
    const privateKey = (
      await this.openssl([
        'genpkey',
        '-algorithm',
        'RSA',
        '-pkeyopt',
        'rsa_keygen_bits:2048',
      ])
    ).toString()
    const csr = (
      await this.openssl(
        [
          'req',
          '-new',
          '-key',
          '/dev/stdin',
          '-subj',
          `/CN=Mason ${team}/O=${team}`,
          '-outform',
          'PEM',
        ],
        privateKey,
      )
    ).toString()
    const created = await connect.request<{
      data: { id: string; attributes: { certificateContent: string } }
    }>('POST', '/v1/certificates', {
      data: {
        type: 'certificates',
        attributes: { certificateType: appleTypes[kind], csrContent: csr },
      },
    })
    const der = Buffer.from(
      created.data.attributes.certificateContent,
      'base64',
    )
    return await this.store(
      team,
      new X509Certificate(der).toString(),
      privateKey,
      'created',
      created.data.id,
    )
  }

  private async store(
    team: string,
    certificatePem: string,
    privateKeyPem: string,
    source: CertificateView['source'],
    appleId?: string,
  ): Promise<CertificateView> {
    const certificate = new X509Certificate(certificatePem)
    const key = createPrivateKey(privateKeyPem)
    if (!certificate.checkPrivateKey(key))
      throw new Error('The private key does not belong to the certificate')
    const name = field(certificate.subject, 'CN') ?? ''
    const kind = kindOf(name)
    const unit = field(certificate.subject, 'OU')
    if (unit != null && unit !== team)
      throw new Error(`The certificate belongs to team ${unit}, not ${team}`)
    const serial = certificate.serialNumber.toUpperCase()
    const id =
      appleId ?? (await this.lookup(team, serial).catch(() => undefined))
    const sha1 = certificate.fingerprint.replaceAll(':', '').toUpperCase()
    this.db
      .prepare(
        'INSERT INTO apple_certificates(team_id,kind,apple_id,serial,name,sha1,certificate,private_key,expires_at,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(team_id,serial) DO UPDATE SET apple_id=COALESCE(excluded.apple_id,apple_id),private_key=excluded.private_key,revoked=0',
      )
      .run(
        team,
        kind,
        id ?? null,
        serial,
        name,
        sha1,
        certificate.toString(),
        key.export({ type: 'pkcs8', format: 'pem' }).toString(),
        Date.parse(certificate.validTo),
        source,
        this.master.now(),
      )
    return view(
      this.db
        .prepare(
          'SELECT * FROM apple_certificates WHERE team_id=? AND serial=?',
        )
        .get(team, serial)!,
    )
  }

  /** The certificate's ID in App Store Connect, by serial number. */
  private async lookup(
    team: string,
    serial: string,
  ): Promise<string | undefined> {
    const connect = this.options.connect(team)
    if (connect == null) return undefined
    const found = await connect.all(
      `/v1/certificates?filter[serialNumber]=${encodeURIComponent(serial)}`,
    )
    return found[0]?.id
  }

  /** Marks certificates App Store Connect no longer lists as revoked. */
  async sync(team: string): Promise<void> {
    const connect = this.options.connect(team)
    if (connect == null) return
    const listed = new Set(
      (await connect.all('/v1/certificates?limit=200')).map((item) => item.id),
    )
    for (const row of this.db
      .prepare(
        'SELECT id,serial,apple_id FROM apple_certificates WHERE team_id=? AND revoked=0',
      )
      .all(team)) {
      let appleId = row.apple_id as string | null
      if (appleId == null) {
        appleId = (await this.lookup(team, String(row.serial))) ?? null
        if (appleId != null)
          this.db
            .prepare('UPDATE apple_certificates SET apple_id=? WHERE id=?')
            .run(appleId, Number(row.id))
      }
      if (appleId != null && !listed.has(appleId))
        this.db
          .prepare('UPDATE apple_certificates SET revoked=1 WHERE id=?')
          .run(Number(row.id))
    }
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM apple_certificates WHERE id=?').run(id)
  }

  /** The newest usable certificate of a kind for a team. */
  current(team: string, kind: CertificateKind): CertificateView | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM apple_certificates WHERE team_id=? AND kind=? AND revoked=0 AND expires_at>? ORDER BY expires_at DESC LIMIT 1',
      )
      .get(team, kind, this.master.now())
    return row == null ? undefined : view(row)
  }

  /** The certificate and key a stage signs with. */
  identity(id: number): Identity {
    const row = this.db
      .prepare(
        'SELECT name,sha1,certificate,private_key FROM apple_certificates WHERE id=?',
      )
      .get(id)
    if (row == null) throw new Error('No such certificate')
    return {
      name: String(row.name),
      sha1: String(row.sha1),
      certificate: String(row.certificate),
      privateKey: String(row.private_key),
    }
  }

  /** Certificates expiring within 30 days, for the master's notices. */
  expiring(): string[] {
    return this.db
      .prepare(
        'SELECT name,expires_at FROM apple_certificates WHERE revoked=0 AND expires_at<=? ORDER BY expires_at',
      )
      .all(this.master.now() + 30 * 24 * 60 * 60 * 1000)
      .map((row) =>
        Number(row.expires_at) <= this.master.now()
          ? `The certificate ${String(row.name)} has expired`
          : `The certificate ${String(row.name)} expires on ${new Date(Number(row.expires_at)).toISOString().slice(0, 10)}`,
      )
  }
}

function view(row: Record<string, unknown>): CertificateView {
  return {
    id: Number(row.id),
    team: String(row.team_id),
    kind: row.kind as CertificateKind,
    ...(row.apple_id == null ? {} : { appleId: String(row.apple_id) }),
    serial: String(row.serial),
    name: String(row.name),
    sha1: String(row.sha1),
    expiresAt: Number(row.expires_at),
    source: row.source as CertificateView['source'],
    revoked: Number(row.revoked) === 1,
  }
}
const safeList = (dir: string): string[] => {
  try {
    return statSync(dir).isDirectory() ? readdirSync(dir).sort() : []
  } catch {
    return []
  }
}
const safeFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}
