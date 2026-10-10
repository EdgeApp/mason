import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import {
  AutomaticPoller,
  AUTOMATIC_POLL_MS,
  remoteHead,
} from './automatic.js'
import { asBuilderConfig } from './config.js'
import { BuilderStore } from './store.js'
import { builderApp } from './server.js'
import { executeJob } from './guardian.js'

const app = {
  slug: 'app.example.automatic',
  name: 'Automatic fixture',
  repository: 'https://github.com/example/fixture.git',
  platforms: ['ios'],
}
const a = 'a'.repeat(40),
  b = 'b'.repeat(40)
const settings = {
  defaultBranch: 'master',
  automaticBranches: ['master'],
}
let root: string,
  store: BuilderStore,
  poller: AutomaticPoller | undefined
describe('Automatic branch builds', function () {
  this.timeout(15000)
  beforeEach(() => {
    root = mkdtempSync(
      path.join(process.env.MASON_TEST_ROOT!, 'automatic-'),
    )
    store = new BuilderStore(
      asBuilderConfig({ workspace: path.join(root, 'state') }),
    )
    store.importApp(app)
  })
  afterEach(async () => {
    await poller?.close()
    poller = undefined
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('keeps automation opt-in and resolves omitted branches with stable idempotency', () => {
    assert.deepEqual(store.buildSettings(app.slug), {
      defaultBranch: 'master',
      automaticBranches: [],
      branches: [],
    })
    store.configureBuilds(app.slug, {
      defaultBranch: 'feature/example',
      automaticBranches: [],
    })
    const job = store.enqueue(
      { app: app.slug, idempotencyKey: 'default' },
      'key',
    )
    assert.equal(job.branch, 'feature/example')
    store.configureBuilds(app.slug, settings)
    assert.equal(
      store.enqueue(
        { app: app.slug, idempotencyKey: 'default' },
        'key',
      ).id,
      job.id,
    )
    assert.throws(() =>
      store.enqueue(
        {
          app: app.slug,
          branch: 'master',
          idempotencyKey: 'default',
        },
        'key',
      ),
    )
    store.importApp({ ...app, name: 'Updated' })
    assert.equal(
      store.buildSettings(app.slug).defaultBranch,
      'master',
    )
  })
  it('protects settings with the API key and never returns private definitions', async () => {
    store.importApp({
      ...app,
      env: [
        {
          name: 'PRIVATE_VALUE',
          value: 'fixture-private',
          secret: true,
        },
      ],
    })
    const keyFile = path.join(root, 'key')
    store.key(keyFile)
    const key = readFileSync(keyFile, 'utf8').trim()
    const server = builderApp(store).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    }
    try {
      assert.equal((await fetch(url + '/api/apps')).status, 401)
      assert.equal(
        (
          await fetch(url + `/api/apps/${app.slug}/build-settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
          })
        ).status,
        401,
      )
      const response = await fetch(
        url + `/api/apps/${app.slug}/build-settings`,
        { method: 'PUT', headers, body: JSON.stringify(settings) },
      )
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.pollIntervalMs, 300000)
      assert.deepEqual(body.automaticBranches, ['master'])
      assert.equal(AUTOMATIC_POLL_MS, 300000)
      const apps = await (
        await fetch(url + '/api/apps', { headers })
      ).text()
      assert(!apps.includes('fixture-private'))
      assert(!apps.includes('definition'))
      for (const invalid of [
        { ...settings, automaticBranches: ['master', 'master'] },
        { ...settings, automaticBranches: ['../bad'] },
        { ...settings, unknown: true },
        {
          ...settings,
          automaticBranches: Array.from(
            { length: 21 },
            (_, i) => `feature/${i}`,
          ),
        },
      ])
        assert.equal(
          (
            await fetch(
              url + `/api/apps/${app.slug}/build-settings`,
              {
                method: 'PUT',
                headers,
                body: JSON.stringify(invalid),
              },
            )
          ).status,
          400,
        )
      assert.equal(
        (
          await fetch(url + '/api/apps/unknown/build-settings', {
            headers,
          })
        ).status,
        404,
      )
      assert.equal(
        (
          await fetch(url + '/api/apps/unknown/build-settings', {
            method: 'PUT',
            headers,
            body: JSON.stringify(settings),
          })
        ).status,
        400,
      )
      const submitted = await (
        await fetch(url + '/api/jobs', {
          method: 'POST',
          headers,
          body: JSON.stringify({ app: app.slug }),
        })
      ).json()
      assert.equal(submitted.branch, 'master')
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      )
    }
  })
  it('reserves only three attempts per commit, even after restart, pruning and re-enabling', () => {
    store.configureBuilds(app.slug, settings)
    for (let i = 1; i <= 3; i++) {
      const job = store.enqueueAutomatic(app.slug, 'master', a)
      assert(job)
      assert.equal(
        store.enqueueAutomatic(app.slug, 'master', a),
        undefined,
      )
      store.claim()
      store.commit(job.id, a)
      store.finish(job.id, 'failed', 1)
      assert.equal(
        store.buildSettings(app.slug).branches[0]!.attempts,
        i,
      )
    }
    const config = store.config
    store.close()
    store = new BuilderStore(config)
    store.db.prepare('UPDATE jobs SET finished=?').run(0)
    store.prune()
    store.configureBuilds(app.slug, {
      ...settings,
      automaticBranches: [],
    })
    store.configureBuilds(app.slug, settings)
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
    const next = store.enqueueAutomatic(app.slug, 'master', b)
    assert(next)
    store.cancel(next.id)
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
    const state = store.buildSettings(app.slug).branches[0]!
    assert.equal(state.lastAttemptedCommit, b)
    assert.equal(state.lastSuccessfulCommit, undefined)
  })
  it('records successes atomically, stops retries and leaves the last success visible on a newer failure', () => {
    store.configureBuilds(app.slug, settings)
    const first = store.enqueueAutomatic(app.slug, 'master', a)!
    store.claim()
    assert.throws(() => store.commit(first.id, b))
    store.commit(first.id, a)
    store.finish(first.id, 'succeeded', 0)
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
    const next = store.enqueueAutomatic(app.slug, 'master', b)!
    store.claim()
    store.commit(next.id, b)
    store.finish(next.id, 'failed', 1)
    const state = store.buildSettings(app.slug).branches[0]!
    assert.equal(state.lastSuccessfulCommit, a)
    assert.equal(state.lastAttemptedCommit, b)
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
  })
  it('defers behind manual builds, a full queue or quarantine without consuming attempts', () => {
    store.configureBuilds(app.slug, settings)
    const manual = store.enqueue(
      { app: app.slug, branch: 'master' },
      'key',
    )
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
    store.cancel(manual.id)
    const hold = store.enqueue(
      { app: app.slug, branch: 'other' },
      'key',
    )
    store.claim()
    store.finish(hold.id, 'failed', 1, undefined, true)
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
    store.releaseQuarantine(hold.id)
    const queue = Array.from({ length: 100 }, () =>
      store.enqueue({ app: app.slug, branch: 'other' }, 'key'),
    )
    assert.equal(
      store.enqueueAutomatic(app.slug, 'master', a),
      undefined,
    )
    assert.equal(
      store.buildSettings(app.slug).branches[0]!.attempts,
      0,
    )
    store.cancel(queue[0]!.id)
    assert(store.enqueueAutomatic(app.slug, 'master', a))
  })
  it('coalesces overlapping polls, shares remote checks and honors changes made during lookup', async () => {
    const second = { ...app, slug: 'app.example.second' }
    store.importApp(second)
    store.configureBuilds(app.slug, settings)
    store.configureBuilds(second.slug, settings)
    let done!: (sha: string) => void
    let calls = 0
    poller = new AutomaticPoller(store, async () => {
      calls++
      return await new Promise<string>((resolve) => {
        done = resolve
      })
    })
    const first = poller.poll(),
      overlap = poller.poll()
    assert.equal(first, overlap)
    store.configureBuilds(second.slug, {
      ...settings,
      automaticBranches: [],
    })
    done(a)
    await first
    assert.equal(calls, 1)
    assert.equal(store.pending().length, 1)
    assert.equal(store.pending()[0]!.app, app.slug)
    assert.equal(
      store.buildSettings(app.slug).branches[0]!.observedCommit,
      a,
    )
    await poller.close()
    poller = undefined
  })
  it('records lookup errors without spending a retry and skips disabled apps', async () => {
    store.configureBuilds(app.slug, settings)
    let failing = true,
      calls = 0
    poller = new AutomaticPoller(store, async () => {
      calls++
      if (failing) throw new Error('private transport output')
      return a
    })
    await poller.poll()
    assert.equal(store.pending().length, 0)
    const state = store.buildSettings(app.slug).branches[0]!
    assert.equal(state.pollError, 'Could not read branch head')
    assert.equal(state.attempts, 0)
    failing = false
    store.importApp({ ...app, enabled: false })
    await poller.poll()
    assert.equal(calls, 1)
    store.importApp(app)
    await poller.poll()
    assert.equal(store.pending().length, 1)
    assert.equal(
      store.buildSettings(app.slug).branches[0]!.pollError,
      undefined,
    )
  })
  it('polls again on the timer and aborts in-flight lookup when closed', async () => {
    store.configureBuilds(app.slug, settings)
    let calls = 0
    poller = new AutomaticPoller(
      store,
      async () => {
        calls++
        return a
      },
      20,
    )
    await poller.poll()
    await new Promise((resolve) => setTimeout(resolve, 65))
    assert(calls >= 2)
    assert.equal(store.pending().length, 1)
    await poller.close()
    poller = undefined
    let aborted = false
    poller = new AutomaticPoller(
      store,
      async (_repo, _branch, signal) =>
        await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('closed'))
            },
            { once: true },
          )
        }),
    )
    await poller.close()
    assert(aborted)
  })
  it('reads a real Git ref and builds the polled commit even when the branch advances before execution', async () => {
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.test',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.test',
        },
      }).trim()
    git(['init', '-b', 'master'])
    writeFileSync(
      path.join(repo, 'Masonfile.js'),
      `require('node:fs').writeFileSync(process.env.MASON_RESULT_FILE,JSON.stringify({commit:process.env.MASON_COMMIT}));`,
    )
    git(['add', '.'])
    git(['commit', '-m', 'First fixture'])
    const original = git(['rev-parse', 'HEAD'])
    assert.equal(
      await remoteHead(repo, 'master', new AbortController().signal),
      original,
    )
    await assert.rejects(
      remoteHead(repo, 'missing', new AbortController().signal),
    )
    const stopped = new AbortController()
    stopped.abort()
    await assert.rejects(remoteHead(repo, 'master', stopped.signal))
    store.configureBuilds(app.slug, settings)
    const job = store.enqueueAutomatic(app.slug, 'master', original)!
    store.claim()
    writeFileSync(path.join(repo, 'change'), 'next')
    git(['add', '.'])
    git(['commit', '-m', 'Next fixture'])
    const latest = git(['rev-parse', 'HEAD'])
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'succeeded')
    assert.equal(store.job(job.id)!.commit_sha, original)
    assert.deepEqual(store.job(job.id)!.result, { commit: original })
    assert.equal(
      store.buildSettings(app.slug).branches[0]!.lastSuccessfulCommit,
      original,
    )
    poller = new AutomaticPoller(
      store,
      async () =>
        await remoteHead(
          repo,
          'master',
          new AbortController().signal,
        ),
    )
    await poller.poll()
    assert.equal(store.pending()[0]!.requested_commit, latest)
  })
  it('bounds unexpected Git output and masks transport diagnostics', async () => {
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    const script = path.join(bin, 'git')
    writeFileSync(
      script,
      `#!${process.execPath}\nprocess.stderr.write('fixture-private diagnostic');process.stdout.write('x'.repeat(131072));setInterval(()=>{},1000)\n`,
      { mode: 0o700 },
    )
    const previous = process.env.PATH
    process.env.PATH = bin + path.delimiter + previous
    try {
      await assert.rejects(
        remoteHead(
          app.repository,
          'master',
          new AbortController().signal,
        ),
        (error) => {
          assert(error instanceof Error)
          assert.equal(error.message, 'Branch lookup failed')
          return true
        },
      )
    } finally {
      process.env.PATH = previous
    }
  })
})
