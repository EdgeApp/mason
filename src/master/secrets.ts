import type { DatabaseSync } from 'node:sqlite'
import { asObject, asOptional, asString } from 'cleaners'
import { envName, relativePath } from '../builder/config.js'
import {
  asConfigs,
  isReservedName,
  MAX_FILE,
  MAX_VALUE,
  tooLarge,
} from '../pipeline/variants.js'
import { BackupFailed, type BackupMutation, type Backups } from './backup.js'
import type { MasterDatabase } from './database.js'
import { allow } from './permissions.js'
import { Forbidden, type Actor } from './roles.js'

/** One variant of a secret, as anyone who may see the project sees it: never its contents. */
export interface SecretVariant {
  id: number
  name: string
  kind: 'value' | 'file'
  /** Empty: every config (the default variant). */
  configs: string[]
  /** Values always; files when they are UTF-8 with no NUL. */
  text: boolean
  /** False only in script projects: a value added unmasked, or migrated from plain environment. */
  masked: boolean
  /** Script projects: the variable that holds an injected file's path. */
  pathEnv?: string
  /** Script projects: the path a migrated file is injected at; a file added on the tab is injected at its name. */
  destination?: string
  bytes: number
  updatedAt: number
}
/** A variant with its contents: a value's text, or a file's bytes in base64. */
export interface StoredVariant extends SecretVariant {
  contents: string
}

/** One audit entry; `detail` never holds a value. */
export interface SecretAuditEntry {
  id: number
  name: string
  configs: string[]
  action: AuditAction
  /** The person's name, the API key's name, or how the actor was labelled. */
  who: string
  address: string
  at: number
  detail?: string
}
type AuditAction =
  | 'viewed'
  | 'added'
  | 'edited'
  | 'replaced'
  | 'deleted'
  | 'configs changed'
  | 'refused'

/** No such project or variant (404). */
export class SecretNotFound extends Error {}
/** A change refused for want of backups (409). */
export class SecretsNeedBackups extends Error {
  constructor() {
    super('Configure backups before changing secrets')
  }
}
/** The change's backup was not pushed, so the change was not made (502). */
export class BackupRefused extends Error {}
/**
 * The change was not saved, for a reason that is neither the caller's nor
 * the backup's (500): it failed on the snapshot copy before anything was
 * pushed, or the backup holds it but the live database could not take it.
 */
export class NotApplied extends Error {}

const configsKey = (configs: string[]): string => configs.join(',')
const configsOf = (key: string): string[] => (key === '' ? [] : key.split(','))

/** Whether bytes are text the editor can show: valid UTF-8 with no NUL. */
export function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

type Row = Record<string, unknown>
const variantOf = (row: Row): StoredVariant => ({
  id: Number(row.id),
  name: String(row.name),
  kind: row.kind === 'file' ? 'file' : 'value',
  configs: configsOf(String(row.configs)),
  text: row.text === 1,
  masked: row.masked === 1,
  ...(row.path_env == null ? {} : { pathEnv: String(row.path_env) }),
  ...(row.destination == null ? {} : { destination: String(row.destination) }),
  bytes: Number(row.bytes),
  updatedAt: Number(row.updated_at),
  contents: String(row.contents),
})
// By name, then the default variant (configs '' compares 0) before the others.
const ORDER = "ORDER BY name, configs<>'', configs, id"

/** A project's variants with their contents, for the master to deliver to stages. */
export function storedVariants(
  db: DatabaseSync,
  projectId: number,
): StoredVariant[] {
  return db
    .prepare(`SELECT * FROM project_secrets WHERE project_id=? ${ORDER}`)
    .all(projectId)
    .map(variantOf)
}
/** A project's variants without their contents. */
export function listVariants(
  db: DatabaseSync,
  projectId: number,
): SecretVariant[] {
  // Without reading the contents: up to 5 MiB of base64 a file.
  return db
    .prepare(
      `SELECT id,project_id,name,kind,configs,'' AS contents,text,masked,path_env,destination,bytes,updated_at FROM project_secrets WHERE project_id=? ${ORDER}`,
    )
    .all(projectId)
    .map(variantOf)
    .map(withoutContents)
}
function withoutContents({
  contents: _contents,
  ...variant
}: StoredVariant): SecretVariant {
  return variant
}

