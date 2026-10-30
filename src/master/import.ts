import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { asDefinition } from '../builder/config.js'
import type { MasterDatabase } from './database.js'
import { insertRows, legacyRows } from './secrets.js'

export interface ImportSummary {
  accounts: number
  addresses: number
  invitedTesters: number
  groups: number
  apps: number
  channels: number
  builds: number
  devices: number
  keys: { upload: number; admin: number; developer: number }
  projects: number
  branchRules: number
  /** Distribution admin keys, now admin keys on /api/v2; their callers move. */
  adminKeys: Array<{ id: string; name: string }>
  /** Identities whose address another account already uses for that method. */
  skippedAddresses: number
}

export class ImportRefused extends Error {}

const count = (db: DatabaseSync, sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n)

function columns(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name))
}

/** Copies a table's rows with their IDs, for the columns both databases share. */
function copy(
  source: DatabaseSync,
  target: DatabaseSync,
  table: string,
  where = '1',
): number {
  const shared = columns(source, table).filter((column) =>
    columns(target, table).includes(column),
  )
  const rows = source
    .prepare(`SELECT ${shared.join(',')} FROM ${table} WHERE ${where}`)
    .all()
  const insert = target.prepare(
    `INSERT INTO ${table}(${shared.join(',')}) VALUES(${shared.map(() => '?').join(',')})`,
  )
  for (const row of rows)
    insert.run(...shared.map((column) => row[column] as never))
  return rows.length
}

function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true })
}

/**
 * Builds a master database from the current deployment's distribution and
 * builder databases, preserving IDs, key digests, channel keys and devices.
 * Each account takes the role its flags imply; each verified identity becomes
 * the account's address for that provider; each builder app becomes a script
 * project. The sources are opened read-only.
 */
