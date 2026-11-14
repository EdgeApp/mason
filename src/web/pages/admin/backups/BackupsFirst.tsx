// The master's home for an administrator who has not confirmed the backup
// key: Backups opens instead, once per browser session. After that, or
// after "Skip for now", the home opens and the shell's banner reminds them.
// Anyone else, and an administrator once the key is confirmed, gets the
// home at once.
import { useEffect, type JSX, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import {
  asBackupSettingView,
  BACKUP_SETTING_PATH,
} from '../../../../shared/api/backups.js'
import { useResource } from '../../../hooks/useResource.js'
import { useShell } from '../../../layout/ShellContext.js'
import { SkeletonText } from '../../../ui/Skeleton.js'
import { backupsLater, setBackupsLater } from './later.js'

/** The path Backups opens at. */
export const BACKUPS_HREF = '/backups'

export function BackupsFirst({
  children,
}: {
  children: ReactNode
}): JSX.Element {
  const { session } = useShell()
  const navigate = useNavigate()
  const asks = session.permissions.includes('backups.key') && !backupsLater()
  const read = useResource(
    asks ? BACKUP_SETTING_PATH : null,
    asBackupSettingView,
  )
  const send =
    asks && read.data?.configured === true && read.data.keyConfirmed === false
  useEffect(() => {
    if (!send) return
    setBackupsLater()
    void navigate(BACKUPS_HREF, { replace: true })
  }, [send, navigate])
  // A failed read is no reason to keep anyone from the home.
  if (asks && (send || (read.data == null && read.error == null)))
    return (
      <div className="m-page">
        <SkeletonText lines={4} label="Opening the page" />
      </div>
    )
  return <>{children}</>
}
