import { asObject, asOptional } from 'cleaners'
import { branchKey } from '../catalog/platform.js'
import { Store } from '../store.js'
import { type Build, text } from '../validation.js'
import { customFields } from './metadata.js'

/** Zealot's uploader consumes these fields; all links still require a browser login. */
export function uploadResponse(store: Store, build: Build): object {
  const app = store.apps().find((app) => app.id === build.app_id)!
  const channel = store.channel(build.channel_id)
  const stored: unknown = JSON.parse(build.custom_fields)
  const wrapped =
    stored != null &&
    typeof stored === 'object' &&
    !Array.isArray(stored) &&
    Object.hasOwn(stored, 'masonUpload')
  const meta = asObject({
    ci_url: asOptional(text(2048)),
    release_type: asOptional(text(80)),
    custom_fields: asOptional((value: unknown) =>
      customFields(JSON.stringify(value)),
    ),
  })(
    wrapped
      ? asObject({ masonUpload: (value: unknown) => value })(stored).masonUpload
      : {},
  )
  const custom = wrapped
    ? (meta.custom_fields ?? {})
    : customFields(build.custom_fields)
  const url = `${store.config.origin}/apps/${app.id}/branches/${branchKey(build.branch)}?platform=${build.platform}#build-${build.id}`
  return {
    id: build.id,
    version: build.id,
    app_name: app.name,
    bundle_id: build.bundle_id,
    release_version: build.version,
    build_version: build.build_number,
    source: build.source,
    branch: build.branch,
    git_commit: build.commit_hash,
    ci_url: meta.ci_url ?? null,
    size: build.size,
    platform: build.platform,
    device_type: build.platform,
    release_url: url,
    install_url: url,
    icon_url: null,
    qrcode_url: null,
    changelog: build.changelog ? [{ content: build.changelog }] : [],
    text_changelog: build.changelog,
    custom_fields: meta.custom_fields ?? custom,
    created_at: new Date(build.published_at).toISOString(),
    app: { id: app.id, name: app.name },
    scheme: { id: app.id, name: 'Distribution' },
    channel: {
      id: channel.id,
      name: channel.platform,
      device_type: channel.platform,
    },
  }
}
