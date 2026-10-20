import { asObject } from 'cleaners'
import { asClientHash, rejectRawPassword } from '../auth/passwordProtocol.js'
import type { MasterDatabase } from '../master/database.js'
import type { MasterKeys } from '../master/keys.js'
import { createPasswordRecord } from '../master/passwords.js'
import type { Actor } from '../master/roles.js'

export function asUsername(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  )
    throw new Error(
      'A username is 1–64 letters, digits, dots, dashes or underscores',
    )
  return value
}

const asSetupRequest = asObject({
  username: asUsername,
  clientHash: asClientHash,
  clientParameters: (value: unknown): unknown => value,
  apiKey: (value: unknown): boolean => value === true,
})

export class AlreadyConfigured extends Error {
  constructor() {
    super('This master is already set up')
  }
}

/**
 * Creates the first local account, an admin, which locks the master: from
 * then on everything needs a signed-in user or an API key. Optionally makes
 * an admin API key for agents.
 */
export async function createFirstAdmin(
  master: MasterDatabase,
  keys: MasterKeys,
  value: unknown,
): Promise<{
  accountId: number
  username: string
  token?: string
  keyId?: string
}> {
  rejectRawPassword(value)
  const request = asSetupRequest(value)
  if (master.configured()) throw new AlreadyConfigured()
  const record = await createPasswordRecord(
    request.clientHash,
    request.clientParameters,
  )
  const accountId = master.transaction(() => {
    if (master.configured()) throw new AlreadyConfigured()
    if (
      master.db
        .prepare('SELECT 1 FROM accounts WHERE username=? COLLATE NOCASE')
        .get(request.username) != null
    )
      throw new Error('That username is taken')
    const id = Number(
      master.db
        .prepare(
          "INSERT INTO accounts(name,username,password,role,is_admin,created_at) VALUES(?,?,?,'admin',1,?)",
        )
        .run(request.username, request.username, record, master.now())
        .lastInsertRowid,
    )
    master.audit(
      { role: 'admin', label: 'local operator' },
      'setup.admin',
      String(id),
    )
    master.change('account', id)
    return id
  })
  const actor: Actor = {
    role: 'admin',
    accountId,
    label: `account:${accountId}`,
  }
  const key = request.apiKey
    ? keys.create(actor, { role: 'admin', name: 'Setup key' })
    : undefined
  return {
    accountId,
    username: request.username,
    ...(key == null ? {} : { token: key.token, keyId: key.id }),
  }
}
