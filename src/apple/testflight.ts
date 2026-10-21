import type { MasterDatabase } from '../master/database.js'
import {
  AppleApiError,
  type AppStoreConnect,
  type Resource,
} from './connect.js'

/** One part of the file, as Apple's pre-signed upload operations describe it. */
export interface UploadOperation {
  method: string
  url: string
  offset: number
  length: number
  headers: Record<string, string>
}

export interface TestflightOptions {
  whatToTest?: string
  groups?: string[]
  usesNonExemptEncryption?: boolean
  waitForProcessing?: boolean
  notifyTesters?: boolean
}

export interface TestflightResult {
  buildId: string
  version: string
  buildNumber: string
  state: string
}

export type TestflightStatus =
  | { state: 'uploading' | 'processing' }
  | { state: 'done'; result: TestflightResult }
  | { state: 'failed'; error: string }

/**
 * TestFlight through App Store Connect's build-upload API. The master, which
 * holds the key, creates the upload and its file record and gives the worker
 * only Apple's pre-signed upload operations; once the worker has sent the
 * file, the master marks it uploaded, waits for processing, answers export
 * compliance, writes What to Test, adds the build to its beta groups and
 * submits it for beta review when a group is external. Every step is
 * recorded, so asking again after a dropped link picks up where it was.
 */
