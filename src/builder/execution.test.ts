import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import {
  CommandFailure,
  Execution,
  MaskedLog,
  processSnapshot,
} from './execution.js'

let root: string
describe('Build execution', function () {
  this.timeout(20000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'execution-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('masks chunk boundaries and caps logs', () => {
    const file = path.join(root, 'log')
    const full = path.join(root, 'full-log')
    const log = new MaskedLog(file, ['secret-value'], 35, full)
    log.write('prefix sec')
    log.write('ret-value suffix')
    log.write('x'.repeat(100), true)
    assert.equal(readFileSync(file).length, 35)
    assert.match(readFileSync(file, 'utf8'), /prefix \[redacted\] suffix/)
    assert.equal(
      readFileSync(full, 'utf8'),
      'prefix [redacted] suffix' + 'x'.repeat(100),
    )
    assert.equal(statSync(full).mode & 0o777, 0o600)
  })
  it('streams ordinary logs while retaining only possible secret prefixes', () => {
    const file = path.join(root, 'streaming.log')
    const full = path.join(root, 'streaming.full.log')
    const streamed: string[] = []
    const log = new MaskedLog(
      file,
      [
        JSON.stringify({ privateConfig: 'x'.repeat(20000) }),
        'fixture-token-long',
        'fixture-token',
        '',
      ],
      undefined,
      full,
      (redacted) => streamed.push(redacted),
    )
    log.write('Dependency installation completed\n')
    assert.equal(
      readFileSync(file, 'utf8'),
      'Dependency installation completed\n',
    )
    log.write('fixture-token')
    assert.equal(
      readFileSync(full, 'utf8'),
      'Dependency installation completed\n',
    )
    log.write('-long\nNext compiler started\n')
    assert.equal(
      readFileSync(full, 'utf8'),
      'Dependency installation completed\n[redacted]\nNext compiler started\n',
    )
    log.write('fixture-')
    log.write('', true)
    assert(readFileSync(full, 'utf8').endsWith('fixture-'))
    // The stream receives the same redacted text, never an empty chunk.
    assert.equal(streamed.join(''), readFileSync(full, 'utf8'))
    assert(streamed.every((chunk) => chunk.length > 0))
  })
  it('refuses to reuse an existing log file', () => {
    const file = path.join(root, 'existing.log')
    new MaskedLog(file, [])
    assert.throws(() => new MaskedLog(file, []))
  })
  it('captures output, opens an IPC channel and reports a failing exit code', async () => {
    const log = new MaskedLog(path.join(root, 'commands.log'), ['hidden'])
    const execution = new Execution(log)
    try {
      assert.equal(
        await execution.run(
          process.execPath,
          ['-e', "console.log('captured hidden output')"],
          root,
          undefined,
          true,
        ),
        'captured hidden output',
      )
      // Uncaptured output only reaches the log.
      assert.equal(
        await execution.run(
          process.execPath,
          ['-e', "console.log('logged only')"],
          root,
        ),
        '',
      )
      let message: unknown
      await execution.run(
        process.execPath,
        ['-e', 'process.send({ ready: true }, () => process.disconnect())'],
        root,
        undefined,
        false,
        (child) => child.once('message', (value) => (message = value)),
      )
      assert.deepEqual(message, { ready: true })
      await assert.rejects(
        execution.run(
          process.execPath,
          [
            '-e',
            "console.error('synthetic compiler failure'); process.exitCode = 7",
          ],
          root,
        ),
        (error) => {
          assert(error instanceof CommandFailure)
          assert.equal(error.code, 7)
          assert.equal(error.message, 'Build command failed')
          return true
        },
      )
      await assert.rejects(
        execution.run(path.join(root, 'missing-command'), [], root),
      )
    } finally {
      assert.equal(await execution.stop(), true)
    }
    await assert.rejects(
      execution.run(process.execPath, ['-e', ''], root),
      /Execution stopped/,
    )
    const text = readFileSync(path.join(root, 'commands.log'), 'utf8')
    assert(text.includes('captured [redacted] output'))
    assert(text.includes('logged only'))
    assert(text.includes('synthetic compiler failure'))
    assert(!text.includes('hidden'))
  })
  it('logs a transient process inspection failure and its recovery during a build', async () => {
    const file = path.join(root, 'inspection-recovery.log')
    const log = new MaskedLog(file, [])
    let failures = 2
    const execution = new Execution(log, () => {
      if (failures > 0) {
        failures--
        throw new Error('synthetic inspection failure')
      }
      return processSnapshot()
    })
    try {
      await assert.rejects(
        execution.run(
          process.execPath,
          [
            '-e',
            "setTimeout(() => { console.error('synthetic compiler failure'); process.exitCode = 7 }, 300)",
          ],
          root,
        ),
        (error) => error instanceof CommandFailure && error.code === 7,
      )
    } finally {
      assert.equal(await execution.stop(), true)
    }
    const text = readFileSync(file, 'utf8')
    // The failure is reported once however long it lasts.
    assert.equal(
      text.split('Process inspection temporarily unavailable').length,
      2,
    )
    assert(text.includes('Process inspection recovered'))
    assert(text.includes('synthetic compiler failure'))
  })
  it('retries terminal process inspection and reports persistent uncertainty', async () => {
    let unavailable = true
    const log = new MaskedLog(path.join(root, 'inspection.log'), [])
    const execution = new Execution(
      log,
      () => {
        if (unavailable) throw new Error('synthetic inspection failure')
        return processSnapshot()
      },
      100,
      1000,
    )
    setTimeout(() => {
      unavailable = false
    }, 150)
    assert.equal(await execution.stop(), true)
    const blocked = new Execution(
      log,
      () => {
        throw new Error('synthetic inspection failure')
      },
      0,
      200,
    )
    assert.equal(await blocked.stop(), false)
    assert.match(
      blocked.quarantineReason!,
      /Process inspection remained unavailable/,
    )
  })
  it('holds an unverified live process group and releases it after termination', async () => {
    const pidFile = path.join(root, 'untracked-child.pid')
    const file = path.join(root, 'process-groups.log')
    const log = new MaskedLog(file, [])
    const execution = new Execution(
      log,
      () => {
        const rows = processSnapshot()
        const parent = rows.find(
          (row) =>
            row.parent === process.pid &&
            row.group === row.pid &&
            !row.state?.startsWith('Z'),
        )
        // Model a monitoring gap that misses the child before its parent exits.
        return parent == null
          ? rows
          : rows.filter(
              (row) => row.group !== parent.group || row.pid === parent.pid,
            )
      },
      0,
      500,
    )
    let child: number | undefined
    try {
      await execution.run(
        process.execPath,
        [
          '-e',
          `
        const {spawn}=require('node:child_process'); const fs=require('node:fs');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        child.unref(); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
      `,
        ],
        root,
      )
      child = Number(readFileSync(pidFile, 'utf8'))
      assert.equal(await execution.stop(), false)
      assert.match(execution.quarantineReason!, /process groups remain/)
      assert.match(
        readFileSync(file, 'utf8'),
        /Unverified build processes: pid=\d+ .*ownership=group-only/,
      )
      process.kill(child, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(await execution.stop(), true)
      assert.equal(execution.quarantineReason, undefined)
    } finally {
      if (child != null) {
        try {
          process.kill(child, 'SIGKILL')
        } catch {
          /* Already stopped. */
        }
      }
      await execution.stop()
    }
  })
  it('removes process inventory padding from start-time identities', () => {
    const rows = processSnapshot()
    assert(rows.some((row) => row.pid === process.pid))
    for (const row of rows) assert.match(row.start, /\S$/)
  })
  it('releases an unrelated process group after its leader PID is reused', async () => {
    const log = new MaskedLog(path.join(root, 'reused-process-group.log'), [])
    let leader: ReturnType<typeof processSnapshot>[number] | undefined
    let reused = false
    const execution = new Execution(
      log,
      () => {
        if (reused) {
          assert(leader)
          return [
            { ...leader, parent: 1, start: 'unrelated replacement' },
            {
              ...leader,
              pid: leader.pid + 1,
              parent: leader.pid,
              start: 'unrelated child',
            },
          ]
        }
        const rows = processSnapshot()
        leader ??= rows.find(
          (row) => row.parent === process.pid && row.group === row.pid,
        )
        return rows
      },
      0,
      500,
    )
    try {
      await execution.run(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 150)'],
        root,
      )
      assert(leader)
      reused = true
      assert.equal(await execution.stop(), true)
      assert.equal(execution.quarantineReason, undefined)
    } finally {
      await execution.stop()
    }
  })
  it('does not adopt a process checker that reuses a completed build PID', async () => {
    const log = new MaskedLog(path.join(root, 'reused-checker.log'), [])
    let leader: ReturnType<typeof processSnapshot>[number] | undefined
    let checking = false
    const execution = new Execution(
      log,
      () => {
        if (checking) {
          assert(leader)
          return [
            {
              ...leader,
              pid: process.pid,
              parent: 1,
              group: process.pid,
              start: 'guardian',
            },
            {
              ...leader,
              parent: process.pid,
              group: process.pid,
              start: 'process checker',
            },
          ]
        }
        const rows = processSnapshot()
        leader ??= rows.find(
          (row) => row.parent === process.pid && row.group === row.pid,
        )
        return rows
      },
      0,
      500,
    )
    try {
      await execution.run(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 150)'],
        root,
      )
      assert(leader)
      checking = true
      assert.equal(await execution.stop(), true)
      assert.equal(execution.quarantineReason, undefined)
    } finally {
      await execution.stop()
    }
  })
  it('allows cooperative cleanup subprocesses to finish after cancellation', async () => {
    const log = new MaskedLog(path.join(root, 'log'), [])
    const execution = new Execution(log)
    const ready = path.join(root, 'ready'),
      restored = path.join(root, 'restored')
    const run = execution
      .run(
        process.execPath,
        [
          '-e',
          `
      const {spawn}=require('node:child_process'); const fs=require('node:fs');
      process.once('SIGTERM',()=>{
        const c=spawn(process.execPath,['-e', 'setTimeout(()=>{require("node:fs").writeFileSync('+JSON.stringify(${JSON.stringify(restored)})+',"restored")},500)'],{detached:true,stdio:'ignore'});
        c.once('exit',()=>process.exit(0));
      });
      fs.writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000)
    `,
        ],
        root,
      )
      .catch(() => undefined)
    while (!existsSync(ready))
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(await execution.stop(), true)
    await run
    assert.equal(readFileSync(restored, 'utf8'), 'restored')
  })
  it('stops a detached descendant that ignores TERM', async () => {
    const log = new MaskedLog(path.join(root, 'log'), [])
    const execution = new Execution(log)
    const pidFile = path.join(root, 'pid')
    const run = execution
      .run(
        process.execPath,
        [
          '-e',
          `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`,
        ],
        root,
      )
      .catch(() => undefined)
    while (!existsSync(pidFile))
      await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await execution.stop(), true)
    await run
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0))
  })
})
