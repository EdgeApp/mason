import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  absoluteTime,
  bytes,
  count,
  duration,
  relativeTime,
  shortAge,
  tryAgainAt,
} from './format.js'

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

  it('says when a throttled sign-in may try again: the clock the same day, else with the day', () => {
    assert.equal(
      tryAgainAt(at('2026-11-12T22:35:00Z'), now, zone),
      'Try again at 1435 PT',
    )
    assert.equal(
      tryAgainAt(at('2026-11-13T17:12:00Z'), now, zone),
      'Try again at Nov 13 0912 PT',
    )
  })

  it('writes durations, bytes and a build chip’s short age', () => {
    assert.equal(duration(-5), '0s')
    assert.equal(duration(42_000), '42s')
    assert.equal(duration(252_000), '4m 12s')
    assert.equal(duration(3_960_000), '1h 6m')
    assert.equal(bytes(512), '512 B')
    assert.equal(bytes(84_100_000), '84.1 MB')
    assert.equal(bytes(312_800_000_000), '312.8 GB')
    assert.equal(bytes(5e18), '5000000.0 TB')
    const minute = 60_000
    const day = 1440 * minute
    assert.equal(shortAge(now - 30_000, now), 'now')
    assert.equal(shortAge(now + 30_000, now), 'now')
    assert.equal(shortAge(now - 5 * minute, now), '5m')
    assert.equal(shortAge(now - 3 * 60 * minute, now), '3h')
    assert.equal(shortAge(now - 6 * day, now), '6d')
    assert.equal(shortAge(now - 15 * day, now), '2w')
    assert.equal(shortAge(now - 40 * day, now), '5w')
    assert.equal(shortAge(now - 70 * day, now), '2mo')
    assert.equal(shortAge(now - 800 * day, now), '2y')
  })
})
