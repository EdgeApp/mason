import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  randomUUID,
  X509Certificate,
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Fake API resources are plain JSON documents.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>

/** A key pair standing in for an App Store Connect `.p8` key. */
export function fakeConnectKey(): {
  issuerId: string
  keyId: string
  privateKey: string
} {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    issuerId: randomUUID(),
    keyId: 'FAKEKEY123',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** A certificate signed by a throwaway CA, as Apple returns one for a CSR or an import. */
export function fakeSigningCertificate(
  commonName: string,
  team: string,
  options: { csr?: string; days?: number } = {},
): { certificate: string; privateKey?: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-apple-cert-'))
  try {
    const run = (args: string[], input?: string): string =>
      execFileSync('openssl', args, {
        cwd: dir,
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    let privateKey: string | undefined
    let csr = options.csr
    if (csr == null) {
      run([
        'genpkey',
        '-algorithm',
        'RSA',
        '-pkeyopt',
        'rsa_keygen_bits:2048',
        '-out',
        'key.pem',
      ])
      privateKey = readFileSync(path.join(dir, 'key.pem'), 'utf8')
      csr = run(['req', '-new', '-key', 'key.pem', '-subj', '/CN=x'])
    }
    writeFileSync(path.join(dir, 'request.csr'), csr)
    writeFileSync(
      path.join(dir, 'ext.cnf'),
      'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n',
    )
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=Fake Apple CA',
    ])
    run([
      'x509',
      '-req',
      '-in',
      'request.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      String(Math.floor(Math.random() * 2 ** 40)),
      '-days',
      String(options.days ?? 365),
      '-extfile',
      'ext.cnf',
      '-subj',
      `/CN=${commonName}/OU=${team}/O=Fake Team/C=US`,
      '-out',
      'cert.pem',
    ])
    return {
      certificate: readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
      ...(privateKey == null ? {} : { privateKey }),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * A fake App Store Connect and notary service over plain HTTP: it checks
 * each JWT against the key, pages lists two at a time, and records every
 * call. Build uploads become valid after `processingPolls` status reads;
 * notary submissions are accepted, or rejected when the file's name says so.
 */
export class FakeAppleConnect {
  server!: Server
  origin = ''
  readonly calls: Array<{ method: string; path: string; body?: Doc }> = []
  readonly certificates = new Map<string, Doc>()
  readonly bundleIds = new Map<string, Doc>()
  readonly capabilities = new Map<string, string[]>()
  readonly devices: Doc[] = []
  readonly profiles = new Map<string, Doc>()
  readonly apps: Doc[] = []
  readonly groups: Doc[] = []
  readonly uploads = new Map<string, Doc>()
  readonly builds = new Map<string, Doc>()
  readonly submissions = new Map<string, Doc>()
  readonly uploaded = new Map<string, Buffer>()
  readonly s3: Array<{ path: string; headers: Doc; size: number }> = []
  /** Answers the next request with 429 this many times. */
  throttle = 0
  processingPolls = 1
  profileDays = 365
  readonly team: string
  private nextId = 1

  constructor(
    readonly key: { issuerId: string; keyId: string; privateKey: string },
    team = 'ABCDE12345',
  ) {
    this.team = team
  }

  id(prefix: string): string {
    return `${prefix}${String(this.nextId++).padStart(4, '0')}`
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req)
        .then(({ status, json, headers }) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            ...headers,
          })
          res.end(json === undefined ? '' : JSON.stringify(json))
        })
        .catch((error: unknown) => {
          res.writeHead(500)
          res.end(
            JSON.stringify({
              errors: [{ title: 'Fake failure', detail: String(error) }],
            }),
          )
        })
    })
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    )
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }
  async close(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve))
  }

  /** Bases for the master's `apple` setting endpoints. */
  get endpoints(): { api: string; notary: string; s3: string } {
    return {
      api: this.origin,
      notary: `${this.origin}/notary/v2`,
      s3: `${this.origin}/s3`,
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const match = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(
      req.headers.authorization ?? '',
    )
    if (match == null) return false
    const header = JSON.parse(
      Buffer.from(match[1]!, 'base64url').toString(),
    ) as Doc
    const claims = JSON.parse(
      Buffer.from(match[2]!, 'base64url').toString(),
    ) as Doc
    const verified = createVerify('sha256')
      .update(`${match[1]}.${match[2]}`)
      .verify(
        {
          key: createPublicKey(this.key.privateKey),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(match[3]!, 'base64url'),
      )
    return (
      verified &&
      header.alg === 'ES256' &&
      header.kid === this.key.keyId &&
      claims.iss === this.key.issuerId &&
      claims.aud === 'appstoreconnect-v1' &&
      claims.exp - claims.iat <= 1200
    )
  }

  /** A JSON:API page of a list, two items at a time. */
  private page(url: URL, items: Doc[]): Doc {
    const start = Number(url.searchParams.get('cursor') ?? 0)
    const next = new URL(url)
    next.searchParams.set('cursor', String(start + 2))
    return {
      data: items.slice(start, start + 2),
      ...(start + 2 < items.length ? { links: { next: next.href } } : {}),
    }
  }

  private async handle(req: IncomingMessage): Promise<{
    status: number
    json?: unknown
    headers?: Record<string, string>
  }> {
    const url = new URL(req.url ?? '/', this.origin)
    const raw = await body(req)
    const method = req.method ?? 'GET'
    const p = url.pathname
    if (p.startsWith('/upload/')) {
      this.uploaded.set(p, raw)
      return { status: 200 }
    }
    if (p.startsWith('/notary-log/'))
      return {
        status: 200,
        json: {
          status: 'Invalid',
          issues: [{ message: 'The binary is not signed' }],
        },
      }
    if (p.startsWith('/s3/')) {
      this.s3.push({ path: p, headers: req.headers, size: raw.length })
      return req.headers['x-amz-security-token'] != null &&
        /^AWS4-HMAC-SHA256 Credential=FAKEACCESS\//.test(
          String(req.headers.authorization),
        )
        ? { status: 200 }
        : { status: 403 }
    }
    const json =
      raw.length === 0 ? undefined : (JSON.parse(raw.toString()) as Doc)
    this.calls.push({
      method,
      path: p + url.search,
      ...(json == null ? {} : { body: json }),
    })
    if (!this.authorized(req))
      return {
        status: 401,
        json: {
          errors: [
            {
              status: '401',
              code: 'NOT_AUTHORIZED',
              title: 'Authentication credentials are missing or invalid.',
            },
          ],
        },
      }
    if (this.throttle > 0) {
      this.throttle--
      return {
        status: 429,
        headers: { 'retry-after': '1' },
        json: { errors: [{ title: 'Rate limit' }] },
      }
    }
    const data = json?.data as Doc | undefined
    // Certificates.
    if (p === '/v1/certificates' && method === 'GET') {
      const serial = url.searchParams.get('filter[serialNumber]')
      const items = [...this.certificates.values()].filter(
        (item) => serial == null || item.attributes.serialNumber === serial,
      )
      return { status: 200, json: this.page(url, items) }
    }
    if (p === '/v1/certificates' && method === 'POST') {
      const kind = data!.attributes.certificateType as string
      const name =
        kind === 'DEVELOPMENT'
          ? 'Apple Development: Fake Developer (XYZ1234567)'
          : kind === 'DEVELOPER_ID_APPLICATION'
            ? `Developer ID Application: Fake Team (${this.team})`
            : `Apple Distribution: Fake Team (${this.team})`
      const made = fakeSigningCertificate(name, this.team, {
        csr: data!.attributes.csrContent as string,
      })
      const der = new X509Certificate(made.certificate).raw
      const item = this.addCertificate(made.certificate)
      return {
        status: 201,
        json: {
          data: {
            ...item,
            attributes: {
              ...item.attributes,
              certificateContent: der.toString('base64'),
            },
          },
        },
      }
    }
    // Bundle IDs and capabilities.
    if (p === '/v1/bundleIds' && method === 'GET') {
      const filter = url.searchParams.get('filter[identifier]') ?? ''
      // Apple's identifier filter matches prefixes too.
      const items = [...this.bundleIds.values()].filter((item) =>
        String(item.attributes.identifier).startsWith(filter),
      )
      return { status: 200, json: this.page(url, items) }
    }
    if (p === '/v1/bundleIds' && method === 'POST') {
      const id = this.id('BUNDLE')
      const item = { type: 'bundleIds', id, attributes: data!.attributes }
      this.bundleIds.set(id, item)
      return { status: 201, json: { data: item } }
    }
    const capabilityList =
      /^\/v1\/bundleIds\/([^/]+)\/bundleIdCapabilities$/.exec(p)
    if (capabilityList != null)
      return {
        status: 200,
        json: this.page(
          url,
          (this.capabilities.get(capabilityList[1]!) ?? []).map((type) => ({
            type: 'bundleIdCapabilities',
            id: `${capabilityList[1]}_${type}`,
            attributes: { capabilityType: type },
          })),
        ),
      }
    if (p === '/v1/bundleIdCapabilities' && method === 'POST') {
      const bundle = data!.relationships.bundleId.data.id as string
      this.capabilities.set(bundle, [
        ...(this.capabilities.get(bundle) ?? []),
        data!.attributes.capabilityType as string,
      ])
      return {
        status: 201,
        json: {
          data: {
            type: 'bundleIdCapabilities',
            id: this.id('CAP'),
            attributes: data!.attributes,
          },
        },
      }
    }
    // Devices and profiles.
    if (p === '/v1/devices')
      return {
        status: 200,
        json: this.page(
          url,
          this.devices.filter(
            (device) =>
              device.attributes.status ===
                url.searchParams.get('filter[status]') &&
              device.attributes.platform ===
                url.searchParams.get('filter[platform]'),
          ),
        ),
      }
    if (p === '/v1/profiles' && method === 'POST') {
      const id = this.id('PROFILE')
      const uuid = randomUUID().toUpperCase()
      const item = {
        type: 'profiles',
        id,
        attributes: {
          name: data!.attributes.name,
          profileType: data!.attributes.profileType,
          uuid,
          profileContent: Buffer.from(
            JSON.stringify({
              uuid,
              name: data!.attributes.name,
              relationships: data!.relationships,
            }),
          ).toString('base64'),
          expirationDate: new Date(
            Date.now() + this.profileDays * 86_400_000,
          ).toISOString(),
        },
        relationships: data!.relationships,
      }
      this.profiles.set(id, item)
      return { status: 201, json: { data: item } }
    }
    const profile = /^\/v1\/profiles\/([^/]+)$/.exec(p)
    if (profile != null && method === 'DELETE') {
      if (!this.profiles.delete(profile[1]!))
        return { status: 404, json: { errors: [{ title: 'Not found' }] } }
      return { status: 204 }
    }
    // Apps, build uploads and builds.
    if (p === '/v1/apps') {
      const bundle = url.searchParams.get('filter[bundleId]')
      return {
        status: 200,
        json: this.page(
          url,
          this.apps.filter((app) => app.attributes.bundleId === bundle),
        ),
      }
    }
    if (p === '/v1/buildUploads' && method === 'POST') {
      const id = this.id('UPLOAD')
      this.uploads.set(id, {
        id,
        attributes: { ...data!.attributes, state: 'AWAITING_UPLOAD' },
        polls: 0,
        app: data!.relationships.app.data.id,
      })
      return {
        status: 201,
        json: {
          data: { type: 'buildUploads', id, attributes: data!.attributes },
        },
      }
    }
    if (p === '/v1/buildUploadFiles' && method === 'POST') {
      const upload = data!.relationships.buildUpload.data.id as string
      const size = Number(data!.attributes.fileSize)
      const half = Math.ceil(size / 2)
      const id = this.id('FILE')
      this.uploads.get(upload)!.file = id
      return {
        status: 201,
        json: {
          data: {
            type: 'buildUploadFiles',
            id,
            attributes: {
              ...data!.attributes,
              uploadOperations: [
                {
                  method: 'PUT',
                  url: `${this.origin}/upload/${id}/1`,
                  offset: 0,
                  length: half,
                  requestHeaders: [
                    { name: 'Content-Type', value: 'application/octet-stream' },
                  ],
                },
                {
                  method: 'PUT',
                  url: `${this.origin}/upload/${id}/2`,
                  offset: half,
                  length: size - half,
                  requestHeaders: [
                    { name: 'Content-Type', value: 'application/octet-stream' },
                  ],
                },
              ],
            },
          },
        },
      }
    }
    const uploadFile = /^\/v1\/buildUploadFiles\/([^/]+)$/.exec(p)
    if (uploadFile != null && method === 'PATCH') {
      const upload = [...this.uploads.values()].find(
        (item) => item.file === uploadFile[1],
      )!
      upload.attributes.state = 'PROCESSING'
      return {
        status: 200,
        json: {
          data: {
            type: 'buildUploadFiles',
            id: uploadFile[1],
            attributes: { uploaded: true },
          },
        },
      }
    }
    const uploadRead = /^\/v1\/buildUploads\/([^/]+)$/.exec(p)
    if (uploadRead != null) {
      const upload = this.uploads.get(uploadRead[1]!)!
      if (upload.attributes.state === 'PROCESSING' && upload.build == null) {
        const build = this.id('BUILD')
        upload.build = build
        this.builds.set(build, {
          id: build,
          attributes: {
            processingState: 'PROCESSING',
            version: upload.attributes.cfBundleVersion,
          },
          polls: 0,
          app: upload.app,
          groups: [],
          localizations: [],
        })
      }
      return {
        status: 200,
        json: {
          data: {
            type: 'buildUploads',
            id: upload.id,
            attributes: { state: upload.attributes.state },
            relationships: {
              build: {
                data:
                  upload.build == null
                    ? null
                    : { type: 'builds', id: upload.build },
              },
            },
          },
        },
      }
    }
    const buildRead = /^\/v1\/builds\/([^/]+)$/.exec(p)
    if (buildRead != null) {
      const build = this.builds.get(buildRead[1]!)!
      if (method === 'PATCH') {
        Object.assign(build.attributes, data!.attributes)
        return { status: 200, json: { data: build } }
      }
      if (++build.polls >= this.processingPolls)
        build.attributes.processingState = 'VALID'
      return {
        status: 200,
        json: {
          data: { type: 'builds', id: build.id, attributes: build.attributes },
        },
      }
    }
    const localizations =
      /^\/v1\/builds\/([^/]+)\/betaBuildLocalizations$/.exec(p)
    if (localizations != null)
      return {
        status: 200,
        json: this.page(url, this.builds.get(localizations[1]!)!.localizations),
      }
    if (p === '/v1/betaBuildLocalizations' && method === 'POST') {
      const build = this.builds.get(data!.relationships.build.data.id)!
      const item = {
        type: 'betaBuildLocalizations',
        id: this.id('LOC'),
        attributes: data!.attributes,
      }
      build.localizations.push(item)
      return { status: 201, json: { data: item } }
    }
    const appGroups = /^\/v1\/apps\/([^/]+)\/betaGroups$/.exec(p)
    if (appGroups != null)
      return {
        status: 200,
        json: this.page(
          url,
          this.groups.filter((group) => group.app === appGroups[1]),
        ),
      }
    const groupBuilds =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds$/.exec(p)
    if (groupBuilds != null) {
      for (const entry of data as unknown as Doc[])
        this.builds.get(entry.id)!.groups.push(groupBuilds[1])
      return { status: 204 }
    }
    if (p === '/v1/betaAppReviewSubmissions')
      return {
        status: 201,
        json: {
          data: { type: 'betaAppReviewSubmissions', id: this.id('REVIEW') },
        },
      }
    const betaDetail = /^\/v1\/builds\/([^/]+)\/buildBetaDetail$/.exec(p)
    if (betaDetail != null)
      return {
        status: 200,
        json: {
          data: {
            type: 'buildBetaDetails',
            id: `DETAIL_${betaDetail[1]}`,
            attributes: {},
          },
        },
      }
    const betaDetailPatch = /^\/v1\/buildBetaDetails\/DETAIL_([^/]+)$/.exec(p)
    if (betaDetailPatch != null) {
      this.builds.get(betaDetailPatch[1]!)!.autoNotifyEnabled =
        data!.attributes.autoNotifyEnabled
      return {
        status: 200,
        json: {
          data: {
            type: 'buildBetaDetails',
            id: `DETAIL_${betaDetailPatch[1]}`,
          },
        },
      }
    }
    // The notary service.
    if (p === '/notary/v2/submissions' && method === 'POST') {
      const id = randomUUID()
      this.submissions.set(id, {
        name: json!.submissionName,
        sha256: json!.sha256,
        status: 'In Progress',
        polls: 0,
      })
      return {
        status: 200,
        json: {
          data: {
            id,
            type: 'newSubmissions',
            attributes: {
              awsAccessKeyId: 'FAKEACCESS',
              awsSecretAccessKey: 'fake-secret',
              awsSessionToken: 'fake-session-token',
              bucket: 'notary-submissions',
              object: `prod/${id}`,
            },
          },
        },
      }
    }
    const submission = /^\/notary\/v2\/submissions\/([^/]+)(\/logs)?$/.exec(p)
    if (submission != null) {
      const entry = this.submissions.get(submission[1]!)!
      if (submission[2] != null)
        return {
          status: 200,
          json: {
            data: {
              attributes: {
                developerLogUrl: `${this.origin}/notary-log/${submission[1]}`,
              },
            },
          },
        }
      if (++entry.polls >= 2)
        entry.status = /rejected/.test(entry.name) ? 'Invalid' : 'Accepted'
      return {
        status: 200,
        json: {
          data: { id: submission[1], attributes: { status: entry.status } },
        },
      }
    }
    return {
      status: 404,
      json: {
        errors: [
          { status: '404', title: 'Not found', detail: `${method} ${p}` },
        ],
      },
    }
  }

  /** A certificate Apple lists, by its PEM. */
  addCertificate(pem: string, id = this.id('CERT')): Doc {
    const certificate = new X509Certificate(pem)
    const item = {
      type: 'certificates',
      id,
      attributes: {
        serialNumber: certificate.serialNumber.toUpperCase(),
        name: certificate.subject,
        expirationDate: new Date(certificate.validTo).toISOString(),
      },
    }
    this.certificates.set(id, item)
    return item
  }
}
