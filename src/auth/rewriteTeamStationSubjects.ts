import { asObject, asString } from 'cleaners'
import type { Store } from '../store.js'
import { asId } from '../validation.js'
import { asProviderId } from './providerConfig.js'
import { teamStationSubjectOf } from './teamStationSubject.js'

const asIdentityRow = asObject({
  id: asId,
  account_id: asId,
  subject: asString,
})
export interface SubjectRewrite {
  scanned: number
  eligible: number
  changed: number
  collisions: Array<{ accountId: number; existingAccountId: number }>
}

/** Rewrites identity keys only; accounts, sessions and permission rows stay intact. */
export function rewriteTeamStationSubjects(
  store: Store,
  providerId: string,
  apply: boolean,
): SubjectRewrite {
  const provider = store.config.providers.find(
    (p) => p.id === asProviderId(providerId),
  )
  if (provider == null) throw new Error('Unknown identity provider')
  const rewrite = (): SubjectRewrite => {
    const rows = store.db
      .prepare(
        'SELECT id,account_id,subject FROM identities WHERE provider=? AND issuer=? ORDER BY id',
      )
      .all(provider.id, provider.issuer)
      .map(asIdentityRow)
    const result: SubjectRewrite = {
      scanned: rows.length,
      eligible: 0,
      changed: 0,
      collisions: [],
    }
    for (const row of rows) {
      if (
        row.subject.trim() !== row.subject ||
        !/^[1-9][0-9]*$/.test(row.subject) ||
        BigInt(row.subject) > 9007199254740991n
      )
        continue
      result.eligible++
      const subject = teamStationSubjectOf(row.subject)
      const existing = store.db
        .prepare(
          'SELECT account_id FROM identities WHERE provider=? AND issuer=? AND subject=?',
        )
        .get(provider.id, provider.issuer, subject)
      if (existing != null) {
        result.collisions.push({
          accountId: row.account_id,
          existingAccountId: asId(existing.account_id),
        })
        continue
      }
      if (apply)
        store.db
          .prepare('UPDATE identities SET subject=? WHERE id=?')
          .run(subject, row.id)
      result.changed++
    }
    return result
  }
  return apply ? store.transaction(rewrite) : rewrite()
}
