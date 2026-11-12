// The one status table (DESIGN-LANGUAGE.md §5, design-language/tools/lib.mjs
// STATUS): every Mason state maps to a tone, a glyph unique within its
// vocabulary, and a word. Every status renders its glyph and its word.
import type { IconName } from './icons.js'

export type Tone =
  | 'success'
  | 'running'
  | 'warning'
  | 'danger'
  | 'neutral'
  | 'info'

export interface Treatment {
  tone: Tone
  icon: IconName
  word: string
}

const t = (tone: Tone, icon: IconName, word: string): Treatment => ({
  tone,
  icon,
  word,
})

/** Status vocabulary → treatment, as the design language's table has it. */
export const STATUS = {
  // Runs, stages, steps.
  queued: t('neutral', 'pending', 'Queued'),
  running: t('running', 'sync', 'Running'),
  succeeded: t('success', 'check_circle', 'Succeeded'),
  unstable: t('warning', 'warning', 'Unstable'),
  failed: t('danger', 'error', 'Failed'),
  timed_out: t('danger', 'hourglass_top', 'Timed out'),
  interrupted: t('danger', 'cancel', 'Interrupted'),
  cancelled: t('neutral', 'block', 'Cancelled'),
  awaiting_approval: t('warning', 'pan_tool', 'Waiting for approval'),
  skipped: t('neutral', 'do_not_disturb_on', 'Skipped'),
  // Builds and checks.
  passed: t('success', 'check_circle', 'Passed'),
  published: t('success', 'check_circle', 'Published'),
  // Worker nodes and hosts.
  idle: t('success', 'radio_button_checked', 'Idle'),
  busy: t('running', 'sync', 'Busy'),
  offline: t('neutral', 'circle', 'Offline'),
  // Cloud machines and hosts.
  creating: t('running', 'sync', 'Creating'),
  installing: t('running', 'sync', 'Installing'),
  pairing: t('running', 'sync', 'Pairing'),
  ready: t('success', 'check_circle', 'Ready'),
  updating: t('running', 'sync', 'Updating'),
  retiring: t('neutral', 'logout', 'Retiring'),
  removing: t('neutral', 'delete', 'Removing'),
  error: t('danger', 'error', 'Error'),
  // Cluster.
  healthy: t('success', 'check_circle', 'Cluster healthy'),
  degraded: t('warning', 'warning', 'Cluster degraded'),
  // Devices.
  pending: t('neutral', 'pending', 'Waiting to register with Apple'),
  processing: t('running', 'sync', 'Apple registration is processing'),
  registered: t('success', 'check_circle', 'Registered with Apple'),
  attention: t('danger', 'error', 'Preparation needs attention'),
  // Accounts, keys, checks.
  active: t('success', 'check_circle', 'Active'),
  revoked: t('neutral', 'block', 'Revoked'),
  unconfirmed: t('warning', 'warning', 'Unconfirmed'),
  ok: t('success', 'check_circle', 'OK'),
  refused: t('danger', 'error', 'Key refused'),
  unchecked: t('neutral', 'pending', 'Not checked yet'),
  never_built: t('neutral', 'circle', 'Never built'),
  not_confirmed: t('warning', 'warning', 'Not confirmed'),
  refused_audit: t('danger', 'error', 'Refused'),
  noanswer: t('danger', 'error', 'No answer'),
  unavailable: t('danger', 'error', 'Unavailable'),
  removed: t('neutral', 'block', 'Removed'),
  waiting_cert: t('warning', 'pending', 'Waiting for its certificate'),
  trusted: t('success', 'lock', 'Certificate trusted'),
  signed_in: t('success', 'check_circle', 'Signed in'),
  signed_out: t('neutral', 'circle', 'Not signed in'),
  needs_code: t('warning', 'lock', 'Needs a code'),
  setting_up: t('running', 'sync', 'Setting up'),
  not_set_up: t('neutral', 'circle', 'Not set up'),
  invited: t('info', 'link', 'Invited'),
  expired: t('danger', 'error', 'Expired'),
  backed_up: t('success', 'check_circle', 'Backed up'),
  no_backup: t('neutral', 'circle', 'No backup yet'),
  selected: t('info', 'check', 'Selected'),
  maintenance: t('warning', 'warning', 'Maintenance'),
  // The shell's live connection and its master (§5's settings column).
  reconnecting: t('running', 'sync', 'Reconnecting…'),
  unreachable: t('warning', 'warning', 'Master unreachable'),
  live_unavailable: t('warning', 'warning', 'Live updates unavailable'),
} as const satisfies Record<string, Treatment>

export type StatusKey = keyof typeof STATUS

/** "timed_out" → "Timed out": the word for a state the table does not know. */
export const statusWord = (key: string): string => {
  const words = key.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A state's treatment. One the table does not know (a newer server's) is
 * neutral, with its own name as the word, so it still reads as a status.
 */
export function statusOf(key: string): Treatment {
  return Object.hasOwn(STATUS, key)
    ? (STATUS as Record<string, Treatment>)[key]!
    : t('neutral', 'circle', statusWord(key))
}
