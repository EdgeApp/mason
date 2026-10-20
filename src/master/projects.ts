import { randomBytes } from 'node:crypto'
import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'
import {
  branchName,
  envName,
  relativePath,
  repository,
} from '../builder/config.js'
import {
  asPlatform,
  formats,
  integer,
  text,
  type Platform,
} from '../validation.js'
import type { NodeSelector } from '../../types/mason/index.js'
import { asNodeSelector } from '../pipeline/graph.js'
import type { MasterDatabase } from './database.js'
import { asRules, type BranchRule } from './rules.js'
import { requireRole, type Actor } from './roles.js'

export class ProjectNotFound extends Error {
  constructor(slug: string) {
    super(`No project named ${slug}`)
  }
}
export class ProjectConflict extends Error {}

export function asProjectSlug(value: unknown): string {
  const out = text(160)(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out))
    throw new Error(
      'A project slug is letters, digits, dots, dashes and underscores',
    )
  return out
}

export interface ProjectApp {
  id: number
  bundleId: string
  name: string
  platforms: Platform[]
}

export interface Project {
  id: number
  slug: string
  name: string
  repository: string
  format: 'pipeline' | 'script'
  entrypoint?: string
  timeoutSeconds: number
  enabled: boolean
  position: number
  defaultBranch: string
  /** Script projects: the builder workspace directory and platforms. */
  /** For `script` projects: the checkout directory, platforms and where the build stage runs (default `{ os: 'macos' }`). */
  script: { workspace?: string; platforms?: Platform[]; on?: NodeSelector }
  webhookSecret: { set: boolean }
  apps: ProjectApp[]
  rules: BranchRule[]
  /** Secret names only; values are write-only. */
  env: Array<{ name: string; secret: boolean }>
  files: Array<{ destination: string; env?: string }>
}

const asProjectInput = asObject({
  name: asOptional(text(120)),
  repository: asOptional(repository),
  format: asOptional((value: unknown): 'pipeline' | 'script' => {
    if (value !== 'pipeline' && value !== 'script')
      throw new Error('format is pipeline or script')
    return value
  }),
  // null clears these fields, so they keep null instead of treating it as missing.
  entrypoint: (value: unknown): string | null | undefined =>
    value === undefined
      ? undefined
      : value === null
        ? null
        : relativePath(value),
  timeoutSeconds: asOptional(integer(1, 86400)),
  enabled: asOptional(asBoolean),
  position: asOptional(integer()),
  defaultBranch: asOptional(branchName),
  webhookSecret: (
    value: unknown,
  ): string | { keep: true } | null | undefined => {
    if (value === undefined) return undefined
    if (value === null) return null
    if (
      typeof value === 'object' &&
      (value as { keep?: unknown }).keep === true
    )
      return { keep: true }
    return text(256, 16)(value)
  },
  script: asOptional(
    asObject({
      workspace: asOptional(relativePath),
      platforms: asOptional(asArray(asPlatform)),
      on: asOptional(asNodeSelector),
    }),
  ),
})

const asAppInput = asObject({
  bundleId: text(160),
  name: text(120),
  platforms: asArray(asPlatform),
})

const asSecretsInput = asObject({
  env: asOptional(
    asArray(
      asObject({
        name: envName,
        value: asOptional(asString),
        keep: asOptional(asBoolean),
        secret: asOptional(asBoolean, true),
      }),
    ),
    [],
  ),
  files: asOptional(
    asArray(
      asObject({
        destination: relativePath,
        contents: asOptional(asString),
        keep: asOptional(asBoolean),
        env: asOptional(envName),
      }),
    ),
    [],
  ),
})

type Row = Record<string, unknown>

