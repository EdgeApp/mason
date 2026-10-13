import { asArray, asBoolean, asOptional } from 'cleaners'
import { randomBytes } from 'node:crypto'
import type { Store } from '../store.js'
import {
  asApp,
  asChannel,
  asFormat,
  asPlatform,
  formats,
  integer,
  object,
  text,
  type Cleaner,
  type Format,
  type Platform,
} from '../validation.js'

/** Bundle identifiers: published packages must carry the app's slug. */
export const asSlug: Cleaner<string> = (value) => {
  const out = text(160)(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(out))
    throw new Error('Expected a reverse-DNS bundle identifier')
  return out
}
const asNewApp = object({
  slug: asSlug,
  name: text(120),
  position: asOptional(integer()),
  enabled: asOptional(asBoolean, true),
})
const asAppChange = object({
  name: asOptional(text(120)),
  position: asOptional(integer()),
  enabled: asOptional(asBoolean),
})
const asNewChannel = object({
  platform: asPlatform,
  formats: asOptional(asArray(asFormat)),
  enabled: asOptional(asBoolean, true),
})
const asChannelChange = object({
  formats: asOptional(asArray(asFormat)),
  enabled: asOptional(asBoolean),
  rotateKey: asOptional(asBoolean, false),
})
export interface AdminChannel {
  id: number
  platform: Platform
  key: string
  formats: Format[]
  enabled: boolean
}
export interface AdminApp {
  id: number
  slug: string
  name: string
  position: number
  enabled: boolean
  channels: AdminChannel[]
}
export class NotFound extends Error {}
export class Conflict extends Error {}

function channelFormats(platform: Platform, value?: Format[]): Format[] {
  const out = value ?? [...formats[platform]]
  if (
    out.length === 0 ||
    new Set(out).size !== out.length ||
    out.some((format) => !formats[platform].includes(format))
  )
    throw new Error('Invalid channel formats')
  return out
}

/** Operator management of distribution apps and their upload channels. */
export class AppAdmin {
  constructor(readonly store: Store) {}
  list(): AdminApp[] {
    return this.store.db
      .prepare('SELECT * FROM apps ORDER BY position,id')
      .all()
      .map((row) => this.present(asApp(row)))
  }
  get(slug: string): AdminApp {
    return this.present(this.row(slug))
  }
  create(input: unknown): AdminApp {
    const app = asNewApp(input)
    return this.store.transaction(() => {
      if (this.find(app.slug) != null) throw new Conflict('App exists')
      const position =
        app.position ??
        integer()(
          this.store.db
            .prepare('SELECT COALESCE(MAX(position)+1,0) next FROM apps')
            .get()?.next,
        )
      this.store.addApp({ ...app, position })
      this.audit('app.create', app.slug)
      return this.get(app.slug)
    })
  }
  update(slug: string, input: unknown): AdminApp {
    const change = asAppChange(input)
    return this.store.transaction(() => {
      const app = this.row(slug)
      this.store.db
        .prepare('UPDATE apps SET name=?,position=?,enabled=? WHERE id=?')
        .run(
          change.name ?? app.name,
          change.position ?? app.position,
          change.enabled == null ? app.enabled : Number(change.enabled),
          app.id,
        )
      this.audit('app.update', slug)
      return this.get(slug)
    })
  }
  addChannel(slug: string, input: unknown): AdminChannel {
    const channel = asNewChannel(input)
    return this.store.transaction(() => {
      const app = this.row(slug)
      if (
        this.store.db
          .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
          .get(app.id, channel.platform) != null
      )
        throw new Conflict('Channel exists')
      this.store.addChannel({
        appId: app.id,
        platform: channel.platform,
        key: randomBytes(32).toString('base64url'),
        allowedFormats: channelFormats(channel.platform, channel.formats),
        enabled: channel.enabled,
      })
      this.audit('channel.create', `${slug}:${channel.platform}`)
      return this.channel(slug, channel.platform)
    })
  }
  updateChannel(slug: string, platform: string, input: unknown): AdminChannel {
    const change = asChannelChange(input)
    return this.store.transaction(() => {
      const current = this.channel(slug, platform)
      this.store.db
        .prepare(
          'UPDATE channels SET formats=?,enabled=?,channel_key=? WHERE id=?',
        )
        .run(
          JSON.stringify(
            change.formats == null
              ? current.formats
              : channelFormats(current.platform, change.formats),
          ),
          change.enabled == null
            ? Number(current.enabled)
            : Number(change.enabled),
          change.rotateKey
            ? randomBytes(32).toString('base64url')
            : current.key,
          current.id,
        )
      this.audit(
        change.rotateKey ? 'channel.rotate' : 'channel.update',
        `${slug}:${current.platform}`,
      )
      return this.channel(slug, current.platform)
    })
  }
  /** Resolves enabled app slugs to the IDs that upload keys are scoped by. */
  ids(slugs: unknown): number[] {
    const enabled = new Map(this.store.apps().map((app) => [app.slug, app.id]))
    return asArray(asSlug)(slugs).map((slug) => {
      const id = enabled.get(slug)
      if (id == null) throw new NotFound('Unknown or disabled app')
      return id
    })
  }
  slugs(ids: 'all' | number[]): 'all' | string[] {
    if (ids === 'all') return ids
    const all = new Map(this.list().map((app) => [app.id, app.slug]))
    return ids.map((id) => all.get(id) ?? String(id))
  }
  private channel(slug: string, platform: string): AdminChannel {
    const found = this.get(slug).channels.find(
      (channel) => channel.platform === platform,
    )
    if (found == null) throw new NotFound('Channel not found')
    return found
  }
  private find(slug: string): ReturnType<typeof asApp> | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM apps WHERE slug=?')
      .get(text(160)(slug))
    return row == null ? undefined : asApp(row)
  }
  private row(slug: string): ReturnType<typeof asApp> {
    const app = this.find(slug)
    if (app == null) throw new NotFound('App not found')
    return app
  }
  private present(app: ReturnType<typeof asApp>): AdminApp {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      position: app.position,
      enabled: app.enabled === 1,
      channels: this.store.db
        .prepare('SELECT * FROM channels WHERE app_id=? ORDER BY platform')
        .all(app.id)
        .map((row) => {
          const channel = asChannel(row)
          return {
            id: channel.id,
            platform: channel.platform,
            key: channel.channel_key,
            formats: asArray(asFormat)(JSON.parse(channel.formats)),
            enabled: channel.enabled === 1,
          }
        }),
    }
  }
  private audit(action: string, target: string): void {
    this.store.db
      .prepare('INSERT INTO audit(action,target,at) VALUES(?,?,?)')
      .run(action, target, this.store.now())
  }
}
