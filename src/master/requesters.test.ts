import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from './database.js'
import { MasterKeys } from './keys.js'
import { requesterName, shownLabel } from './requesters.js'
import { localOperator, type Actor } from './roles.js'

describe('Who requested a run', () => {
  it('names an account, a host session’s account, and a key by its maker, its name and six characters of its id', () => {
    const database = new MasterDatabase(new DatabaseSync(':memory:'), () => 0)
    const db = database.db
    db.exec(`INSERT INTO accounts(id,name,username,role,created_at) VALUES
      (3,'Paul Puey','paul','admin',0),(4,'','dana','developer',0)`)
    const keys = new MasterKeys(database)
    const paul: Actor = { role: 'admin', accountId: 3, label: 'account:3' }
    const ci = keys.create(paul, { role: 'developer', name: 'TeamStation CI' })
    const id = ci.id.slice(0, 6)
    assert.equal(
      (
        db.prepare('SELECT created_by FROM api_keys WHERE id=?').get(ci.id) as {
          created_by: string
        }
      ).created_by,
      'account:3',
    )
    assert.equal(requesterName(db, 'account:3'), 'Paul Puey')
    assert.equal(requesterName(db, 'host:3'), 'Paul Puey')
    assert.equal(requesterName(db, 'account:4'), 'dana')
    assert.equal(requesterName(db, 'account:9'), 'account 9')
    assert.equal(
      requesterName(db, `key:${ci.id}`),
      `Paul Puey · key "TeamStation CI" (${id})`,
    )
    // A key a key made names the person behind both; a default name keeps six characters of its id.
    const made = keys.actor(ci)
    const bot = keys.create(
      { ...made, role: 'developer' },
      { role: 'developer' },
    )
    const short = bot.id.slice(0, 6)
    assert.equal(
      requesterName(db, `key:${bot.id}`),
      `Paul Puey · key "TeamStation CI" (${id}) · key "developer key ${short}" (${short})`,
    )
    const operator = keys.create(localOperator, { role: 'admin', name: 'Ops' })
    assert.equal(
      requesterName(db, `key:${operator.id}`),
      `local operator · key "Ops" (${operator.id.slice(0, 6)})`,
    )
    // A key with no maker on record, and one that is gone.
    db.prepare(
      'UPDATE api_keys SET created_by=NULL,creator=NULL WHERE id=?',
    ).run(operator.id)
    assert.equal(
      requesterName(db, `key:${operator.id}`),
      `key "Ops" (${operator.id.slice(0, 6)})`,
    )
    db.prepare('UPDATE api_keys SET created_by=NULL WHERE id=?').run(ci.id)
    assert.match(requesterName(db, `key:${ci.id}`), /^Paul Puey · key/)
    assert.equal(
      requesterName(db, 'key:0123456789abcdef0123456789abcdef'),
      'key 012345',
    )
    // A chain of keys stops a few deep.
    db.prepare("UPDATE api_keys SET created_by='key:'||id WHERE id=?").run(
      bot.id,
    )
    assert.equal(
      requesterName(db, `key:${bot.id}`).split('key "').length - 1,
      4,
    )
    // The local operator and the master's own triggers are as they are.
    assert.equal(requesterName(db, 'local operator'), 'local operator')
    assert.equal(requesterName(db, 'poller'), 'poller')
    assert.equal(requesterName(db, ''), '')
    assert.equal(
      shownLabel('key:830f19b00cf214361f85ac579fa12497'),
      'key 830f19',
    )
    assert.equal(shownLabel('account:3'), 'account:3')
  })
})
