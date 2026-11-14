import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner,
} from 'cleaners'

/** `GET`, `POST /api/v2/projects/:slug/secrets`, the master. */
export const secretsPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/secrets`
/** `GET /api/v2/projects/:slug/secrets/audit`, the master. */
export const secretsAuditPath = (slug: string): string =>
  `${secretsPath(slug)}/audit`
/**
 * One variant's routes: `GET` its contents, `PUT` a new value or text,
 * `PUT …/file` new bytes, `PUT …/configs` new build configs, `DELETE` it.
 */
export const secretPath = (
  slug: string,
  id: number,
  part?: 'file' | 'configs',
): string => `${secretsPath(slug)}/${id}${part == null ? '' : `/${part}`}`

/** One variant of a secret, never its contents. */
export interface SecretVariant {
  id: number
  name: string
  kind: 'value' | 'file'
  /** Empty: every config (the default variant). */
  configs: string[]
  /** Values always; files when they are UTF-8 with no NUL. */
  text: boolean
  /** False only in script projects: a value added unmasked. */
  masked: boolean
  /** Script projects: the variable that holds an injected file's path. */
  pathEnv?: string
  /** Script projects: where a migrated file is injected. */
  destination?: string
  bytes: number
  updatedAt: number
}

/** One audit entry; `detail` never holds a value. */
export interface SecretAuditEntry {
  id: number
  name: string
  configs: string[]
  action: string
  who: string
  address: string
  at: number
  detail?: string
}

/** What `GET …/secrets/:id` answers: a value, a text file's text, or a binary file in base64. */
export type SecretContents =
  | { value: string }
  | { text: string }
  | { contents: string }

/** What `POST …/secrets` takes. */
export interface SecretAdd {
  kind: 'value' | 'file'
  name: string
  /** Comma-separated; empty means all. */
  configs: string
  value?: string
  /** A file's bytes, base64. */
  contents?: string
  /** Script projects, values. */
  masked?: boolean
  /** Script projects, files. */
  pathEnv?: string
}

export const asSecretVariant = asObject<SecretVariant>({
  id: asNumber,
  name: asString,
  kind: asValue('value', 'file'),
  configs: asArray(asString),
  text: asBoolean,
  masked: asBoolean,
  pathEnv: asOptional(asString),
  destination: asOptional(asString),
  bytes: asNumber,
  updatedAt: asNumber,
})
export const asSecretVariants = asArray(asSecretVariant)

export const asSecretAudit = asArray(
  asObject<SecretAuditEntry>({
    id: asNumber,
    name: asString,
    configs: asArray(asString),
    action: asString,
    who: asString,
    address: asString,
    at: asNumber,
    detail: asOptional(asString),
  }),
)

export const asSecretContents: Cleaner<SecretContents> = (raw) => {
  const answer = asObject({
    value: asOptional(asString),
    text: asOptional(asString),
    contents: asOptional(asString),
  })(raw)
  if (answer.value != null) return { value: answer.value }
  if (answer.text != null) return { text: answer.text }
  if (answer.contents != null) return { contents: answer.contents }
  throw new TypeError('Expected a value, a text or contents')
}