/** Legacy secrets: an old Mason app definition's environment and files, as `project_env` and `project_files` held them. */
export interface LegacySecrets {
  env: Array<{ name: string; value: string; secret: boolean }>
  files: Array<{ destination: string; contents: string; env?: string }>
}
/** A new `project_secrets` row. */
export interface SecretRow {
  name: string
  kind: 'value' | 'file'
  configs: string
  contents: string
  text: number
  masked: number
  pathEnv: string | null
  destination: string | null
  bytes: number
}

/**
 * Maps legacy secrets to variants, all default ones. Values keep their names.
 * A pipeline file is named by its variable, else its destination, as
 * stages declared it; a script file by its destination, and it keeps that
 * destination to be injected at. A name that fails the file-name rule has
 * its disallowed characters replaced, and a taken name falls back to the
 * destination, then gains `.file` until it is free.
 */
export function legacyRows(
  format: 'pipeline' | 'script',
  legacy: LegacySecrets,
): SecretRow[] {
  const taken = new Set<string>()
  const rows: SecretRow[] = legacy.env.map((entry) => {
    taken.add(entry.name)
    return {
      name: entry.name,
      kind: 'value',
      configs: '',
      contents: entry.value,
      text: 1,
      masked: entry.secret ? 1 : 0,
      pathEnv: null,
      destination: null,
      bytes: Buffer.byteLength(entry.value),
    }
  })
  const safe = (name: string): string =>
    name
      .split('/')
      .map((part) =>
        part.toLowerCase() === '.git'
          ? '_git'
          : part === '.' || part === '..' || part === ''
            ? '_'
            : part.replace(/[^A-Za-z0-9_.-]/g, '_'),
      )
      .join('/')
  const files = [...legacy.files].sort(
    (a, b) =>
      Number(a.env == null) - Number(b.env == null) ||
      (a.destination < b.destination
        ? -1
        : a.destination > b.destination
          ? 1
          : 0),
  )
  for (const file of files) {
    let name = safe(
      format === 'pipeline' ? (file.env ?? file.destination) : file.destination,
    )
    if (taken.has(name)) name = safe(file.destination)
    while (taken.has(name)) name += '.file'
    taken.add(name)
    const bytes = Buffer.from(file.contents, 'base64')
    rows.push({
      name,
      kind: 'file',
      configs: '',
      contents: file.contents,
      text: isText(bytes) ? 1 : 0,
      masked: 1,
      pathEnv: file.env ?? null,
      destination: format === 'script' ? file.destination : null,
      bytes: bytes.length,
    })
  }
  return rows
}

/** Inserts variant rows for a project, with the given ids or new ones; returns their ids. */
export function insertRows(
  db: DatabaseSync,
  projectId: number,
  rows: Array<SecretRow & { id?: number }>,
  now: number,
): number[] {
  const insert = db.prepare(
    'INSERT INTO project_secrets(id,project_id,name,kind,configs,contents,text,masked,path_env,destination,bytes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  )
  return rows.map((row) =>
    Number(
      insert.run(
        row.id ?? null,
        projectId,
        row.name,
        row.kind,
        row.configs,
        row.contents,
        row.text,
        row.masked,
        row.pathEnv,
        row.destination,
        row.bytes,
        now,
      ).lastInsertRowid,
    ),
  )
}

/** A new variant, as `add` and the test fixtures make one. */
export function variantRow(variant: {
  name: string
  kind: 'value' | 'file'
  configs: string[]
  /** A value's text, or a file's bytes in base64. */
  contents: string
  masked?: boolean
  pathEnv?: string
  destination?: string
}): SecretRow {
  const bytes =
    variant.kind === 'value'
      ? Buffer.from(variant.contents)
      : Buffer.from(variant.contents, 'base64')
  return {
    name: variant.name,
    kind: variant.kind,
    configs: configsKey(variant.configs),
    contents: variant.contents,
    text: variant.kind === 'value' || isText(bytes) ? 1 : 0,
    masked: variant.masked === false ? 0 : 1,
    pathEnv: variant.pathEnv ?? null,
    destination: variant.destination ?? null,
    bytes: bytes.length,
  }
}

const asKind = (value: unknown): 'value' | 'file' => {
  if (value !== 'value' && value !== 'file')
    throw new Error('kind is value or file')
  return value
}
const asFlag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('masked is true or false')
  return value
}
/**
 * The bodies the routes take, by type. The name, value, contents and path
 * variable are then held to the rules of the variant's kind below.
 */
