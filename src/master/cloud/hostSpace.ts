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

/** A bucket and a key limited to it, as `makeSpace` leaves them. */
export interface MadeSpace {
  endpoint: string
  bucket: string
  region: string
  /** Whether the bucket was made now, rather than adopted. */
  made: boolean
  /** The key's id, which is also its access key id. */
  keyId: string
  accessKeyId: string
  secret: string
  /** Whether the key was made now, rather than reused. */
  keyMade: boolean
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

  /**
   * Makes or adopts a bucket and a key limited to it, and returns them once
   * the key works. A given key that the provider still has is reused. A new
   * key replaces every other key of the same name unless `deleteOld` is
   * false, for a caller that deletes the old key itself after switching.
   */
  async makeSpace(
    provider: CloudProvider,
    options: {
      bucket: string
      region: string
      keyName: string
      key?: SpaceCredentials
      deleteOld?: boolean
      /** Told the moment the bucket is made, before the key step can fail. */
      onMade?: () => void
    },
  ): Promise<MadeSpace> {
    const { bucket, region, keyName } = options
    if (provider.spacesKeys == null)
      throw new SpaceError(
        0,
        'NoSpaces',
        'This account’s provider has no Spaces',
      )
    const keys = await provider.spacesKeys()
    let credentials =
      options.key != null &&
      keys.some((key) => key.id === options.key!.accessKeyId)
        ? options.key
        : undefined
    // The bucket: seen with the key, or else adopted or made with a setup key.
    // A key limited to this bucket sees 403 for a name another account holds.
    const present =
      credentials != null &&
      (await this.client(region, credentials)
        .exists(bucket)
        .catch((error: unknown) => {
          if (error instanceof SpaceError && error.status === 403) return false
          throw error
        }))
    let made = false
    if (!present)
      made = await this.withSetupKey(
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
          options.onMade?.()
          return true
        },
      )
    // A key limited to the bucket, now that it exists, once it works.
    let keyMade = false
    if (credentials == null) {
      const fresh = await provider.createSpacesKey!(keyName, [
        { bucket, permission: 'readwrite' },
      ])
      credentials = { accessKeyId: fresh.id, secretAccessKey: fresh.secret }
      keyMade = true
      const checking = credentials
      // A key that never starts to work is deleted, and the keys before it
      // stay, so a failure leaves the old ones working and no new one behind.
      await this.settled(
        async () => await this.client(region, checking).check(bucket),
      ).catch(async (error: unknown) => {
        await provider.deleteSpacesKey!(fresh.id).catch(() => undefined)
        throw error
      })
      if (options.deleteOld !== false)
        for (const old of keys.filter((key) => key.name === keyName))
          await provider.deleteSpacesKey!(old.id)
    }
    return {
      endpoint: this.endpoint(region),
      bucket,
      region,
      made,
      keyId: credentials.accessKeyId,
      accessKeyId: credentials.accessKeyId,
      secret: credentials.secretAccessKey,
      keyMade,
    }
  }

  /** Empties and deletes a bucket, with a setup key made for it. */
  async destroyBucket(
    provider: CloudProvider,
    options: { bucket: string; region: string; keyName: string },
  ): Promise<void> {
    await this.withSetupKey(
      provider,
      options.keyName,
      options.region,
      async (admin) => {
        await this.settled(async () => await admin.destroy(options.bucket))
      },
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
    // The key: the one storage holds the secret of, else the one the row keeps.
    const key: SpaceCredentials | undefined =
      uses && storage.accessKeyId === row.space_key_id
        ? {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          }
        : row.space_secret != null && row.space_key_id != null
          ? { accessKeyId: row.space_key_id, secretAccessKey: row.space_secret }
          : undefined
    const space = await this.makeSpace(provider, {
      bucket,
      region,
      keyName,
      ...(key == null ? {} : { key }),
      // Recorded as soon as it exists, so removing the host can delete it even if the key step fails.
      onMade: () => this.update(row.name, { space_owned: 1 }),
    })
    if (space.keyMade)
      this.update(row.name, {
        space_key_id: space.keyId,
        space_key_owned: 1,
        space_secret: space.secret,
      })
    // Storage: switched when an administrator asked; kept working when its key was replaced.
    const value: SpaceStorage = {
      endpoint: space.endpoint,
      bucket,
      region,
      accessKeyId: space.accessKeyId,
      secretAccessKey: space.secret,
    }
    if (row.space_pending === 1) {
      await this.options.storage.set(value)
      this.update(row.name, { space_pending: 0 })
    } else if (uses && storage.accessKeyId !== space.accessKeyId)
      await this.options.storage.set(value)
    return undefined
  }

  async remove(
    row: CloudHostRow,
    provider: CloudProvider,
    options: { deleteSpace: boolean; keyName: string },
  ): Promise<void> {
    if (row.space_bucket == null || row.space_region == null) return
    if (options.deleteSpace && row.space_owned === 1)
      await this.destroyBucket(provider, {
        bucket: row.space_bucket,
        region: row.space_region,
        keyName: options.keyName,
      })
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
