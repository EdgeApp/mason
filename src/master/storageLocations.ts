import type { MasterDatabase } from './database.js'
import { allow } from './permissions.js'
import type { Actor } from './roles.js'
import { storageLocationId } from './schema.js'
import type { Settings } from './settings.js'
import type { StorageSetting } from './hostSettings.js'
import type { CloudProvider } from './cloud/digitalocean.js'

/** One place builds are stored: the host's disk, or a Space. */
export interface StorageLocation {
  id: string
  kind: 'disk' | 'space'
  /** Whether new builds go here. */
  active: boolean
  bucket?: string
  region?: string
  endpoint?: string
  /** made: Mason made it; added: an administrator gave its key; host: made for a cloud host. */
  origin?: 'made' | 'added' | 'host'
  /** Whether Mason made the bucket, so deleting the location deletes it. */
  bucketOwned?: boolean
  account?: string
  host?: string
  addedAt?: number
  addedBy?: string
  /** Files and bytes the host holds there, when the host answered. */
  usage?: { files: number; bytes: number }
}

interface Row {
  id: string
  bucket: string
  region: string
  endpoint: string
  access_key_id: string
  secret: string
  origin: 'made' | 'added' | 'host'
  bucket_owned: number
  key_owned: number
  account: string | null
  key_id: string | null
  host: string | null
  added_at: number
  added_by: string
}

/** What a location's deletion needs from the rest of the master. */
export interface LocationDeps {
  /** The host's files in a store, or undefined when there is no host; throws when the host is offline. */
  hostKeys(store: {
    bucket: string
    endpoint: string
  }): Promise<string[] | undefined>
  /** The host drops its records of a store. */
  hostForget(store: { bucket: string; endpoint: string }): Promise<void>
  /** Builds and run artifacts whose files are these keys are gone. */
  forgetFiles(keys: string[]): void
  /** The DigitalOcean account's provider, for deleting a bucket and a key. */
  provider(account: string): CloudProvider | undefined
  destroyBucket(
    provider: CloudProvider,
    options: { bucket: string; region: string; keyName: string },
  ): Promise<void>
  masterId: string
}

export class LocationError extends Error {}

/**
 * Every place builds are stored. The `storage` setting names the active one,
 * where new builds go; every location keeps serving the builds already in it,
 * because the host records the store each file was written to.
 */
export class StorageLocations {
  constructor(
    private readonly master: MasterDatabase,
    private readonly settings: Settings,
  ) {}

  private rows(): Row[] {
    return this.master.db
      .prepare('SELECT * FROM storage_locations ORDER BY added_at, id')
      .all() as unknown as Row[]
  }

  private row(id: string): Row | undefined {
    return this.master.db
      .prepare('SELECT * FROM storage_locations WHERE id=?')
      .get(id) as unknown as Row | undefined
  }

  private activeId(): string {
    const storage = this.settings.value('storage') as StorageSetting | undefined
    return storage?.driver === 's3' && storage.s3 != null
      ? storageLocationId(storage.s3.bucket, storage.s3.endpoint)
      : 'disk'
  }

  /** The disk first, then each Space in the order it was added; secrets never. */
  list(): StorageLocation[] {
    const active = this.activeId()
    return [
      { id: 'disk', kind: 'disk', active: active === 'disk' },
      ...this.rows().map(
        (row): StorageLocation => ({
          id: row.id,
          kind: 'space',
          active: active === row.id,
          bucket: row.bucket,
          region: row.region,
          endpoint: row.endpoint,
          origin: row.origin,
          bucketOwned: row.bucket_owned === 1,
          ...(row.account == null ? {} : { account: row.account }),
          ...(row.host == null ? {} : { host: row.host }),
          addedAt: row.added_at,
          addedBy: row.added_by,
        }),
      ),
    ]
  }