export function importDeployment(
  master: MasterDatabase,
  files: { distribution: string; builder: string },
): ImportSummary {
  const db = master.db
  for (const table of ['accounts', 'apps', 'projects', 'api_keys', 'nodes'])
    if (count(db, `SELECT COUNT(*) n FROM ${table}`) > 0)
      throw new ImportRefused('Import needs an empty master database')
  const distribution = openReadOnly(files.distribution)
  const builder = openReadOnly(files.builder)
  try {
    const version = Number(
      (
        distribution.prepare('PRAGMA user_version').get() as {
          user_version: number
        }
      ).user_version,
    )
    if (version !== 7)
      throw new ImportRefused(
        `The distribution database is at schema ${version}; migrate it to 7 first (mason migrate --config …)`,
      )
    const builderVersion = (
      builder.prepare('SELECT version FROM builder_meta').get() as
        | { version: number }
        | undefined
    )?.version
    if (builderVersion !== 1)
      throw new ImportRefused('Unknown builder database schema')
    const now = master.now()
    return master.transaction(() => {
      const summary: ImportSummary = {
        accounts: copy(distribution, db, 'accounts'),
        addresses: 0,
        invitedTesters: 0,
        groups: 0,
        apps: copy(distribution, db, 'apps'),
        channels: copy(distribution, db, 'channels'),
        builds: copy(distribution, db, 'builds'),
        devices: copy(distribution, db, 'devices'),
        keys: { upload: 0, admin: 0, developer: 0 },
        projects: 0,
        branchRules: 0,
        adminKeys: [],
        skippedAddresses: 0,
      }
      for (const table of [
        'account_devices',
        'build_provisioning',
        'device_build_requests',
      ])
        copy(distribution, db, table)
      copy(distribution, db, 'audit')
      db.exec("UPDATE audit SET via='imported'")
      db.exec(
        "UPDATE accounts SET role=CASE WHEN is_admin=1 THEN 'admin' WHEN is_tester=1 THEN 'tester' ELSE 'tester' END",
      )
      const address = db.prepare(
        'INSERT INTO account_addresses(account_id,method,email) VALUES(?,?,?) ON CONFLICT DO NOTHING',
      )
      for (const identity of distribution
        .prepare(
          'SELECT account_id,provider,lower(email) email FROM identities WHERE email_verified=1 AND email IS NOT NULL ORDER BY id',
        )
        .all()) {
        const result = address.run(
          identity.account_id as number,
          identity.provider as string,
          identity.email as string,
        )
        if (result.changes === 1) summary.addresses++
        else summary.skippedAddresses++
      }
      // Pending invitations become testers with that address and no group.
      for (const invite of distribution
        .prepare(
          'SELECT provider,lower(email) email FROM invitations WHERE revoked=0 AND claimed_account IS NULL AND expires_at>? ORDER BY id',
        )
        .all(now)) {
        const taken = db
          .prepare('SELECT 1 FROM account_addresses WHERE method=? AND email=?')
          .get(invite.provider as string, invite.email as string)
        if (taken != null) continue
        const id = db
          .prepare(
            "INSERT INTO accounts(name,email,role,created_at) VALUES(?,?,'tester',?)",
          )
          .run(
            invite.email as string,
            invite.email as string,
            now,
          ).lastInsertRowid
        address.run(
          Number(id),
          invite.provider as string,
          invite.email as string,
        )
        summary.invitedTesters++
        summary.addresses++
      }
      for (const key of distribution
        .prepare('SELECT * FROM api_keys ORDER BY id')
        .all()) {
        db.prepare(
          "INSERT INTO api_keys(id,hash,name,apps,created_at,expires_at,revoked,role,format) VALUES(?,?,?,?,?,?,?,?,'v1')",
        ).run(
          key.id as string,
          key.hash as string,
          key.name as string,
          key.apps as string,
          key.created_at as number,
          (key.expires_at ?? null) as number | null,
          key.revoked as number,
          key.role as string,
        )
        if (key.role === 'admin') {
          summary.keys.admin++
          summary.adminKeys.push({
            id: key.id as string,
            name: key.name as string,
          })
        } else summary.keys.upload++
      }
      for (const key of builder
        .prepare('SELECT * FROM builder_keys ORDER BY id')
        .all()) {
        db.prepare(
          "INSERT INTO api_keys(id,hash,name,apps,created_at,role,format) VALUES(?,?,?,'\"all\"',?,'developer','builder')",
        ).run(
          String(key.id),
          String(key.digest),
          `Builder key ${String(key.id).slice(0, 8)}`,
          now,
        )
        summary.keys.developer++
      }
      // Every existing app goes into one group with every existing tester.
      const group = Number(
        db
          .prepare('INSERT INTO groups(name,created_at) VALUES(?,?)')
          .run('Imported testers', now).lastInsertRowid,
      )
      summary.groups = 1
      db.prepare(
        'INSERT INTO group_apps(group_id,app_id) SELECT ?,id FROM apps',
      ).run(group)
      db.prepare(
        'INSERT INTO group_members(group_id,account_id) SELECT ?,id FROM accounts WHERE is_tester=1',
      ).run(group)
      // Each builder app definition becomes a script project.
      const defaults = new Map(
        builder
          .prepare('SELECT app,default_branch FROM builder_app_settings')
          .all()
          .map((row) => [String(row.app), String(row.default_branch)]),
      )
      for (const row of builder
        .prepare('SELECT slug,definition FROM builder_apps ORDER BY slug')
        .all()) {
        const definition = asDefinition(JSON.parse(String(row.definition)))
        const project = Number(
          db
            .prepare(
              "INSERT INTO projects(slug,name,repository,format,entrypoint,timeout_seconds,enabled,position,default_branch,script,created_at) VALUES(?,?,?,'script',?,?,?,?,?,?,?)",
            )
            .run(
              definition.slug,
              definition.name,
              definition.repository,
              definition.entrypoint ?? null,
              definition.timeoutSeconds,
              Number(definition.enabled),
              definition.position,
              defaults.get(definition.slug) ?? 'master',
              JSON.stringify({
                workspace: definition.workspace,
                platforms: definition.platforms,
              }),
              now,
            ).lastInsertRowid,
        )
        summary.projects++
        let app = db
          .prepare('SELECT id FROM apps WHERE slug=?')
          .get(definition.slug)?.id as number | undefined
        if (app == null) {
          app = Number(
            db
              .prepare(
                'INSERT INTO apps(slug,name,position,enabled) VALUES(?,?,?,1)',
              )
              .run(definition.slug, definition.name, definition.position)
              .lastInsertRowid,
          )
          summary.apps++
        }
        db.prepare(
          'INSERT INTO project_apps(app_id,project_id) VALUES(?,?)',
        ).run(app, project)
        // An old Mason app's environment and files, as a script project's default variants.
        insertRows(
          db,
          project,
          legacyRows('script', {
            env: definition.env,
            files: definition.files,
          }),
          now,
        )
        // Automatic branches build on new commits; any other branch can still be requested.
        const automatic = builder
          .prepare(
            'SELECT branch FROM automatic_branches WHERE app=? AND enabled=1 ORDER BY branch',
          )
          .all(definition.slug)
          .map((branch) => String(branch.branch))
        const rules = [
          ...automatic.map((pattern) => ({ pattern, mode: 'automatic' })),
          { pattern: '**', mode: 'request' },
        ]
        rules.forEach((rule, position) =>
          db
            .prepare(
              'INSERT INTO branch_rules(project_id,position,pattern,mode) VALUES(?,?,?,?)',
            )
            .run(project, position, rule.pattern, rule.mode),
        )
        summary.branchRules += rules.length
      }
      master.audit(
        { role: 'admin', label: 'local operator' },
        'import',
        randomUUID(),
      )
      return summary
    })
  } finally {
    distribution.close()
    builder.close()
  }
}