export class TestFlight {
  constructor(
    private readonly master: MasterDatabase,
    private readonly connect: (team: string) => AppStoreConnect | undefined,
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }
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
    bundleId: string
    platform: 'ios' | 'macos'
    fileName: string
    fileSize: number
    version: string
    buildNumber: string
    options: TestflightOptions
  }): Promise<{ id: string; operations: UploadOperation[] }> {
    const api = this.api(input.team)
    const apps = await api.all<{ bundleId: string }>(
      `/v1/apps?filter[bundleId]=${encodeURIComponent(input.bundleId)}`,
    )
    const app = apps.find((item) => item.attributes.bundleId === input.bundleId)
    if (app == null)
      throw new Error(
        `App Store Connect has no app record for ${input.bundleId}; create it in App Store Connect first`,
      )
    const upload = await api.request<{ data: Resource }>(
      'POST',
      '/v1/buildUploads',
      {
        data: {
          type: 'buildUploads',
          attributes: {
            cfBundleShortVersionString: input.version,
            cfBundleVersion: input.buildNumber,
            platform: input.platform === 'macos' ? 'MAC_OS' : 'IOS',
          },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      },
    )
    const file = await api.request<{
      data: Resource<{
        uploadOperations: Array<{
          method: string
          url: string
          offset: number
          length: number
          requestHeaders?: Array<{ name: string; value: string }>
        }>
      }>
    }>('POST', '/v1/buildUploadFiles', {
      data: {
        type: 'buildUploadFiles',
        attributes: {
          assetType: 'ASSET',
          fileName: input.fileName,
          fileSize: input.fileSize,
          uti: input.platform === 'macos' ? 'com.apple.pkg' : 'com.apple.ipa',
        },
        relationships: {
          buildUpload: { data: { type: 'buildUploads', id: upload.data.id } },
        },
      },
    })
    this.db
      .prepare(
        "INSERT INTO apple_uploads(id,job_id,stage,team_id,app_id,file_id,options,state,created_at) VALUES(?,?,?,?,?,?,?,'uploading',?)",
      )
      .run(
        upload.data.id,
        input.job,
        input.stage,
        input.team,
        app.id,
        file.data.id,
        JSON.stringify({
          ...input.options,
          version: input.version,
          buildNumber: input.buildNumber,
        }),
        this.master.now(),
      )
    return {
      id: upload.data.id,
      operations: file.data.attributes.uploadOperations.map((operation) => ({
        method: operation.method,
        url: operation.url,
        offset: operation.offset,
        length: operation.length,
        headers: Object.fromEntries(
          (operation.requestHeaders ?? []).map((header) => [
            header.name,
            header.value,
          ]),
        ),
      })),
    }
  }

  private row(id: string, job: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT * FROM apple_uploads WHERE id=? AND job_id=?')
      .get(id, job)
    if (row == null) throw new Error('No such TestFlight upload for this run')
    return row
  }

  /** The worker has sent every part: Apple may now process the file. */
  async complete(id: string, job: string): Promise<TestflightStatus> {
    const row = this.row(id, job)
    if (row.state === 'uploading') {
      await this.api(String(row.team_id)).request(
        'PATCH',
        `/v1/buildUploadFiles/${String(row.file_id)}`,
        {
          data: {
            type: 'buildUploadFiles',
            id: String(row.file_id),
            attributes: { uploaded: true },
          },
        },
      )
      this.db
        .prepare("UPDATE apple_uploads SET state='processing' WHERE id=?")
        .run(id)
    }
    return await this.status(id, job)
  }

  /** Where the upload is; finishes the TestFlight steps once Apple has processed the build. */
  async status(id: string, job: string): Promise<TestflightStatus> {
    const row = this.row(id, job)
    const state = String(row.state)
    if (state === 'done')
      return {
        state: 'done',
        result: JSON.parse(String(row.result)) as TestflightResult,
      }
    if (state === 'failed')
      return { state: 'failed', error: String(row.result) }
    if (state === 'uploading') return { state: 'uploading' }
    const api = this.api(String(row.team_id))
    const options = JSON.parse(String(row.options)) as TestflightOptions & {
      version: string
      buildNumber: string
    }
    let build = row.build_id == null ? undefined : String(row.build_id)
    if (build == null) {
      const upload = await api.request<{
        data: Resource<{
          state?: string
          stateDetails?: {
            errors?: Array<{ description?: string; message?: string }>
          }
        }>
      }>('GET', `/v1/buildUploads/${id}?include=build`)
      const uploadState = upload.data.attributes.state
      if (uploadState === 'FAILED') {
        const errors = upload.data.attributes.stateDetails?.errors ?? []
        return this.fail(
          id,
          `App Store Connect rejected the upload: ${
            errors
              .map((error) => error.description ?? error.message)
              .filter(Boolean)
              .join('; ') || 'no detail'
          }`,
        )
      }
      build = upload.data.relationships?.build?.data?.id ?? undefined
      if (build == null) return { state: 'processing' }
      this.db
        .prepare('UPDATE apple_uploads SET build_id=? WHERE id=?')
        .run(build, id)
    }
    if (options.waitForProcessing !== false) {
      const detail = await api.request<{
        data: Resource<{ processingState: string }>
      }>('GET', `/v1/builds/${build}`)
      const processing = detail.data.attributes.processingState
      if (processing === 'FAILED' || processing === 'INVALID')
        return this.fail(
          id,
          `App Store Connect could not process the build (${processing})`,
        )
      if (processing !== 'VALID') return { state: 'processing' }
    }
    await this.finish(api, String(row.app_id), build, options)
    const result: TestflightResult = {
      buildId: build,
      version: options.version,
      buildNumber: options.buildNumber,
      state: options.waitForProcessing === false ? 'PROCESSING' : 'VALID',
    }
    this.db
      .prepare("UPDATE apple_uploads SET state='done',result=? WHERE id=?")
      .run(JSON.stringify(result), id)
    return { state: 'done', result }
  }

  private fail(id: string, error: string): TestflightStatus {
    this.db
      .prepare("UPDATE apple_uploads SET state='failed',result=? WHERE id=?")
      .run(error, id)
    return { state: 'failed', error }
  }

  /** Compliance, What to Test, beta groups, beta review and tester notification. */
  private async finish(
    api: AppStoreConnect,
    app: string,
    build: string,
    options: TestflightOptions,
  ): Promise<void> {
    if (options.usesNonExemptEncryption != null)
      await api.request('PATCH', `/v1/builds/${build}`, {
        data: {
          type: 'builds',
          id: build,
          attributes: {
            usesNonExemptEncryption: options.usesNonExemptEncryption,
          },
        },
      })
    if (options.whatToTest != null && options.whatToTest !== '') {
      const localizations = await api.all<{ locale: string }>(
        `/v1/builds/${build}/betaBuildLocalizations`,
      )
      const english = localizations.find(
        (item) => item.attributes.locale === 'en-US',
      )
      const whatsNew = options.whatToTest.slice(0, 4000)
      if (english != null)
        await api.request('PATCH', `/v1/betaBuildLocalizations/${english.id}`, {
          data: {
            type: 'betaBuildLocalizations',
            id: english.id,
            attributes: { whatsNew },
          },
        })
      else
        await api.request('POST', '/v1/betaBuildLocalizations', {
          data: {
            type: 'betaBuildLocalizations',
            attributes: { locale: 'en-US', whatsNew },
            relationships: { build: { data: { type: 'builds', id: build } } },
          },
        })
    }
    const wanted = options.groups ?? []
    if (wanted.length !== 0) {
      const groups = await api.all<{ name: string; isInternalGroup: boolean }>(
        `/v1/apps/${app}/betaGroups?limit=200`,
      )
      const missing = wanted.filter(
        (name) => !groups.some((group) => group.attributes.name === name),
      )
      if (missing.length !== 0)
        throw new Error(`No beta group named ${missing.join(', ')}`)
      let external = false
      for (const name of wanted) {
        const group = groups.find((item) => item.attributes.name === name)!
        external ||= !group.attributes.isInternalGroup
        await api.request(
          'POST',
          `/v1/betaGroups/${group.id}/relationships/builds`,
          {
            data: [{ type: 'builds', id: build }],
          },
        )
      }
      if (external)
        await api
          .request('POST', '/v1/betaAppReviewSubmissions', {
            data: {
              type: 'betaAppReviewSubmissions',
              relationships: { build: { data: { type: 'builds', id: build } } },
            },
          })
          .catch((error: unknown) => {
            // Already submitted is fine.
            if (!(error instanceof AppleApiError && error.status === 409))
              throw error
          })
    }
    {
      const detail = await api.request<{ data: Resource }>(
        'GET',
        `/v1/builds/${build}/buildBetaDetail`,
      )
      await api.request('PATCH', `/v1/buildBetaDetails/${detail.data.id}`, {
        data: {
          type: 'buildBetaDetails',
          id: detail.data.id,
          attributes: { autoNotifyEnabled: options.notifyTesters ?? true },
        },
      })
    }
  }
}
