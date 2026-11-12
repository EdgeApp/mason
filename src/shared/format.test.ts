import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { absoluteTime, count, relativeTime } from './format.js'

const at = (iso: string): number => Date.parse(iso)

describe('The design language’s formats', () => {
  const now = at('2026-11-12T22:30:00Z')
  const zone = 'America/Los_Angeles'

  it('writes absolute times as today, yesterday, a date this year or a full date, 24-hour with the zone', () => {
    assert.equal(
      absoluteTime(at('2026-11-12T22:22:00Z'), now, zone),
      'Today 1422 PT',
    )
    assert.equal(
      absoluteTime(at('2026-11-11T22:35:00Z'), now, zone),
      'Yesterday 1435 PT',
    )
    assert.equal(
      absoluteTime(at('2026-11-07T17:12:00Z'), now, zone),
      'Nov 7 0912 PT',
    )
    assert.equal(
      absoluteTime(at('2025-11-07T17:12:00Z'), now, zone),
      '2025-11-07 0912 PT',
    )
    assert.equal(
      absoluteTime(at('2026-11-12T14:05:00Z'), now, 'UTC'),
      'Today 1405 UTC',
    )
    assert.match(absoluteTime(now, now), /^Today \d{4} \S+$/)
  })

  it('writes relative times within a day, then the absolute form', () => {
    assert.equal(relativeTime(now - 30_000, now), 'now')
    assert.equal(relativeTime(now + 5_000, now), 'now')
    assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago')
    assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago')
    assert.equal(
      relativeTime(at('2026-11-07T17:12:00Z'), now, zone),
      'Nov 7 0912 PT',
    )
  })

  it('writes counts with thousands separators', () => {
    assert.equal(count(1284), '1,284')
    assert.equal(count(7), '7')
  })
})
