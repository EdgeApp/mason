// What People and Your account edit before Save: a person's name, username,
// role and email lines, the change lines the confirm lists, and the body
// `PUT /api/v2/people/:id` is sent. Nothing is stored until the confirm is
// accepted (src/browser/personEditor.ts's rules and words).
import type { PersonChange } from '../../../../shared/api/people.js'
import type { SessionEmail } from '../../../../shared/api/session.js'
import { roles, type Role } from '../../../../shared/permissions.js'

/** What the viewer may change on a row: everything, their own name and emails, or nothing. */
export type EditMode = 'all' | 'self' | 'none'

/** A person as their row was drawn. */
export interface PersonState {
  name: string
  /** '' for none. */
  username: string
  role: Role
  emails: SessionEmail[]
}

/** One email line while it is edited. */
export interface DraftEmail extends SessionEmail {
  /** Added here, not yet saved. */
  added?: boolean
  /** Marked for removal. */
  removed?: boolean
  /** Marked to be confirmed (administrators). */
  confirm?: boolean
}

export interface Draft {
  name: string
  username: string
  role: Role
  emails: DraftEmail[]
}

/** The roles, lowest first, as their words. */
export const ROLE_WORDS: Record<Role, string> = {
  tester: 'Tester',
  developer: 'Developer',
  manager: 'Manager',
  admin: 'Admin',
}

/** The role select's choices, lowest first. */
export const ROLE_OPTIONS = roles.map((role) => ({
  value: role,
  label: ROLE_WORDS[role],
}))

/** The username rule the master applies, in words. */
export const USERNAME_RULE =
  'A username is 1–64 letters, digits, dots, dashes or underscores'

/** The longest name the master keeps. */
export const NAME_MAX = 120

export const draftOf = (original: PersonState): Draft => ({
  name: original.name,
  username: original.username,
  role: original.role,
  emails: original.emails.map((entry) => ({ ...entry })),
})

/** What Save would change: the lines the confirm lists and the request body. */
export function changesOf(
  original: PersonState,
  draft: Draft,
): { lines: string[]; body: PersonChange } {
  const lines: string[] = []
  const body: PersonChange = {}
  const shown = (value: string): string => (value === '' ? '—' : value)
  const name = draft.name.trim()
  if (name !== original.name) {
    lines.push(`Name: ${shown(original.name)} → ${shown(name)}`)
    body.name = name
  }
  const username = draft.username.trim()
  if (username !== original.username) {
    lines.push(`Username: ${shown(original.username)} → ${shown(username)}`)
    body.username = username === '' ? null : username
  }
  if (draft.role !== original.role) {
    lines.push(`Role: ${original.role} → ${draft.role}`)
    body.role = draft.role
  }
  const added = draft.emails.filter((entry) => entry.added && !entry.removed)
  const removed = draft.emails.filter((entry) => entry.removed && !entry.added)
  const confirmed = draft.emails.filter(
    (entry) =>
      entry.confirm === true &&
      entry.removed !== true &&
      entry.added !== true &&
      !entry.confirmed,
  )
  for (const entry of added) lines.push(`Email added: ${entry.email}`)
  for (const entry of removed) lines.push(`Email removed: ${entry.email}`)
  for (const entry of confirmed) lines.push(`Email confirmed: ${entry.email}`)
  if (added.length > 0 || removed.length > 0)
    body.emails = draft.emails
      .filter((entry) => entry.removed !== true)
      .map((entry) => entry.email)
  if (confirmed.length > 0)
    body.confirmEmails = confirmed.map((entry) => entry.email)
  return { lines, body }
}

/** What removing a person does, for the Remove confirm. */
export const removalLines = [
  'Their email addresses, password, group memberships and invitation link go.',
  'Every API key they created is revoked.',
  'The account is disabled and kept for the audit history.',
]

/** An address as the master keeps it: trimmed and lower-cased. */
export const normalEmail = (value: string): string => value.trim().toLowerCase()

/** Whether text is one email address the master takes. */
export const isEmail = (value: string): boolean => {
  const email = normalEmail(value)
  return /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320
}

/** Why an address cannot be added to this draft, or undefined when it can. */
export function emailProblem(value: string, draft: Draft): string | undefined {
  if (!isEmail(value)) return 'Enter an email address'
  const email = normalEmail(value)
  if (draft.emails.some((entry) => entry.email === email && !entry.removed))
    return 'They already have that address'
  return undefined
}

/**
 * Adds an address to a draft: one removed here comes back, else a new line,
 * confirmed when an administrator adds it.
 */
export function withEmail(draft: Draft, value: string, admin: boolean): Draft {
  const email = normalEmail(value)
  if (draft.emails.some((entry) => entry.email === email))
    return {
      ...draft,
      emails: draft.emails.map((entry) =>
        entry.email === email ? { ...entry, removed: false } : entry,
      ),
    }
  return {
    ...draft,
    emails: [...draft.emails, { email, confirmed: admin, added: true }],
  }
}

/** × on a line: a new line goes, a saved one is marked (or unmarked) for removal. */
export function withoutEmail(draft: Draft, email: string): Draft {
  return {
    ...draft,
    emails: draft.emails.flatMap((entry) =>
      entry.email !== email
        ? [entry]
        : entry.added === true
          ? []
          : [{ ...entry, removed: entry.removed !== true }],
    ),
  }
}

/** Confirm on an unconfirmed line: marks it (or unmarks it) to confirm on Save. */
export function confirmingEmail(draft: Draft, email: string): Draft {
  return {
    ...draft,
    emails: draft.emails.map((entry) =>
      entry.email === email
        ? { ...entry, confirm: entry.confirm !== true }
        : entry,
    ),
  }
}

/** A username a person may have, or why not ('' clears it). */
export function usernameProblem(value: string): string | undefined {
  const username = value.trim()
  if (username === '' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username))
    return undefined
  return USERNAME_RULE
}

/** Why a name cannot be saved, or undefined. */
export const nameProblem = (value: string): string | undefined =>
  value.trim() === '' ? 'Enter their name' : undefined
