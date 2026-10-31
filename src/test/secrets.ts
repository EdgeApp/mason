import type { DatabaseSync } from 'node:sqlite'
import {
  insertRows,
  legacyRows,
  variantRow,
  type LegacySecrets,
} from '../master/secrets.js'
import { asConfigs } from '../pipeline/variants.js'

/**
 * Inserts a secret variant straight into a test master's database, with no
 * backup: fixtures seed secrets this way, while `master.secrets` changes
 * need a configured backup.
 */
export function seedSecret(
  db: DatabaseSync,
  slug: string,
  secret: {
    name: string
    kind: 'value' | 'file'
    configs?: string
    value?: string
    /** Base64. */
    contents?: string
    masked?: boolean
    pathEnv?: string
    destination?: string
  },
): number {
  const project = db.prepare('SELECT id FROM projects WHERE slug=?').get(slug)
  if (project == null) throw new Error(`No project ${slug}`)
  const row = variantRow({
    name: secret.name,
    kind: secret.kind,
    configs: asConfigs(secret.configs ?? ''),
    contents:
      secret.kind === 'value' ? (secret.value ?? '') : (secret.contents ?? ''),
    ...(secret.masked == null ? {} : { masked: secret.masked }),
    ...(secret.pathEnv == null ? {} : { pathEnv: secret.pathEnv }),
    ...(secret.destination == null ? {} : { destination: secret.destination }),
  })
  return insertRows(db, Number(project.id), [row], 0)[0]!
}

/** Seeds secrets given the way projects held them before variants: values and files, all default variants. */
export function seedLegacySecrets(
  db: DatabaseSync,
  slug: string,
  legacy: Partial<LegacySecrets>,
): void {
  const project = db
    .prepare('SELECT id,format FROM projects WHERE slug=?')
    .get(slug)
  if (project == null) throw new Error(`No project ${slug}`)
  insertRows(
    db,
    Number(project.id),
    legacyRows(project.format === 'script' ? 'script' : 'pipeline', {
      env: (legacy.env ?? []).map((entry) => ({
        ...entry,
        secret: entry.secret ?? true,
      })),
      files: legacy.files ?? [],
    }),
    0,
  )
}
