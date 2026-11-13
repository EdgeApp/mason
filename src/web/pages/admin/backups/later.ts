// "Skip for now" on Backups, kept for the browser session: while it is set,
// an administrator who has not confirmed the backup key is not sent to
// Backups when the master's home opens. Storage may be off (a private
// window): then the flag is never set, and nothing breaks.

/** The session-storage key. */
export const BACKUPS_LATER_KEY = 'mason-backups-later'

/** Whether Backups was skipped (or already shown) in this browser session. */
export function backupsLater(): boolean {
  try {
    return sessionStorage.getItem(BACKUPS_LATER_KEY) === '1'
  } catch {
    return false
  }
}

/** Skips Backups for the rest of the browser session. */
export function setBackupsLater(): void {
  try {
    sessionStorage.setItem(BACKUPS_LATER_KEY, '1')
  } catch {
    // Storage is off: the redirect may come again; it is only a reminder.
  }
}
