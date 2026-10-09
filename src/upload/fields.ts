import { asOptional, asString } from 'cleaners'
import { asHttps, object, text } from '../validation.js'
import { asApiToken } from './keys.js'
import { customFields } from './metadata.js'

const asChangelog = (value: unknown): string => {
  const out = asString(value)
  if (Buffer.byteLength(out) > 65536 || out.includes('\0'))
    throw new Error('Invalid changelog')
  return out
}
export const asUploadFields = object({
  token: asApiToken,
  channel_key: text(256),
  branch: asOptional(text(256), 'master'),
  git_commit: asOptional(text(128), 'unknown'),
  changelog: asOptional(asChangelog, ''),
  source: asOptional(text(80), 'api'),
  release_type: asOptional(text(80)),
  name: asOptional(text(120)),
  ci_url: asOptional(asHttps),
  custom_fields: asOptional(
    (value: unknown) => customFields(asString(value)),
    {},
  ),
})
export type UploadFields = ReturnType<typeof asUploadFields>
export const uploadFieldNames = new Set([
  'token',
  'channel_key',
  'branch',
  'git_commit',
  'changelog',
  'source',
  'release_type',
  'name',
  'ci_url',
  'custom_fields',
])
export const asVersionFields = object({
  branch: asOptional(text(256)),
  token: asApiToken,
  channel_key: text(256),
  bundle_id: text(256),
  release_version: asOptional(text(80)),
  build_version: asOptional(text(80)),
  git_commit: asOptional(text(128)),
})
