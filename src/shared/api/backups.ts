import {
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
} from 'cleaners'

/** `GET|PUT /api/v2/settings/backup`, master only: the `backup` setting and the backup status. */
export const BACKUP_SETTING_PATH = '/api/v2/settings/backup'
/** `POST /api/v2/settings/backup/confirm`: an administrator stored the backup key. */
export const BACKUP_CONFIRM_PATH = '/api/v2/settings/backup/confirm'

/** What pushed a backup, or pushes the next one. */
export type BackupAuth = 'deployKey' | 'github'

/** The backup status, as `GET /api/v2/backups` also answers it. */
export interface BackupStatusView {
  configured: boolean
  /** Whether the latest backup succeeded. */
  backedUp: boolean
  lastSuccess?: {
    at: number
    commit: string
    kind: string
    auth?: BackupAuth
  }
  lastFailure?: { at: number; error: string }
}

/** What `GET|PUT /api/v2/settings/backup` answers: the setting, its status and, for an administrator, the key. */
export interface BackupSettingView extends BackupStatusView {
  /** Unset until backups are configured. */
  repository?: string
  branch?: string
  auth?: BackupAuth
  /** The deploy key's public half, to add to the repository with write access. */
  deployKey?: string
  /** An administrator, once backups are configured: the key that opens the snapshots. */
  backupKey?: string
  /** An administrator with an account: whether they confirmed they stored the key. */
  keyConfirmed?: boolean
}

/** The body of `PUT /api/v2/settings/backup`. */
export interface BackupSettingChange {
  repository: string
  branch: string
  auth?: BackupAuth
}

/** What `POST …/confirm` answers. */
export interface BackupConfirm {
  keyConfirmed: boolean
}

export const asBackupAuth = asValue('deployKey', 'github')

export const asBackupSettingView = asObject<BackupSettingView>({
  configured: asBoolean,
  backedUp: asBoolean,
  lastSuccess: asOptional(
    asObject({
      at: asNumber,
      commit: asString,
      kind: asString,
      auth: asOptional(asBackupAuth),
    }),
  ),
  lastFailure: asOptional(asObject({ at: asNumber, error: asString })),
  repository: asOptional(asString),
  branch: asOptional(asString),
  auth: asOptional(asBackupAuth),
  deployKey: asOptional(asString),
  backupKey: asOptional(asString),
  keyConfirmed: asOptional(asBoolean),
})

export const asBackupConfirm = asObject<BackupConfirm>({
  keyConfirmed: asBoolean,
})
