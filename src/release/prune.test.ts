import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import {
  currentRelease,
  fileSha256,
  installTarball,
  processCommands,
  pruneReleases,
} from './install.js'

const scratch = (): string =>
  mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'prune-'))

/** A prefix holding these release directories, oldest first, and `current`. */
function prefixWith(names: string[], current?: string): string {
  const prefix = scratch()
  names.forEach((name, i) => {
    mkdirSync(path.join(prefix, name, 'lib'), { recursive: true })
    // A release holds its launcher and digest; a failed install need not.
    if (!name.endsWith('.partial')) {
      writeFileSync(path.join(prefix, name, 'mason'), '#!/bin/sh\n')
      writeFileSync(path.join(prefix, name, '.sha256'), 'digest\n')
    }
    const at = new Date(Date.UTC(2026, 0, 1 + i))
    utimesSync(path.join(prefix, name), at, at)
  })
  if (current != null) symlinkSync(current, path.join(prefix, 'current'))
  return prefix
}
const listed = (prefix: string): string[] => readdirSync(prefix).sort()
/** No process runs a release, a year after the releases were made. */
const idle = { commands: [], now: Date.UTC(2027, 0, 1) }

describe('Pruning installed releases', () => {
  it('keeps the current release and the one before it, and removes older ones, failed installs included', () => {
    const prefix = prefixWith(
      ['0.1.0', '0.2.0-dev.3', '0.2.0', '0.3.0.partial', '0.3.0'],
      '0.3.0',
    )
    mkdirSync(path.join(prefix, 'notes'))
    writeFileSync(path.join(prefix, '0.1.9'), 'a file named like a release')
    assert.equal(currentRelease(prefix), '0.3.0')
    assert.deepEqual(pruneReleases(prefix, ['0.3.0', '0.2.0'], idle), {
      removed: ['0.1.0', '0.2.0-dev.3', '0.3.0.partial'],
      failed: [],
    })
    assert.deepEqual(listed(prefix), [
      '0.1.9',
      '0.2.0',
      '0.3.0',
      'current',
      'notes',
    ])
  })

  it('keeps the newest other release when the update changed nothing, and ignores a release that is gone', () => {
    const prefix = prefixWith(['0.1.0', '0.2.0', '0.2.1', '0.3.0'], '0.3.0')
    assert.deepEqual(
      pruneReleases(prefix, ['0.3.0', '0.3.0', '9.9.9'], idle).removed,
      ['0.1.0', '0.2.0'],
    )
    assert.deepEqual(listed(prefix), ['0.2.1', '0.3.0', 'current'])
    // Already down to two: nothing more goes.
    assert.deepEqual(pruneReleases(prefix, ['0.3.0'], idle).removed, [])
    assert.equal(currentRelease(scratch()), undefined)
  })

  it('keeps a release a process still runs, and every release when processes cannot be listed', () => {
    const prefix = prefixWith(['0.1.0', '0.2.0', '0.3.0', '0.4.0'], '0.4.0')
    const real = realpathSync(prefix)
    const commands = [
      `${real}/0.1.0/node/bin/node ${real}/0.1.0/lib/cli.js worker --data /var/lib/mason`,
      '/usr/bin/sshd',
    ]
    assert.deepEqual(
      pruneReleases(prefix, ['0.4.0', '0.3.0'], { ...idle, commands }).removed,
      ['0.2.0'],
    )
    assert.deepEqual(
      pruneReleases(prefix, ['0.4.0', '0.3.0'], {
        ...idle,
        commands: undefined,
      }).removed,
      [],
    )
    assert.deepEqual(listed(prefix), ['0.1.0', '0.3.0', '0.4.0', 'current'])
  })

  it('leaves a recent failed install, a directory that is not a release and a link named like one', () => {
    const prefix = prefixWith(['0.1.0', '0.2.0', '0.3.0'], '0.3.0')
    mkdirSync(path.join(prefix, '0.4.0.partial'))
    mkdirSync(path.join(prefix, '1.2.3'))
    symlinkSync(path.join(prefix, '0.1.0'), path.join(prefix, '0.0.9'))
    const now = Date.now()
    assert.deepEqual(
      pruneReleases(prefix, ['0.3.0', '0.2.0'], { commands: [], now }).removed,
      ['0.1.0'],
    )
    assert.deepEqual(listed(prefix), [
      '0.0.9',
      '0.2.0',
      '0.3.0',
      '0.4.0.partial',
      '1.2.3',
      'current',
    ])
    // An hour on, the failed install is no longer in progress.
    assert.deepEqual(
      pruneReleases(prefix, ['0.3.0', '0.2.0'], {
        commands: [],
        now: now + 2 * 60 * 60 * 1000,
      }).removed,
      ['0.4.0.partial'],
    )
  })

  it('lists what it cannot remove instead of throwing', function () {
    if (process.getuid?.() === 0) this.skip()
    const prefix = prefixWith(['0.1.0', '0.2.0', '0.3.0'], '0.3.0')
    chmodSync(prefix, 0o555)
    try {
      assert.deepEqual(pruneReleases(prefix, ['0.3.0', '0.2.0'], idle), {
        removed: [],
        failed: ['0.1.0'],
      })
    } finally {
      chmodSync(prefix, 0o755)
    }
    assert.deepEqual(
      pruneReleases(path.join(prefix, 'missing'), ['0.3.0'], idle),
      { removed: [], failed: [] },
    )
    assert(Array.isArray(processCommands()))
  })

  it('installTarball (worker updates) keeps the new release and the one that ran before it', async () => {
    const prefix = prefixWith(['0.1.0', '0.2.0', '0.3.0'], '0.3.0')
    const source = scratch()
    const root = path.join(source, 'mason-0.4.0')
    mkdirSync(path.join(root, 'lib'), { recursive: true })
    writeFileSync(path.join(root, 'mason'), '#!/bin/sh\n')
    writeFileSync(path.join(root, 'lib', 'cli.js'), '')
    const tarball = path.join(source, 'mason-0.4.0.tar.gz')
    execFileSync('tar', ['-czf', tarball, '-C', source, 'mason-0.4.0'])
    await installTarball(
      tarball,
      { prefix, bindir: path.join(source, 'bin') },
      {
        version: '0.4.0',
        platform: 'darwin-arm64',
        sha256: await fileSha256(tarball),
      },
    )
    assert.equal(currentRelease(prefix), '0.4.0')
    assert.deepEqual(listed(prefix), ['0.3.0', '0.4.0', 'current'])
    assert(existsSync(path.join(prefix, '0.4.0', 'lib', 'cli.js')))
  })
})
