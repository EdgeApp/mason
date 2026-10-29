import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import {
  asReleaseVersion,
  compareRelease,
  hasUpdater,
  requestUpdate,
  takeUpdateRequest,
} from './update.js'

const scratch = (): string =>
  mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'update-'))

describe('Updates over the link', function () {
  it('U1.2a takes only release versions', () => {
    for (const good of ['0.2.0', '10.0.1', '0.3.0-dev.4', '1.0.0-rc.1'])
      assert.equal(asReleaseVersion(good), good)
    for (const bad of ['', 'v0.2.0', '0.2', '0.2.0; rm', '0.2.0-', 2, null])
      assert.throws(() => asReleaseVersion(bad), /release version/)
  })

  it('U1.2b orders prereleases as semver does', () => {
    const sorted = [
      '0.2.0',
      '0.3.0-dev.2',
      '0.3.0-dev.10',
      '0.3.0-dev.10.1',
      '0.3.0-rc',
      '0.3.0',
      '0.3.1',
    ]
    for (let i = 0; i < sorted.length; i++)
      for (let j = 0; j < sorted.length; j++)
        assert.equal(
          Math.sign(compareRelease(sorted[i]!, sorted[j]!)),
          Math.sign(i - j),
          `${sorted[i]} vs ${sorted[j]}`,
        )
    assert(compareRelease('1.0.0-alpha', '1.0.0-1') > 0)
    assert(compareRelease('1.0.0-1', '1.0.0-alpha') < 0)
  })

  it('U1.2c takes a request once: newer is installed, the same is nothing, older or malformed is refused', () => {
    const dir = scratch()
    const file = path.join(dir, 'update-request.json')
    const write = (body: string): void => writeFileSync(file, body)
    write(JSON.stringify({ version: '0.3.0-dev.3', at: 1 }))
    assert.equal(takeUpdateRequest(file, '0.3.0-dev.2'), '0.3.0-dev.3')
    assert(!existsSync(file))
    write(JSON.stringify({ version: '0.3.0-dev.3' }))
    assert.equal(takeUpdateRequest(file, '0.3.0-dev.3'), undefined)
    assert(!existsSync(file))
    write(JSON.stringify({ version: '0.3.0-dev.1' }))
    assert.throws(
      () => takeUpdateRequest(file, '0.3.0-dev.2'),
      /older than the running 0\.3\.0-dev\.2/,
    )
    assert(!existsSync(file))
    for (const body of ['{"version":"latest"}', 'not json', '{}']) {
      write(body)
      assert.throws(() => takeUpdateRequest(file, '0.2.0'), /not a release/)
      assert(!existsSync(file))
    }
    assert.throws(() => takeUpdateRequest(file, '0.2.0'), /No update request/)
  })

  it('U1.3 node.update writes a private request when the updater exists, and names the remedy when not', () => {
    const dir = scratch()
    const units: string[] = []
    const exists = (file: string): boolean => {
      units.push(file)
      return true
    }
    assert.deepEqual(
      requestUpdate(dir, 'host', '0.3.0', { exists, now: () => 42 }),
      { requested: '0.3.0' },
    )
    assert.deepEqual(units, ['/etc/systemd/system/mason-host-update.path'])
    const file = path.join(dir, 'update-request.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: '0.3.0',
      at: 42,
    })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.throws(
      () => requestUpdate(dir, 'host', '0.3.0', { exists: () => false }),
      /updates only by hand.*sudo mason update/,
    )
    assert.throws(
      () => requestUpdate(dir, 'host', '../0.3.0', { exists }),
      /release version/,
    )
    assert.equal(
      hasUpdater('worker', (unit) => unit.endsWith('mason-worker-update.path')),
      true,
    )
  })
})
