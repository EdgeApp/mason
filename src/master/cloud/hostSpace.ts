import type { MasterDatabase } from '../database.js'
import type { CloudProvider } from './digitalocean.js'
import type { CloudHostRow, CloudHostSpace } from './hosts.js'
import { SpaceClient, SpaceError, type SpaceCredentials } from './spaces.js'

/** The `storage` area's S3 settings, as the Space step reads and writes them. */
export interface SpaceStorage {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

export interface HostSpaceOptions {
  master: MasterDatabase
  /** The master's `storage` area: its S3 settings when it holds a bucket. */
  storage: {
    get(): SpaceStorage | undefined
    set(value: SpaceStorage): Promise<void>
    /** Back to the host's disk. */
    clear(): Promise<void>
  }
  /** The S3 endpoint of a Spaces region; DigitalOcean's by default. */
  endpoint?: (region: string) => string
  fetch?: typeof fetch
  /** Waits between tries while a new key starts to work; five seconds by default. */
  wait?: (ms: number) => Promise<void>
}

/**
 * A cloud host's DigitalOcean Space. Reconcile makes the bucket with a
 * short-lived full-access key when it is missing (DigitalOcean grants a key
 * only on a bucket that exists), keeps a key limited to the bucket (a key
 * whose secret is not stored is replaced, since a secret is shown only when
 * a key is made), and points the host's storage at it only when an
 * administrator asked for that.
 */
export class HostSpace implements CloudHostSpace {
  constructor(private readonly options: HostSpaceOptions) {}

  private endpoint(region: string): string {
    return (
      this.options.endpoint?.(region) ??
      `https://${region}.digitaloceanspaces.com`
    )
  }
  private client(region: string, credentials: SpaceCredentials): SpaceClient {
    return new SpaceClient(
      { endpoint: this.endpoint(region), region },
      credentials,
      this.options.fetch,
    )
  }
  /**
   * Runs a request with a key DigitalOcean just made, which refuses it for a
   * few seconds; a refusal that lasts is the request's own.
   */
  private async settled<T>(request: () => Promise<T>): Promise<T> {
    const wait =
      this.options.wait ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 1; ; attempt++) {
      try {
        return await request()
      } catch (error) {
        if (
          !(error instanceof SpaceError && error.status === 403) ||
          attempt >= 12
        )
          throw error
        await wait(5_000)
      }
    }
  }

  /** Runs with a full-access key made for it, then deleted. */
  private async withSetupKey<T>(
    provider: CloudProvider,
    keyName: string,
    region: string,
    use: (client: SpaceClient) => Promise<T>,
  ): Promise<T> {
    const setup = await provider.createSpacesKey!(`${keyName}-setup`, [
      { bucket: '', permission: 'fullaccess' },
    ])
    try {
      return await use(
        this.client(region, {
          accessKeyId: setup.id,
          secretAccessKey: setup.secret,
        }),
      )
    } finally {
      await provider.deleteSpacesKey!(setup.id)
    }
  }

  private update(name: string, fields: Partial<CloudHostRow>): void {
    const entries = Object.entries({
      ...fields,
      updated_at: this.options.master.now(),
    })
    this.options.master.db
      .prepare(
        `UPDATE cloud_hosts SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE name=? AND state<>'removed'`,
      )
      .run(
        ...(entries.map(([, value]) => value ?? null) as Array<
          string | number | null
        >),
        name,
      )
  }

  async reconcile(
    row: CloudHostRow,
    provider: CloudProvider,
    keyName: string,
  ): Promise<string | undefined> {
    const bucket = row.space_bucket
    const region = row.space_region
    if (bucket == null || region == null) return undefined
    if (provider.spacesKeys == null)
      return `The ${row.provider} provider has no Spaces`
    const storage = this.options.storage.get()
    const uses = storage != null && storage.bucket === bucket
    // 1. The key: the one storage holds the secret of, if the provider still has it.
    const keys = await provider.spacesKeys()
    let credentials: SpaceCredentials | undefined
    if (
      uses &&
      storage.accessKeyId === row.space_key_id &&
      keys.some((key) => key.id === storage.accessKeyId)
    )
      credentials = {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      }
    else if (
      row.space_secret != null &&
      keys.some((key) => key.id === row.space_key_id)
    )
      credentials = {
        accessKeyId: row.space_key_id!,
        secretAccessKey: row.space_secret,
      }
    // 2. The bucket: seen with the key, or else adopted or made with a setup key.
    // A key limited to this bucket sees 403 for a name another account holds.
    const present =
      credentials != null &&
      (await this.client(region, credentials)
        .exists(bucket)
        .catch((error: unknown) => {
          if (error instanceof SpaceError && error.status === 403) return false
          throw error
        }))
    if (!present) {
      const made = await this.withSetupKey(
        provider,
        keyName,
        region,
        async (admin) => {
          const exists = await this.settled(
            async () => await admin.exists(bucket),
          ).catch((error: unknown) => {
            // Another account's bucket; making it says the name is taken.
            if (error instanceof SpaceError && error.status === 403)
              return false
            throw error
          })
          if (exists) return false
          await this.settled(async () => await admin.create(bucket))
          return true
        },
      )
      if (made) this.update(row.name, { space_owned: 1 })
    }
    // 3. A key limited to the bucket, now that it exists, once it works.
    if (credentials == null) {
      const made = await provider.createSpacesKey!(keyName, [
        { bucket, permission: 'readwrite' },
      ])
      for (const old of keys.filter((key) => key.name === keyName))
        await provider.deleteSpacesKey!(old.id)
      const fresh = { accessKeyId: made.id, secretAccessKey: made.secret }
      this.update(row.name, {
        space_key_id: made.id,
        space_key_owned: 1,
        space_secret: made.secret,
      })
      await this.settled(
        async () => await this.client(region, fresh).check(bucket),
      )
      credentials = fresh
    }
    // 4. Storage: switched when an administrator asked; kept working when its key was replaced.
    const value: SpaceStorage = {
      endpoint: this.endpoint(region),
      bucket,
      region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    }
    if (row.space_pending === 1) {
      await this.options.storage.set(value)
      this.update(row.name, { space_pending: 0 })
    } else if (uses && storage.accessKeyId !== credentials.accessKeyId)
      await this.options.storage.set(value)
    return undefined
  }

  async remove(
    row: CloudHostRow,
    provider: CloudProvider,
    options: { deleteSpace: boolean; keyName: string },
  ): Promise<void> {
    if (row.space_bucket == null || row.space_region == null) return
    if (options.deleteSpace && row.space_owned === 1) {
      const bucket = row.space_bucket
      await this.withSetupKey(
        provider,
        options.keyName,
        row.space_region,
        async (admin) => {
          await this.settled(async () => await admin.destroy(bucket))
        },
      )
    }
    if (row.space_key_owned === 1 && row.space_key_id != null)
      await provider.deleteSpacesKey?.(row.space_key_id)
    // Storage through the key just deleted, or in the Space just deleted,
    // would leave the next host storing builds nowhere: back to its disk.
    const storage = this.options.storage.get()
    if (
      storage?.bucket === row.space_bucket &&
      ((options.deleteSpace && row.space_owned === 1) ||
        (row.space_key_owned === 1 && storage.accessKeyId === row.space_key_id))
    )
      await this.options.storage.clear()
  }
}
