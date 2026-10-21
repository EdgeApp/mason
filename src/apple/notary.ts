import type { MasterDatabase } from '../master/database.js'
import { AppleApiError, type AppStoreConnect } from './connect.js'

/** The temporary, single-submission S3 credentials Apple returns for an upload. */
export interface NotaryUpload {
  id: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  bucket: string
  object: string
  region: string
  /** A fake S3 (tests only). */
  endpoint?: string
}

export type NotaryStatus =
  | { status: 'in-progress' }
  | { status: 'accepted' }
  | { status: 'rejected'; detail: string; log?: string }

/**
 * Notarization through Apple's notary web API: the master opens the
 * submission with its key and gives the worker only the upload credentials
 * Apple returns for that one submission, then reports Apple's verdict and,
 * on a rejection, Apple's log.
 */
export class Notary {
  constructor(
    private readonly master: MasterDatabase,
    private readonly connect: (team: string) => AppStoreConnect | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpoint: () => string | undefined = () => undefined,
  ) {}
  private api(team: string): AppStoreConnect {
    const connect = this.connect(team)
    if (connect == null)
      throw new Error(`Team ${team} has no App Store Connect key`)
    return connect
  }

  async start(input: {
    job: string
    stage: string
    team: string
    name: string
    sha256: string
  }): Promise<NotaryUpload> {
    if (!/^[0-9a-f]{64}$/.test(input.sha256))
      throw new Error('A notary submission needs the file’s SHA-256')
    const created = await this.api(input.team).request<{
      data: {
        id: string
        attributes: {
          awsAccessKeyId: string
          awsSecretAccessKey: string
          awsSessionToken: string
          bucket: string
          object: string
        }
      }
    }>(
      'POST',
      '/submissions',
      { submissionName: input.name, sha256: input.sha256 },
      'notary',
    )
    this.master.db
      .prepare(
        "INSERT INTO apple_submissions(id,job_id,stage,team_id,name,status,created_at) VALUES(?,?,?,?,?,'In Progress',?)",
      )
      .run(
        created.data.id,
        input.job,
        input.stage,
        input.team,
        input.name,
        this.master.now(),
      )
    const attributes = created.data.attributes
    return {
      id: created.data.id,
      accessKeyId: attributes.awsAccessKeyId,
      secretAccessKey: attributes.awsSecretAccessKey,
      sessionToken: attributes.awsSessionToken,
      bucket: attributes.bucket,
      object: attributes.object,
      region: 'us-west-2',
      ...(this.endpoint() == null ? {} : { endpoint: this.endpoint()! }),
    }
  }

  async status(id: string, job: string): Promise<NotaryStatus> {
    const row = this.master.db
      .prepare('SELECT team_id FROM apple_submissions WHERE id=? AND job_id=?')
      .get(id, job) as { team_id: string } | undefined
    if (row == null) throw new Error('No such notary submission for this run')
    const api = this.api(row.team_id)
    let answer: { data: { attributes: { status: string } } }
    try {
      answer = await api.request<{
        data: { attributes: { status: string } }
      }>('GET', `/submissions/${encodeURIComponent(id)}`, undefined, 'notary')
    } catch (error) {
      // A dropped connection or Apple's own outage is not the submission's
      // failure: the worker asks again shortly.
      if (
        error instanceof TypeError ||
        (error instanceof AppleApiError && error.status >= 500)
      )
        return { status: 'in-progress' }
      throw error
    }
    const status = answer.data.attributes.status
    this.master.db
      .prepare('UPDATE apple_submissions SET status=? WHERE id=?')
      .run(status, id)
    if (status === 'In Progress') return { status: 'in-progress' }
    if (status === 'Accepted') return { status: 'accepted' }
    let log: string | undefined
    try {
      const logs = await api.request<{
        data: { attributes: { developerLogUrl: string } }
      }>(
        'GET',
        `/submissions/${encodeURIComponent(id)}/logs`,
        undefined,
        'notary',
      )
      const response = await this.fetchImpl(
        logs.data.attributes.developerLogUrl,
        {
          signal: AbortSignal.timeout(60_000),
        },
      )
      if (response.ok) log = await response.text()
    } catch {
      log = undefined
    }
    return {
      status: 'rejected',
      detail: `Apple did not notarize it (${status})`,
      ...(log == null ? {} : { log }),
    }
  }
}