  /**
   * Records the Space the `storage` setting names, however it was set: a
   * Space Mason made keeps its account and key; one a cloud host made keeps
   * that host and what Mason made; any other was added by an administrator.
   */
  remember(storage: StorageSetting, by?: string): void {
    if (storage.driver !== 's3' || storage.s3 == null) return
    const s3 = storage.s3
    const id = storageLocationId(s3.bucket, s3.endpoint)
    const host = this.master.db
      .prepare(
        "SELECT name,account,space_owned,space_key_owned,space_key_id FROM cloud_hosts WHERE role='host' AND state<>'removed' AND space_bucket=?",
      )
      .get(s3.bucket) as
      | {
          name: string
          account: string
          space_owned: number
          space_key_owned: number
          space_key_id: string | null
        }
      | undefined
    const existing = this.row(id)
    if (existing != null) {
      // A cloud host that uses this Space through its own key owns that key.
      const hostKey = host != null && host.space_key_id === s3.accessKeyId
      this.master.db
        .prepare(
          'UPDATE storage_locations SET access_key_id=?,secret=?,region=?,host=?,key_owned=?,key_id=?,account=coalesce(account,?) WHERE id=?',
        )
        .run(
          s3.accessKeyId,
          s3.secretAccessKey,
          s3.region,
          hostKey ? host.name : existing.host,
          hostKey
            ? host.space_key_owned
            : storage.managed?.keyId === s3.accessKeyId
              ? 1
              : existing.key_id === s3.accessKeyId
                ? existing.key_owned
                : 0,
          hostKey || storage.managed != null ? s3.accessKeyId : existing.key_id,
          host?.account ?? storage.managed?.account ?? null,
          id,
        )
      return
    }
    const made = storage.managed
    this.master.db
      .prepare(
        `INSERT INTO storage_locations(id,bucket,region,endpoint,access_key_id,secret,origin,bucket_owned,key_owned,account,key_id,host,added_at,added_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        s3.bucket,
        s3.region,
        s3.endpoint,
        s3.accessKeyId,
        s3.secretAccessKey,
        made != null ? 'made' : host != null ? 'host' : 'added',
        made != null ? 1 : (host?.space_owned ?? 0),
        made != null
          ? 1
          : host?.space_key_id === s3.accessKeyId
            ? host.space_key_owned
            : 0,
        made?.account ?? host?.account ?? null,
        made?.keyId ?? (host != null ? s3.accessKeyId : null),
        host?.name ?? null,
        this.master.now(),
        by ??
          (
            this.master.db
              .prepare("SELECT updated_by FROM settings WHERE area='storage'")
              .get() as { updated_by: string } | undefined
          )?.updated_by ??
          'settings',
      )
  }

  /** New builds go to this location from now on; the others keep theirs. */
  async use(actor: Actor, id: string): Promise<void> {
    allow(actor, 'settings.change')
    if (id === 'disk') {
      await this.settings.set(actor, 'storage', { driver: 'disk' })
      return
    }
    const row = this.row(id)
    if (row == null) throw new LocationError(`No storage location ${id}`)
    await this.settings.set(actor, 'storage', {
      driver: 's3',
      s3: {
        endpoint: row.endpoint,
        bucket: row.bucket,
        region: row.region,
        accessKeyId: row.access_key_id,
        secretAccessKey: row.secret,
      },
      ...(row.origin === 'made' && row.account != null && row.key_id != null
        ? { managed: { account: row.account, keyId: row.key_id } }
        : {}),
    })
  }

  /** A cloud host that kept its Space is gone: the Space stays a location of its own. */
  hostRemoved(name: string): void {
    this.master.db
      .prepare('UPDATE storage_locations SET host=NULL WHERE host=?')
      .run(name)
  }

  /** A cloud host that deleted its Space: the location goes with it. */
  dropHostSpace(name: string, bucket: string): void {
    this.master.db
      .prepare('DELETE FROM storage_locations WHERE host=? AND bucket=?')
      .run(name, bucket)
  }

  /**
   * Removes a Space: its builds leave Mason, the host forgets its store, and
   * a bucket and key Mason made are deleted; a Space an administrator added
   * stays in DigitalOcean with its files. Refused for the disk, for the
   * location new builds go to, and while the host cannot answer.
   */
  async remove(
    actor: Actor,
    id: string,
    confirm: unknown,
    deps: LocationDeps,
  ): Promise<{ files: number; bucketDeleted: boolean }> {
    allow(actor, 'settings.change')
    if (id === 'disk')
      throw new LocationError('The host’s disk is always a storage location')
    const row = this.row(id)
    if (row == null) throw new LocationError(`No storage location ${id}`)
    if (this.activeId() === id)
      throw new LocationError(
        'New builds go to this Space: use another location for new builds first',
      )
    if (confirm !== row.bucket)
      throw new LocationError(
        `Type the Space’s name, ${row.bucket}, to remove it`,
      )
    const store = { bucket: row.bucket, endpoint: row.endpoint }
    let keys: string[] | undefined
    try {
      keys = await deps.hostKeys(store)
    } catch (error) {
      throw new LocationError(
        `Nothing was removed: the host did not answer (${(error as Error).message})`,
      )
    }
    const provider =
      row.account == null ? undefined : deps.provider(row.account)
    if ((row.bucket_owned === 1 || row.key_owned === 1) && provider == null)
      throw new LocationError(
        `Nothing was removed: ${row.account ?? 'the Space’s account'} has no API key to delete it with`,
      )
    deps.forgetFiles(keys ?? [])
    if (keys != null) await deps.hostForget(store)
    let bucketDeleted = false
    if (row.bucket_owned === 1) {
      await deps.destroyBucket(provider!, {
        bucket: row.bucket,
        region: row.region,
        keyName: `mason-storage-${deps.masterId}-${row.bucket}-remove`,
      })
      bucketDeleted = true
    }
    if (row.key_owned === 1 && row.key_id != null)
      await provider!.deleteSpacesKey?.(row.key_id).catch(() => undefined)
    this.master.transaction(() => {
      this.master.db.prepare('DELETE FROM storage_locations WHERE id=?').run(id)
      if (row.host != null)
        this.master.db
          .prepare(
            "UPDATE cloud_hosts SET space_bucket=NULL,space_region=NULL,space_key_id=NULL,space_secret=NULL,space_owned=0,space_key_owned=0,space_pending=0 WHERE name=? AND role='host' AND state<>'removed'",
          )
          .run(row.host)
      this.master.audit(actor, 'storage.remove', row.bucket)
    })
    return { files: keys?.length ?? 0, bucketDeleted }
  }
}