const asAddBody = asObject({
  kind: asKind,
  name: asString,
  configs: asOptional(asConfigs, []),
  value: asOptional(asString),
  contents: asOptional(asString),
  masked: asOptional(asFlag),
  pathEnv: asOptional(asString),
})
const asEditBody = asObject({
  value: asOptional(asString),
  text: asOptional(asString),
})
const asReplaceBody = asObject({ contents: asString })
const asConfigsBody = asObject({ configs: asConfigs })

/** A variant id from a route: a positive integer, else no such variant. */
function asVariantId(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return value
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value))
    throw new SecretNotFound(`No secret ${String(value).slice(0, 40)}`)
  return Number(value)
}
type AddBody = ReturnType<typeof asAddBody>

/** What a refusal is recorded about: the variant, when it can be told, else `*`. */
function aboutOr(
  about: (() => { name: string; configs: string[] }) | undefined,
): { name: string; configs: string[] } {
  try {
    return about?.() ?? { name: '*', configs: [] }
  } catch {
    // An unknown variant is refused all the same.
    return { name: '*', configs: [] }
  }
}

/** A refused add's name for the audit: what was sent, if it is text, cut short. */
function auditName(value: unknown): string {
  const name = (value as { name?: unknown } | null)?.name
  return typeof name === 'string' && name !== '' ? name.slice(0, 120) : '*'
}

/** Who did it, for the audit: the actor and the address the request came from. */
export interface SecretsCaller {
  actor: Actor
  address: string
}

function checkValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`The value of ${name} is text`)
  if (Buffer.byteLength(value) > MAX_VALUE)
    throw new Error(`The value of ${name} is over ${MAX_VALUE / 1024} KiB`)
  if (value.includes('\0')) throw new Error(`The value of ${name} has a NUL`)
  return value
}
function checkContents(value: unknown, name: string): Buffer {
  if (
    typeof value !== 'string' ||
    Buffer.from(value, 'base64').toString('base64') !== value
  )
    throw new Error(`The file ${name} needs base64 contents`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_FILE) throw new Error(tooLarge(`The file ${name}`))
  return bytes
}

/**
 * A project's secrets: named variants, values or files, each limited to
 * build configs. Every fetch of contents is audited as viewed; every change
 * runs in the backup queue, is pushed in a backup first, and is applied and
 * audited only once that push succeeds.
 */
export class Secrets {
  constructor(
    private readonly master: MasterDatabase,
    private readonly backups: Backups,
  ) {}
  private get db(): DatabaseSync {
    return this.master.db
  }

  private projectId(slug: string): number | undefined {
    const row = this.db
      .prepare('SELECT id FROM projects WHERE slug=?')
      .get(slug)
    return row == null ? undefined : Number(row.id)
  }
  private project(slug: string): number {
    const id = this.projectId(slug)
    if (id == null) throw new SecretNotFound(`No project named ${slug}`)
    return id
  }
  private format(projectId: number): 'pipeline' | 'script' {
    const row = this.db
      .prepare('SELECT format FROM projects WHERE id=?')
      .get(projectId)
    return row?.format === 'script' ? 'script' : 'pipeline'
  }
  private variant(projectId: number, id: unknown): StoredVariant {
    const row = this.db
      .prepare('SELECT * FROM project_secrets WHERE id=? AND project_id=?')
      .get(asVariantId(id), projectId)
    if (row == null) throw new SecretNotFound(`No secret ${String(id)}`)
    return variantOf(row)
  }