/** Projects: a repository, the app IDs it owns, its secrets and branch rules. */
export class Projects {
  constructor(readonly master: MasterDatabase) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }

  private view(row: Row): Project {
    const id = Number(row.id)
    const apps = this.db
      .prepare(
        'SELECT a.id,a.slug,a.name FROM project_apps pa JOIN apps a ON a.id=pa.app_id WHERE pa.project_id=? ORDER BY a.position,a.id',
      )
      .all(id)
      .map((app) => ({
        id: Number(app.id),
        bundleId: String(app.slug),
        name: String(app.name),
        platforms: this.db
          .prepare(
            'SELECT platform FROM channels WHERE app_id=? AND enabled=1 ORDER BY platform',
          )
          .all(Number(app.id))
          .map((channel) => asPlatform(channel.platform)),
      }))
    const script = JSON.parse(String(row.script)) as Project['script']
    return {
      id,
      slug: String(row.slug),
      name: String(row.name),
      repository: String(row.repository),
      format: row.format === 'pipeline' ? 'pipeline' : 'script',
      ...(row.entrypoint == null ? {} : { entrypoint: String(row.entrypoint) }),
      timeoutSeconds: Number(row.timeout_seconds),
      enabled: row.enabled === 1,
      position: Number(row.position),
      defaultBranch: String(row.default_branch),
      script,
      webhookSecret: { set: row.webhook_secret != null },
      apps,
      rules: this.rules(id),
      env: this.db
        .prepare(
          'SELECT name,secret FROM project_env WHERE project_id=? ORDER BY name',
        )
        .all(id)
        .map((env) => ({ name: String(env.name), secret: env.secret === 1 })),
      files: this.db
        .prepare(
          'SELECT destination,env FROM project_files WHERE project_id=? ORDER BY destination',
        )
        .all(id)
        .map((file) => ({
          destination: String(file.destination),
          ...(file.env == null ? {} : { env: String(file.env) }),
        })),
    }
  }
  private row(slug: string): Row {
    const row = this.db.prepare('SELECT * FROM projects WHERE slug=?').get(slug)
    if (row == null) throw new ProjectNotFound(slug)
    return row
  }

  list(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY position,id')
      .all()
      .map((row) => this.view(row))
  }
  get(slug: string): Project {
    return this.view(this.row(slug))
  }
  /** The project owning an app ID, or the project with that slug. */
  resolve(appOrProject: string): Project | undefined {
    const project = this.db
      .prepare('SELECT * FROM projects WHERE slug=?')
      .get(appOrProject)
    if (project != null) return this.view(project)
    const owned = this.db
      .prepare(
        'SELECT p.* FROM projects p JOIN project_apps pa ON pa.project_id=p.id JOIN apps a ON a.id=pa.app_id WHERE a.slug=?',
      )
      .get(appOrProject)
    return owned == null ? undefined : this.view(owned)
  }
  rules(projectId: number): BranchRule[] {
    return this.db
      .prepare(
        'SELECT pattern,mode FROM branch_rules WHERE project_id=? ORDER BY position',
      )
      .all(projectId)
      .map((rule) => ({
        pattern: String(rule.pattern),
        mode: rule.mode === 'automatic' ? 'automatic' : 'request',
      }))
  }
  /** Secret values, for the master to deliver to a stage. */
  secrets(projectId: number): {
    env: Array<{ name: string; value: string; secret: boolean }>
    files: Array<{ destination: string; contents: string; env?: string }>
  } {
    return {
      env: this.db
        .prepare(
          'SELECT name,value,secret FROM project_env WHERE project_id=? ORDER BY name',
        )
        .all(projectId)
        .map((env) => ({
          name: String(env.name),
          value: String(env.value),
          secret: env.secret === 1,
        })),
      files: this.db
        .prepare(
          'SELECT destination,contents,env FROM project_files WHERE project_id=? ORDER BY destination',
        )
        .all(projectId)
        .map((file) => ({
          destination: String(file.destination),
          contents: String(file.contents),
          ...(file.env == null ? {} : { env: String(file.env) }),
        })),
    }
  }
  webhookSecret(projectId: number): string | undefined {
    const row = this.db
      .prepare('SELECT webhook_secret FROM projects WHERE id=?')
      .get(projectId)
    return row?.webhook_secret == null ? undefined : String(row.webhook_secret)
  }

  /** Creates a project, or updates the fields given. */
  save(
    actor: Actor,
    slugValue: unknown,
    value: unknown,
  ): { created: boolean; project: Project } {
    requireRole(actor, 'manager')
    const slug = asProjectSlug(slugValue)
    const input = asProjectInput(value ?? {})
    return this.master.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM projects WHERE slug=?')
        .get(slug)
      if (existing == null) {
        if (input.repository == null)
          throw new Error('A new project needs a repository')
        if (
          input.webhookSecret != null &&
          typeof input.webhookSecret !== 'string'
        )
          throw new Error('No stored webhook secret to keep')
        this.db
          .prepare(
            'INSERT INTO projects(slug,name,repository,format,entrypoint,timeout_seconds,enabled,position,default_branch,webhook_secret,script,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            slug,
            input.name ?? slug,
            input.repository,
            input.format ?? 'pipeline',
            input.entrypoint ?? null,
            input.timeoutSeconds ?? 14400,
            Number(input.enabled ?? true),
            input.position ?? 0,
            input.defaultBranch ?? 'master',
            input.webhookSecret ?? null,
            JSON.stringify(input.script ?? {}),
            this.master.now(),
          )
      } else {
        const keep =
          typeof input.webhookSecret === 'object' && input.webhookSecret != null
        this.db
          .prepare(
            'UPDATE projects SET name=?,repository=?,format=?,entrypoint=?,timeout_seconds=?,enabled=?,position=?,default_branch=?,webhook_secret=?,script=? WHERE slug=?',
          )
          .run(
            input.name ?? String(existing.name),
            input.repository ?? String(existing.repository),
            input.format ?? String(existing.format),
            input.entrypoint === undefined
              ? (existing.entrypoint as string | null)
              : input.entrypoint,
            input.timeoutSeconds ?? Number(existing.timeout_seconds),
            input.enabled == null
              ? Number(existing.enabled)
              : Number(input.enabled),
            input.position ?? Number(existing.position),
            input.defaultBranch ?? String(existing.default_branch),
            input.webhookSecret === undefined || keep
              ? ((existing.webhook_secret as string | null) ?? null)
              : (input.webhookSecret as string | null),
            input.script == null
              ? String(existing.script)
              : JSON.stringify(input.script),
            slug,
          )
      }
      this.master.audit(
        actor,
        existing == null ? 'project.create' : 'project.update',
        slug,
      )
      this.master.change('project', slug)
      return { created: existing == null, project: this.get(slug) }
    })
  }

  remove(actor: Actor, slug: string): void {
    requireRole(actor, 'manager')
    this.master.transaction(() => {
      const row = this.row(slug)
      const busy = this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')",
        )
        .get(Number(row.id))
      if (busy != null)
        throw new ProjectConflict('The project has queued or running jobs')
      this.db.prepare('DELETE FROM jobs WHERE project_id=?').run(Number(row.id))
      this.db.prepare('DELETE FROM projects WHERE id=?').run(Number(row.id))
      this.master.audit(actor, 'project.remove', slug)
      this.master.change('project', slug, 'delete')
    })
  }

  /**
   * Gives a project an app ID with its platforms, creating the app and a
   * channel per platform. An app belongs to one project only.
   */
  addApp(actor: Actor, slug: string, value: unknown): ProjectApp {
    requireRole(actor, 'manager')
    const input = asAppInput(value)
    if (
      input.platforms.length === 0 ||
      new Set(input.platforms).size !== input.platforms.length
    )
      throw new Error('Name each platform once')
    return this.master.transaction(() => {
      const project = Number(this.row(slug).id)
      let app = this.db
        .prepare('SELECT id FROM apps WHERE slug=?')
        .get(input.bundleId)?.id as number | undefined
      if (app == null)
        app = Number(
          this.db
            .prepare(
              'INSERT INTO apps(slug,name,position,enabled) VALUES(?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM apps),1)',
            )
            .run(input.bundleId, input.name).lastInsertRowid,
        )
      else
        this.db
          .prepare('UPDATE apps SET name=? WHERE id=?')
          .run(input.name, app)
      const owner = this.db
        .prepare('SELECT project_id FROM project_apps WHERE app_id=?')
        .get(app)
      if (owner != null && Number(owner.project_id) !== project)
        throw new ProjectConflict(
          `${input.bundleId} belongs to another project`,
        )
      this.db
        .prepare(
          'INSERT OR IGNORE INTO project_apps(app_id,project_id) VALUES(?,?)',
        )
        .run(app, project)
      for (const platform of input.platforms) {
        const channel = this.db
          .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
          .get(app, platform)
        if (channel == null)
          this.db
            .prepare(
              'INSERT INTO channels(app_id,platform,channel_key,formats,enabled) VALUES(?,?,?,?,1)',
            )
            .run(
              app,
              platform,
              randomBytes(24).toString('base64url'),
              JSON.stringify(formats[platform]),
            )
        else
          this.db
            .prepare('UPDATE channels SET enabled=1 WHERE id=?')
            .run(Number(channel.id))
      }
      this.db
        .prepare(
          `UPDATE channels SET enabled=0 WHERE app_id=? AND platform NOT IN (${input.platforms.map(() => '?').join(',')})`,
        )
        .run(app, ...input.platforms)
      this.master.audit(actor, 'project.app', `${slug}:${input.bundleId}`)
      this.master.change('app', app)
      return this.get(slug).apps.find((item) => item.id === app)!
    })
  }

  /** Releases an app ID from a project; the app and its builds stay. */
  removeApp(actor: Actor, slug: string, bundleId: string): void {
    requireRole(actor, 'manager')
    this.master.transaction(() => {
      const project = Number(this.row(slug).id)
      const result = this.db
        .prepare(
          'DELETE FROM project_apps WHERE project_id=? AND app_id=(SELECT id FROM apps WHERE slug=?)',
        )
        .run(project, bundleId)
      if (result.changes === 0) throw new ProjectNotFound(`${slug}/${bundleId}`)
      this.master.audit(actor, 'project.app.remove', `${slug}:${bundleId}`)
      this.master.change('project', slug)
    })
  }

  /**
   * Replaces a project's secrets. Values are write-only: an entry with
   * `keep: true` reuses the stored value, and an entry left out is removed.
   */
  setSecrets(actor: Actor, slug: string, value: unknown): Project {
    requireRole(actor, 'manager')
    const input = asSecretsInput(value ?? {})
    return this.master.transaction(() => {
      const project = Number(this.row(slug).id)
      const stored = this.secrets(project)
      const env = input.env.map((entry) => {
        if (entry.keep === true) {
          const old = stored.env.find((item) => item.name === entry.name)
          if (old == null)
            throw new Error(`No stored value of ${entry.name} to keep`)
          return { ...old, secret: entry.secret }
        }
        if (
          entry.value == null ||
          entry.value.length > 65536 ||
          entry.value.includes('\0')
        )
          throw new Error(`Invalid value for ${entry.name}`)
        return { name: entry.name, value: entry.value, secret: entry.secret }
      })
      const files = input.files.map((entry) => {
        if (entry.keep === true) {
          const old = stored.files.find(
            (item) => item.destination === entry.destination,
          )
          if (old == null)
            throw new Error(`No stored file ${entry.destination} to keep`)
          return { ...old, ...(entry.env == null ? {} : { env: entry.env }) }
        }
        if (
          entry.contents == null ||
          Buffer.from(entry.contents, 'base64').toString('base64') !==
            entry.contents
        )
          throw new Error(`File ${entry.destination} needs base64 contents`)
        return {
          destination: entry.destination,
          contents: entry.contents,
          ...(entry.env == null ? {} : { env: entry.env }),
        }
      })
      const names = [
        ...env.map((entry) => entry.name),
        ...files.flatMap((file) => (file.env == null ? [] : [file.env])),
      ]
      if (
        new Set(names).size !== names.length ||
        new Set(files.map((file) => file.destination)).size !== files.length
      )
        throw new Error('Duplicate secret')
      this.db.prepare('DELETE FROM project_env WHERE project_id=?').run(project)
      this.db
        .prepare('DELETE FROM project_files WHERE project_id=?')
        .run(project)
      for (const entry of env)
        this.db
          .prepare(
            'INSERT INTO project_env(project_id,name,value,secret) VALUES(?,?,?,?)',
          )
          .run(project, entry.name, entry.value, Number(entry.secret))
      for (const file of files)
        this.db
          .prepare(
            'INSERT INTO project_files(project_id,destination,contents,env) VALUES(?,?,?,?)',
          )
          .run(project, file.destination, file.contents, file.env ?? null)
      this.master.audit(actor, 'project.secrets', slug)
      return this.get(slug)
    })
  }

  setRules(actor: Actor, slug: string, value: unknown): Project {
    requireRole(actor, 'manager')
    const rules = asRules(value)
    return this.master.transaction(() => {
      const project = Number(this.row(slug).id)
      this.db
        .prepare('DELETE FROM branch_rules WHERE project_id=?')
        .run(project)
      rules.forEach((rule, position) =>
        this.db
          .prepare(
            'INSERT INTO branch_rules(project_id,position,pattern,mode) VALUES(?,?,?,?)',
          )
          .run(project, position, rule.pattern, rule.mode),
      )
      this.master.audit(actor, 'project.rules', slug)
      return this.get(slug)
    })
  }
}