  /** A variant as a change answers it: never its contents. */
  private shown(projectId: number, id: number): SecretVariant {
    return withoutContents(this.variant(projectId, id))
  }

  private record(
    caller: SecretsCaller,
    projectId: number,
    variant: { name: string; configs: string[] },
    action: AuditAction,
    detail?: string,
    db: DatabaseSync = this.db,
  ): void {
    db.prepare(
      'INSERT INTO secret_audit(project_id,name,configs,action,account_id,key_id,via,address,at,detail) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      projectId,
      variant.name.slice(0, 255),
      configsKey(variant.configs),
      action,
      caller.actor.accountId ?? null,
      caller.actor.keyId ?? null,
      caller.actor.label,
      caller.address,
      this.master.now(),
      detail == null ? null : detail.slice(0, 1000),
    )
  }

  /**
   * Records a refusal without letting a failing audit write (a full disk,
   * say) replace the refusal the caller should get.
   */
  private recordRefusal(
    caller: SecretsCaller,
    projectId: number,
    variant: { name: string; configs: string[] },
    detail: string,
  ): void {
    try {
      this.record(caller, projectId, variant, 'refused', detail)
    } catch (error) {
      console.error(
        `Could not audit a refused secret change: ${(error as Error).message}`,
      )
    }
  }

  /**
   * Checks the role (and a key's project scope), auditing a refusal against
   * the project when it exists; an unknown project is a plain 403 then.
   */
  private allowed(
    caller: SecretsCaller,
    slug: string,
    action: 'projects.read' | 'secrets.read' | 'secrets.change',
    variant?: () => { name: string; configs: string[] },
  ): number {
    try {
      allow(caller.actor, action, { project: slug })
    } catch (error) {
      const projectId = this.projectId(slug)
      if (error instanceof Forbidden && projectId != null)
        this.recordRefusal(
          caller,
          projectId,
          aboutOr(variant),
          (error as Error).message,
        )
      throw error
    }
    return this.project(slug)
  }

  /** The project's variants, for anyone who may see the project: names, kinds and configs, never contents. */
  list(caller: SecretsCaller, slug: string): SecretVariant[] {
    const projectId = this.allowed(caller, slug, 'projects.read')
    return listVariants(this.db, projectId)
  }

  /** A variant's contents for an administrator or manager; audited as viewed. */
  contents(
    caller: SecretsCaller,
    slug: string,
    id: unknown,
  ): { value: string } | { text: string } | { contents: string } {
    const lookup = (): StoredVariant => this.variant(this.project(slug), id)
    const projectId = this.allowed(caller, slug, 'secrets.read', lookup)
    const variant = this.variant(projectId, id)
    this.record(caller, projectId, variant, 'viewed')
    if (variant.kind === 'value') return { value: variant.contents }
    if (variant.text)
      return {
        text: Buffer.from(variant.contents, 'base64').toString('utf8'),
      }
    return { contents: variant.contents }
  }

  /** The latest audit entries, newest first, for administrators and managers. */
  audit(caller: SecretsCaller, slug: string, limit = 200): SecretAuditEntry[] {
    const projectId = this.allowed(caller, slug, 'secrets.read')
    const count = Math.min(Math.max(Math.trunc(Number(limit)) || 200, 1), 1000)
    return this.db
      .prepare(
        `SELECT s.*, a.name AS account_name, k.name AS key_name
         FROM secret_audit s
         LEFT JOIN accounts a ON a.id=s.account_id
         LEFT JOIN api_keys k ON k.id=s.key_id
         WHERE s.project_id=? ORDER BY s.id DESC LIMIT ?`,
      )
      .all(projectId, count)
      .map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        configs: configsOf(String(row.configs)),
        action: String(row.action) as AuditAction,
        who:
          row.key_id != null
            ? `API key ${row.key_name == null ? String(row.key_id) : String(row.key_name)}`
            : row.account_name != null
              ? String(row.account_name)
              : String(row.via),
        address: String(row.address),
        at: Number(row.at),
        ...(row.detail == null ? {} : { detail: String(row.detail) }),
      }))
  }

  /** Adds a variant. */
  async add(
    caller: SecretsCaller,
    slug: string,
    value: unknown,
  ): Promise<SecretVariant> {
    return await this.change(
      caller,
      slug,
      () => ({ name: auditName(value), configs: [] }),
      (projectId) => {
        const row = variantRow(this.addInput(projectId, asAddBody(value)))
        // The id is chosen here, not by SQLite, so the snapshot copy and the
        // live database get the same one; ids are never reused, so a page
        // still holding a deleted variant's id cannot reach a new one.
        const id = Number(
          (
            this.db
              .prepare(
                "SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='project_secrets'),0),COALESCE((SELECT MAX(id) FROM project_secrets),0))+1 AS id",
              )
              .get() as { id: number }
          ).id,
        )
        return {
          variant: { name: row.name, configs: configsOf(row.configs) },
          action: 'added',
          mutate: (db) =>
            insertRows(db, projectId, [{ ...row, id }], this.master.now()),
          result: () => this.shown(projectId, id),
        }
      },
    )
  }

  /** A new value, or new text for a text file. */
  async edit(
    caller: SecretsCaller,
    slug: string,
    id: unknown,
    value: unknown,
  ): Promise<SecretVariant> {
    return await this.change(
      caller,
      slug,
      () => this.variant(this.project(slug), id),
      (projectId) => {
        const input = asEditBody(value)
        const variant = this.variant(projectId, id)
        let contents: string
        let bytes: number
        if (variant.kind === 'value') {
          contents = checkValue(input.value, variant.name)
          bytes = Buffer.byteLength(contents)
        } else {
          if (!variant.text)
            throw new Error('A binary file can only be replaced')
          if (typeof input.text !== 'string')
            throw new Error(`The text of ${variant.name} is a string`)
          const encoded = Buffer.from(input.text, 'utf8')
          if (encoded.length > MAX_FILE)
            throw new Error(tooLarge(`The file ${variant.name}`))
          if (encoded.includes(0))
            throw new Error(`The text of ${variant.name} has a NUL`)
          contents = encoded.toString('base64')
          bytes = encoded.length
        }
        return {
          variant,
          action: 'edited',
          mutate: (db) =>
            db
              .prepare(
                'UPDATE project_secrets SET contents=?,bytes=?,updated_at=? WHERE id=?',
              )
              .run(contents, bytes, this.master.now(), variant.id),
          result: () => this.shown(projectId, variant.id),
        }
      },
    )
  }

  /** New bytes for a file. */
  async replace(
    caller: SecretsCaller,
    slug: string,
    id: unknown,
    value: unknown,
  ): Promise<SecretVariant> {
    return await this.change(
      caller,
      slug,
      () => this.variant(this.project(slug), id),
      (projectId) => {
        const input = asReplaceBody(value)
        const variant = this.variant(projectId, id)
        if (variant.kind !== 'file')
          throw new Error(`${variant.name} is a value: edit it instead`)
        const bytes = checkContents(input.contents, variant.name)
        const contents = input.contents as string
        return {
          variant,
          action: 'replaced',
          mutate: (db) =>
            db
              .prepare(
                'UPDATE project_secrets SET contents=?,text=?,bytes=?,updated_at=? WHERE id=?',
              )
              .run(
                contents,
                isText(bytes) ? 1 : 0,
                bytes.length,
                this.master.now(),
                variant.id,
              ),
          result: () => this.shown(projectId, variant.id),
        }
      },
    )
  }

  /** New build configs for a variant. */
  async setConfigs(
    caller: SecretsCaller,
    slug: string,
    id: unknown,
    value: unknown,
  ): Promise<SecretVariant> {
    return await this.change(
      caller,
      slug,
      () => this.variant(this.project(slug), id),
      (projectId) => {
        const input = asConfigsBody(value)
        const variant = this.variant(projectId, id)
        const configs = input.configs
        this.checkScriptConfigs(projectId, configs)
        this.checkPlacement(projectId, variant.name, variant.kind, configs, [
          variant.id,
        ])
        const label = (list: string[]): string =>
          list.length === 0 ? 'all' : list.join(', ')
        return {
          variant: { name: variant.name, configs },
          action: 'configs changed',
          detail: `${label(variant.configs)} → ${label(configs)}`,
          mutate: (db) =>
            db
              .prepare(
                'UPDATE project_secrets SET configs=?,updated_at=? WHERE id=?',
              )
              .run(configsKey(configs), this.master.now(), variant.id),
          result: () => this.shown(projectId, variant.id),
        }
      },
    )
  }

  /** Deletes a variant. */
  async remove(
    caller: SecretsCaller,
    slug: string,
    id: unknown,
  ): Promise<null> {
    return await this.change(
      caller,
      slug,
      () => this.variant(this.project(slug), id),
      (projectId) => {
        const variant = this.variant(projectId, id)
        return {
          variant,
          action: 'deleted',
          mutate: (db) =>
            db
              .prepare('DELETE FROM project_secrets WHERE id=?')
              .run(variant.id),
          result: () => null,
        }
      },
    )
  }

  private addInput(
    projectId: number,
    input: AddBody,
  ): Parameters<typeof variantRow>[0] {
    const kind = input.kind
    const name =
      kind === 'value' ? envName(input.name) : relativePath(input.name)
    if (kind === 'value' && isReservedName(name))
      throw new Error(
        `${name} is set by the build environment; give the secret another name`,
      )
    const configs = input.configs
    const script = this.format(projectId) === 'script'
    if (!script && (input.masked != null || input.pathEnv != null))
      throw new Error('masked and pathEnv are for script projects')
    if (kind === 'value' && input.pathEnv != null)
      throw new Error('pathEnv is for files')
    if (kind === 'file' && input.masked != null)
      throw new Error('masked is for values')
    this.checkScriptConfigs(projectId, configs)
    const pathEnv = input.pathEnv == null ? undefined : envName(input.pathEnv)
    this.checkPlacement(projectId, name, kind, configs, [])
    if (script) this.checkScript(projectId, name, kind, pathEnv)
    if (kind === 'value')
      return {
        name,
        kind,
        configs,
        contents: checkValue(input.value, name),
        masked: input.masked !== false,
      }
    checkContents(input.contents, name)
    return {
      name,
      kind,
      configs,
      contents: input.contents as string,
      ...(pathEnv == null ? {} : { pathEnv }),
    }
  }

  /** Script stages have no configs and take the default variants, so a script project's variants have none. */
  private checkScriptConfigs(projectId: number, configs: string[]): void {
    if (configs.length !== 0 && this.format(projectId) === 'script')
      throw new Error(
        "A script project's secrets have no build configs: its stages take the default variants",
      )
  }

  /** One kind per name, one default per name, and no config in two variants of a name. */
  private checkPlacement(
    projectId: number,
    name: string,
    kind: 'value' | 'file',
    configs: string[],
    except: number[],
  ): void {
    const others = listVariants(this.db, projectId).filter(
      (variant) => variant.name === name && !except.includes(variant.id),
    )
    if (others.some((variant) => variant.kind !== kind))
      throw new Error(
        `${name} is already a ${kind === 'value' ? 'file' : 'value'}`,
      )
    if (configs.length === 0) {
      if (others.some((variant) => variant.configs.length === 0))
        throw new Error(`${name} already has a variant for all configs`)
      return
    }
    for (const token of configs)
      if (others.some((variant) => variant.configs.includes(token)))
        throw new Error(`${name} already has a variant for ${token}`)
  }

  /** Script projects: no two files injected at one path, and no variable set twice. */
  private checkScript(
    projectId: number,
    name: string,
    kind: 'value' | 'file',
    pathEnv: string | undefined,
  ): void {
    const variants = listVariants(this.db, projectId)
    const variables = new Set([
      ...variants
        .filter((variant) => variant.kind === 'value')
        .map((variant) => variant.name),
      ...variants.flatMap((variant) =>
        variant.pathEnv == null ? [] : [variant.pathEnv],
      ),
    ])
    if (kind === 'value' && variables.has(name))
      throw new Error(`${name} is already set as a variable`)
    if (kind === 'file') {
      if (pathEnv != null && variables.has(pathEnv))
        throw new Error(`${pathEnv} is already set as a variable`)
      if (
        variants.some(
          (variant) =>
            variant.kind === 'file' &&
            (variant.destination ?? variant.name) === name,
        )
      )
        throw new Error(`A file is already injected at ${name}`)
    }
  }

  /**
   * Runs a change: the role check, then, holding the backup queue, the
   * validation against the live rows, the backup carrying the change, and
   * only once that is pushed the live change and its audit entry.
   */
  private async change<T>(
    caller: SecretsCaller,
    slug: string,
    about: () => { name: string; configs: string[] },
    plan: (projectId: number) => {
      variant: { name: string; configs: string[] }
      action: AuditAction
      detail?: string
      mutate: BackupMutation
      result: () => T
    },
  ): Promise<T> {
    const projectId = this.allowed(caller, slug, 'secrets.change', about)
    if (this.backups.status().configured !== true) {
      this.recordRefusal(
        caller,
        projectId,
        aboutOr(about),
        'backups are not configured',
      )
      throw new SecretsNeedBackups()
    }
    return await this.backups.change(async (push) => {
      // The project may have been deleted while this change waited.
      if (this.projectId(slug) !== projectId)
        throw new SecretNotFound(`No project named ${slug}`)
      const step = plan(projectId)
      try {
        // The backup holds the change's audit row too, so a master restored
        // from it can still say who made the change.
        await push((copy) => {
          step.mutate(copy)
          this.record(
            caller,
            projectId,
            step.variant,
            step.action,
            step.detail,
            copy,
          )
        })
      } catch (error) {
        // Not a failed push: the change failed on the snapshot copy, or the
        // backup could not start (unconfigured since, no scratch directory).
        // Nothing was pushed or saved. A stopping master is a BackupFailed,
        // refused below like a push that failed.
        if (!(error instanceof BackupFailed)) {
          const message = (error as Error).message
          this.recordRefusal(
            caller,
            projectId,
            step.variant,
            `not applied: ${message}`,
          )
          throw new NotApplied(`Not saved: ${message}`)
        }
        const message = error.message
        this.recordRefusal(
          caller,
          projectId,
          step.variant,
          `backup: ${message}`,
        )
        throw new BackupRefused(
          `Not saved: the backup could not be pushed (${message})`,
        )
      }
      // The project may have been deleted during the push: its rows went with it.
      if (this.projectId(slug) !== projectId)
        throw new SecretNotFound(`No project named ${slug}`)
      try {
        return this.master.transaction(() => {
          step.mutate(this.db)
          this.record(caller, projectId, step.variant, step.action, step.detail)
          this.master.change('project', slug)
          return step.result()
        })
      } catch (error) {
        const message = (error as Error).message
        this.recordRefusal(
          caller,
          projectId,
          step.variant,
          `pushed but not applied: ${message}`,
        )
        throw new NotApplied(`Pushed to the backup but not saved: ${message}`)
      }
    })
  }
}
