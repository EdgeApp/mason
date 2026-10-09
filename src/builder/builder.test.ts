import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, it } from 'mocha'
import {
  asBuilderConfig,
  asDefinition,
  asRequest,
  baseEnvironment,
  branchName,
  envName,
  loadBuilderConfig,
  relativePath,
  repository,
} from './config.js'
import { BuilderStore, exclusiveLock, publicJob } from './store.js'
import { executeJob, writeBootstrap } from './guardian.js'
import { MaskedLog, Execution } from './execution.js'
import { Worker, recover } from './worker.js'
import { builderApp, serveBuilder } from './server.js'
import { buildClient } from './client.js'
import { builderCommand } from './cli.js'

let root: string, store: BuilderStore
const definition = {
  slug: 'app.example.fixture',
  name: 'Fixture',
  repository: 'https://github.com/example/fixture.git',
  platforms: ['ios'],
}
const request = { app: definition.slug, branch: 'master' }
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  }).trim()
}
function fixture(source = "console.log('fixture completed')"): string {
  const repo = path.join(root, 'source')
  mkdirSync(repo, { mode: 0o700 })
  git(['init', '-b', 'master'], repo)
  writeFileSync(path.join(repo, 'Masonfile.ts'), source)
  git(['add', '.'], repo)
  git(['commit', '-m', 'Fixture'], repo)
  return repo
}
async function completed(
  worker: Worker,
  id: string,
): Promise<ReturnType<BuilderStore['job']>> {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const job = worker.store.job(id)!
    if (!['running', 'queued'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Job did not finish')
}
describe('Mason builder', function () {
  this.timeout(45000)
  beforeEach(async () => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'builder-'))
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const address = listener.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    store = new BuilderStore(
      asBuilderConfig({
        workspace: path.join(root, 'state'),
        port: address.port,
      }),
    )
    store.importApp(definition)
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('validates repository, branch, environment and file configuration', () => {
    assert.equal(
      repository('git@github.com:EXAMPLE/Fixture.git'),
      'git@github.com:example/fixture.git',
    )
    for (const value of [
      'file:///tmp/repo',
      'https://user:pass@github.com/a/b',
      'https://example.test/a/b',
      'https://github.com/../b',
    ])
      assert.throws(() => repository(value))
    for (const value of [
      '../x',
      '/x',
      'x//y',
      'x.lock',
      'x..y',
      '-x',
      'x/',
      'x.',
      'x/.y',
    ])
      assert.throws(() => branchName(value))
    assert.equal(branchName('feature/example'), 'feature/example')
    for (const value of ['../x', '/x', '.git/config', 'x//y'])
      assert.throws(() => relativePath(value))
    for (const value of ['MASON_BRANCH', 'NODE_OPTIONS', 'a b'])
      assert.throws(() => envName(value))
    assert.throws(() =>
      asDefinition({
        ...definition,
        env: [{ name: 'VALUE', value: '\0' }],
      }),
    )
    assert.throws(() => asDefinition({ ...definition, platforms: [] }))
    assert.throws(() =>
      asDefinition({
        ...definition,
        env: [
          { name: 'VALUE', value: 'x' },
          { name: 'VALUE', value: 'y' },
        ],
      }),
    )
    assert.throws(() =>
      asDefinition({
        ...definition,
        files: [{ destination: 'Masonfile.ts', contents: '' }],
      }),
    )
    assert.throws(() =>
      asDefinition({
        ...definition,
        files: [{ destination: 'config', contents: '!' }],
      }),
    )
    assert.throws(() => asRequest({ ...request, repository: 'no' }))
    assert.equal(baseEnvironment().NODE_OPTIONS, undefined)
    const file = path.join(root, 'config.json')
    writeBootstrap(file, { workspace: 'state' })
    assert.equal(loadBuilderConfig(file).workspace, store.config.workspace)
    mkdirSync(path.join(root, 'links'))
    const linked = path.join(root, 'links', 'config')
    symlinkSync(file, linked)
    assert.equal(
      loadBuilderConfig(linked).workspace,
      store.config.workspace,
    )
  })
  it('validates and persists canonical per-job environment overrides', () => {
    for (const envVars of [
      null,
      {},
      ['x'],
      [{}],
      [[]],
      [null],
      JSON.parse(
        '[{"APP_SERVER_URL":"preview.example.test","__proto__":{"x":true}}]',
      ),
      JSON.parse('[{"__proto__":"invalid"}]'),
      [{ A: 'a', B: 'b' }],
      [{ A: 1 }],
      [{ A: 'a' }, { A: 'b' }],
      [{ MASON_APP: 'other' }],
      [{ NODE_OPTIONS: '--inspect' }],
      [{ 'a b': 'x' }],
      [{ A: '\0' }],
      [{ A: 'x'.repeat(4097) }],
      [{ A: '界'.repeat(3000) }],
      Array.from({ length: 101 }, (_, i) => ({ ['V' + i]: '' })),
    ])
      assert.throws(() => asRequest({ ...request, envVars }))
    const envVars = [{ Z: 'last' }, { A: '' }]
    const first = store.enqueue(
      { ...request, envVars, idempotencyKey: 'env' },
      'test',
    )
    assert.deepEqual(first.request.envVars, [{ A: '' }, { Z: 'last' }])
    assert.equal(
      store.enqueue(
        {
          ...request,
          envVars: [...envVars].reverse(),
          idempotencyKey: 'env',
        },
        'test',
      ).id,
      first.id,
    )
    assert.throws(() =>
      store.enqueue(
        { ...request, envVars: [{ A: 'changed' }], idempotencyKey: 'env' },
        'test',
      ),
    )
    const config = store.config
    store.close()
    store = new BuilderStore(config)
    assert.deepEqual(store.job(first.id)!.request.envVars, [
      { A: '' },
      { Z: 'last' },
    ])
    const legacy = store.enqueue(
      { ...request, idempotencyKey: 'legacy' },
      'test',
    )
    store.db
      .prepare('UPDATE jobs SET request=? WHERE id=?')
      .run(
        JSON.stringify({ ...request, idempotencyKey: 'legacy' }),
        legacy.id,
      )
    assert.equal(
      store.enqueue(
        { ...request, envVars: [], idempotencyKey: 'legacy' },
        'test',
      ).id,
      legacy.id,
    )
    assert.deepEqual(store.job(legacy.id)!.request.envVars, [])
    store.importApp({
      ...definition,
      files: [
        { destination: 'private.json', contents: '', env: 'CONFIG_FILE' },
      ],
    })
    assert.throws(() =>
      store.enqueue(
        { ...request, envVars: [{ CONFIG_FILE: '/other' }] },
        'test',
      ),
    )
  })
  it('applies REST environment overrides privately to one build only', async () => {
    const repo = fixture(`import fs from 'node:fs';
      const value=process.env.APP_SERVER_URL;
      console.log(value);
      fs.writeFileSync(process.env.MASON_RESULT_FILE!,JSON.stringify({
        overridden:value==='https://preview.example.test',
        defaulted:value==='https://default.example.test',
        supplied:value,
        label:process.env.BUILD_LABEL
      }));`)
    store.importApp({
      ...definition,
      env: [
        { name: 'APP_SERVER_URL', value: 'https://default.example.test' },
      ],
    })
    const resolver = path.join(root, 'resolver.json')
    writeBootstrap(resolver, { [definition.repository]: repo })
    const worker = new Worker(store, resolver)
    const server = builderApp(store).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const keyFile = path.join(root, 'key')
    store.key(keyFile)
    const headers = {
      Authorization: `Bearer ${readFileSync(keyFile, 'utf8').trim()}`,
      'Content-Type': 'application/json',
    }
    const post = async (body: unknown): Promise<Response> =>
      await fetch(url + '/api/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    try {
      for (const envVars of [
        [{ MASON_BRANCH: 'other' }],
        [{ A: 'x'.repeat(10000) }],
      ]) {
        const bad = await post({ ...request, envVars })
        assert.equal(bad.status, 400)
        assert(!JSON.stringify(await bad.json()).includes('other'))
      }
      for (const override of [true, false]) {
        const body = {
          ...request,
          ...(override
            ? {
                envVars: [
                  { APP_SERVER_URL: 'https://preview.example.test' },
                  { BUILD_LABEL: 'quoted "fixture"' },
                ],
              }
            : {}),
        }
        const submitted = await post(body)
        assert.equal(submitted.status, 202)
        const visible = (await submitted.json()) as { id: string }
        assert(!JSON.stringify(visible).includes('envVars'))
        const job = await completed(worker, visible.id)
        assert.equal(job!.status, 'succeeded')
        const result = job!.result as Record<string, unknown>
        assert.equal(result.overridden, override)
        assert.equal(result.defaulted, !override)
        assert.equal(result.supplied, '[redacted]')
        if (override) assert.equal(result.label, '[redacted]')
        const publicResponse = await (
          await fetch(url + '/api/jobs/' + visible.id, { headers })
        ).text()
        const log = await (
          await fetch(url + '/api/jobs/' + visible.id + '/log', { headers })
        ).text()
        assert(!publicResponse.includes('example.test'))
        assert(!publicResponse.includes('envVars'))
        assert(!log.includes('example.test'))
        assert(log.includes('[redacted]'))
        console.log(
          'POST /api/jobs with envVars:',
          override,
          '-> 202; completed:',
          JSON.stringify(result),
          '; logs redacted',
        )
      }
      assert.equal(
        store.apps()[0]!.env[0]!.value,
        'https://default.example.test',
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await worker.close()
    }
  })
  it('snapshots app configuration, scopes keys and preserves queued jobs', () => {
    const keyFile = path.join(root, 'key'),
      keyId = store.key(keyFile),
      key = readFileSync(keyFile, 'utf8').trim()
    assert.equal(store.authenticate(key), keyId)
    assert.equal(store.authenticate('bad'), undefined)
    const first = store.enqueue(
      { ...request, idempotencyKey: 'request' },
      keyId,
    )
    store.importApp({ ...definition, name: 'Changed' })
    assert.equal(store.job(first.id)!.definition.name, 'Fixture')
    assert.equal(
      store.enqueue({ ...request, idempotencyKey: 'request' }, keyId).id,
      first.id,
    )
    assert.throws(() =>
      store.enqueue(
        { ...request, branch: 'other', idempotencyKey: 'request' },
        keyId,
      ),
    )
    assert.throws(() =>
      store.enqueue({ ...request, platforms: ['android'] }, keyId),
    )
    assert.throws(() =>
      store.enqueue({ ...request, app: 'unknown' }, keyId),
    )
    assert.equal('definition' in publicJob(first), false)
    store.revoke(keyId)
    assert.equal(store.authenticate(key), undefined)
    const reopened = new BuilderStore(store.config)
    assert.equal(reopened.pending().length, 1)
    reopened.close()
    assert.equal(store.cancel(first.id), true)
    assert.equal(store.job(first.id)!.status, 'cancelled')
    assert.equal(store.cancel(first.id), false)
    const lock = exclusiveLock(path.join(root, 'lock.sqlite'))
    assert.throws(() => exclusiveLock(path.join(root, 'lock.sqlite')))
    lock.close()
  })
  it('masks chunk boundaries and caps logs', () => {
    const file = path.join(root, 'log')
    const log = new MaskedLog(file, ['secret-value'], 35)
    log.write('prefix sec')
    log.write('ret-value suffix')
    log.write('x'.repeat(100), true)
    assert.equal(readFileSync(file).length, 35)
    assert.match(readFileSync(file, 'utf8'), /prefix \[redacted\] suffix/)
  })
  it('owns and refreshes worktrees, injects files and records pinned results', async () => {
    const repo = fixture(
      "import fs from 'node:fs'; console.log(process.env.TOKEN); console.log(fs.readFileSync(process.env.CONFIG_FILE!, 'utf8')); fs.writeFileSync(process.env.MASON_RESULT_FILE!, JSON.stringify({commit:process.env.MASON_COMMIT}));",
    )
    store.importApp({
      ...definition,
      env: [{ name: 'TOKEN', value: 'secret-token' }],
      files: [
        {
          destination: 'private.json',
          contents: Buffer.from('file-secret').toString('base64'),
          env: 'CONFIG_FILE',
        },
      ],
    })
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'succeeded')
    const log = readFileSync(
      path.join(store.config.workspace, 'logs', job.id + '.log'),
      'utf8',
    )
    assert(!log.includes('secret-token'))
    assert(!log.includes('file-secret'))
    const row = store.db
      .prepare(
        "SELECT directory FROM workspaces WHERE identity LIKE 'worktree:%'",
      )
      .get()!
    const checkout = String(row.directory)
    assert(!existsSync(path.join(checkout, 'private.json')))
    console.log(
      'Injection cleanup observed:',
      JSON.stringify({
        job: job.id,
        privateFileExists: existsSync(path.join(checkout, 'private.json')),
        secretVisible:
          log.includes('secret-token') || log.includes('file-secret'),
      }),
    )
    writeFileSync(path.join(checkout, 'junk'), 'dirty')
    writeFileSync(path.join(repo, 'new-file'), 'new')
    git(['add', '.'], repo)
    git(['commit', '-m', 'Update'], repo)
    const next = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      next.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(next.id)!.status, 'succeeded')
    assert.equal(
      store.job(next.id)!.commit_sha,
      git(['rev-parse', 'HEAD'], repo),
    )
    assert(!existsSync(path.join(checkout, 'junk')))
    assert(existsSync(path.join(checkout, 'new-file')))
  })
  it('redacts parsed result strings and keys without changing numeric values', async () => {
    const secret = 'pass"word\\line\nnext'
    const repo = fixture(
      "import fs from 'node:fs'; fs.writeFileSync(process.env.MASON_RESULT_FILE!, JSON.stringify({[process.env.TOKEN!]:[process.env.TOKEN!,{count:12,ok:true,empty:null}]}));",
    )
    store.importApp({
      ...definition,
      env: [
        { name: 'TOKEN', value: secret },
        { name: 'DIGIT', value: '1' },
      ],
    })
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'succeeded')
    assert.deepEqual(publicJob(store.job(job.id)!).result, {
      '[redacted]': ['[redacted]', { count: 12, ok: true, empty: null }],
    })
  })
  it('discards oversized redacted results without blocking the queue', async () => {
    const repo = fixture(
      "import fs from 'node:fs'; fs.writeFileSync(process.env.MASON_RESULT_FILE!, JSON.stringify({text:'x'.repeat(10000)}));",
    )
    store.importApp({ ...definition, env: [{ name: 'TOKEN', value: 'x' }] })
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'failed')
    assert.equal(store.job(job.id)!.quarantine, 0)
    assert.equal(store.job(job.id)!.result, undefined)
    const next = store.enqueue(request, 'test')
    assert.equal(store.claim()!.id, next.id)
  })
  it('supports relocated worktrees and retries database-owned interrupted clones', async () => {
    const repo = fixture()
    for (const workspace of ['git-worktrees', 'alternate']) {
      const transport =
        workspace === 'alternate'
          ? 'git@github.com:example/fixture.git'
          : definition.repository
      store.importApp({ ...definition, workspace, repository: transport })
      const job = store.enqueue(request, 'test')
      store.claim()
      await executeJob(
        store,
        job.id,
        new AbortController().signal,
        (url) => {
          assert.equal(url, transport)
          return repo
        },
      )
      assert.equal(store.job(job.id)!.status, 'succeeded')
    }
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM workspaces WHERE identity LIKE 'worktree:%'",
        )
        .get()!.n,
      2,
    )
    const row = store.db
      .prepare(
        "SELECT directory FROM workspaces WHERE directory LIKE '%alternate%'",
      )
      .get()!
    rmSync(String(row.directory), { recursive: true })
    const recreated = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      recreated.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(recreated.id)!.status, 'succeeded')
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM workspaces WHERE identity LIKE 'clone:%'",
        )
        .get()!.n,
      1,
    )
    // Model a killed initial clone before its completion marker was written.
    const clone = String(
      store.db
        .prepare(
          "SELECT directory FROM workspaces WHERE identity LIKE 'clone:%'",
        )
        .get()!.directory,
    )
    rmSync(clone, { recursive: true })
    mkdirSync(clone)
    writeFileSync(path.join(clone, 'partial'), 'incomplete')
    // Remove old worktrees because this fixture models an initial clone.
    for (const row of store.db
      .prepare(
        "SELECT directory FROM workspaces WHERE identity LIKE 'worktree:%'",
      )
      .all())
      rmSync(String(row.directory), { recursive: true })
    const retry = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      retry.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(retry.id)!.status, 'succeeded')
    assert(!existsSync(path.join(clone, 'partial')))
  })
  it('pins and cleans initialized submodules between repeated builds', async () => {
    const dependency = path.join(root, 'dependency')
    mkdirSync(dependency)
    git(['init', '-b', 'master'], dependency)
    writeFileSync(path.join(dependency, 'value'), 'first')
    git(['add', '.'], dependency)
    git(['commit', '-m', 'First'], dependency)
    const repo = fixture()
    git(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        dependency,
        'dependency',
      ],
      repo,
    )
    git(['commit', '-am', 'Dependency'], repo)
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'succeeded')
    const checkout = String(
      store.db
        .prepare(
          "SELECT directory FROM workspaces WHERE identity LIKE 'worktree:%'",
        )
        .get()!.directory,
    )
    git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'],
      checkout,
    )
    const child = path.join(checkout, 'dependency')
    writeFileSync(path.join(child, 'junk'), 'old output')
    writeFileSync(path.join(child, 'value'), 'dirty')
    writeFileSync(path.join(dependency, 'value'), 'second')
    git(['commit', '-am', 'Second'], dependency)
    const wanted = git(['rev-parse', 'HEAD'], dependency)
    git(['fetch', 'origin'], path.join(repo, 'dependency'))
    git(['checkout', wanted], path.join(repo, 'dependency'))
    git(['commit', '-am', 'Advance dependency'], repo)
    git(['fetch', 'origin'], child)
    const next = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      next.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(next.id)!.status, 'succeeded')
    assert.equal(git(['rev-parse', 'HEAD'], child), wanted)
    assert.equal(readFileSync(path.join(child, 'value'), 'utf8'), 'second')
    assert(!existsSync(path.join(child, 'junk')))
  })
  it('repairs an owned checkout lock during confirmed recovery', async () => {
    const repo = fixture()
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    const checkout = String(
      store.db
        .prepare(
          "SELECT directory FROM workspaces WHERE identity LIKE 'worktree:%'",
        )
        .get()!.directory,
    )
    const gitDir = git(['rev-parse', '--absolute-git-dir'], checkout)
    writeFileSync(path.join(gitDir, 'index.lock'), '')
    store.finish(job.id, 'interrupted', undefined, undefined, true)
    recover(store, job.id, true)
    assert(!existsSync(checkout))
    const next = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      next.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(next.id)!.status, 'succeeded')
  })
  it('retains timeout status when result writing was interrupted', async () => {
    const repo = fixture(
      "import fs from 'node:fs'; fs.writeFileSync(process.env.MASON_RESULT_FILE!,'{'); setInterval(()=>{},1000)",
    )
    store.importApp({ ...definition, timeoutSeconds: 2 })
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'timed_out')
    assert.equal(store.job(job.id)!.quarantine, 0)
  })
  it('releases the worker lock after a failed guardian launch', async () => {
    const worker = new Worker(
      store,
      undefined,
      path.join(root, 'missing-node'),
    )
    const job = store.enqueue(request, 'test')
    await completed(worker, job.id)
    await worker.close()
    assert.equal(store.job(job.id)!.status, 'interrupted')
    assert.equal(store.job(job.id)!.quarantine, 1)
    const next = new Worker(store)
    await next.close()
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
  it('does not overwrite or remove tracked injected-file destinations', async () => {
    const repo = fixture()
    writeFileSync(path.join(repo, 'config'), 'tracked')
    git(['add', '.'], repo)
    git(['commit', '-m', 'Config'], repo)
    store.importApp({
      ...definition,
      files: [{ destination: 'config', contents: '' }],
    })
    const job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'failed')
    const row = store.db
      .prepare(
        "SELECT directory FROM workspaces WHERE identity LIKE 'worktree:%'",
      )
      .get()!
    assert.equal(
      readFileSync(path.join(String(row.directory), 'config'), 'utf8'),
      'tracked',
    )
  })
  it('fails and cancels jobs without leaving injected files', async () => {
    const repo = fixture('setInterval(()=>{},1000)')
    store.importApp({
      ...definition,
      timeoutSeconds: 1,
      files: [{ destination: 'private', contents: '' }],
    })
    let job = store.enqueue(request, 'test')
    store.claim()
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'timed_out')
    job = store.enqueue(request, 'test')
    store.claim()
    store.cancel(job.id)
    await executeJob(
      store,
      job.id,
      new AbortController().signal,
      () => repo,
    )
    assert.equal(store.job(job.id)!.status, 'cancelled')
    job = store.enqueue(request, 'test')
    store.claim()
    const abort = new AbortController()
    abort.abort()
    await executeJob(store, job.id, abort.signal, () => repo)
    assert.equal(store.job(job.id)!.status, 'interrupted')
  })
  it('serves authenticated API and the real build client through a guardian worker', async () => {
    const repo = fixture()
    const resolver = path.join(root, 'resolver.json')
    writeBootstrap(resolver, { [definition.repository]: repo })
    const worker = new Worker(store, resolver)
    const server = builderApp(store).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const keyFile = path.join(root, 'key')
    store.key(keyFile)
    const key = readFileSync(keyFile, 'utf8').trim(),
      headers = {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      }
    const client = path.join(root, 'client.json')
    writeBootstrap(client, {
      url,
      keyFile: path.basename(keyFile),
      pollMs: 50,
    })
    mkdirSync(path.join(root, 'links'))
    const linkedClient = path.join(root, 'links', 'client')
    symlinkSync(client, linkedClient)
    try {
      const denied = await fetch(url + '/api/jobs/invalid')
      console.log(
        'GET /api/jobs/invalid without credentials ->',
        denied.status,
        await denied.clone().text(),
      )
      assert.equal(denied.status, 401)
      assert.equal(
        (
          await fetch(url + '/api/jobs', {
            method: 'POST',
            headers,
            body: '{}',
          })
        ).status,
        400,
      )
      assert.equal(
        (await fetch(url + '/api/jobs/invalid', { headers })).status,
        404,
      )
      assert.equal(
        (await fetch(url + '/api/jobs/invalid/log', { headers })).status,
        404,
      )
      assert.equal(
        (
          await fetch(url + '/api/jobs/invalid/cancel', {
            method: 'POST',
            headers,
          })
        ).status,
        409,
      )
      assert.equal(
        await buildClient(linkedClient, request, () => undefined),
        true,
      )
      await builderCommand(
        [
          'build',
          '--client-config',
          client,
          '--app',
          definition.slug,
          '--branch',
          'master',
        ],
        () => undefined,
      )
      for (const outcome of ['succeeded', 'partial', 'failed']) {
        git(['checkout', '-B', outcome], repo)
        writeFileSync(
          path.join(repo, 'Masonfile.ts'),
          `import fs from 'node:fs'; fs.writeFileSync(process.env.MASON_RESULT_FILE!, JSON.stringify({status:${JSON.stringify(outcome)}})); process.exitCode=${outcome === 'succeeded' ? 0 : 1}`,
        )
        git(['add', '.'], repo)
        git(['commit', '-m', outcome], repo)
        const child = spawn(
          process.execPath,
          [
            'lib/cli.js',
            'builder',
            'build',
            '--client-config',
            client,
            '--app',
            definition.slug,
            '--branch',
            outcome,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let report = ''
        child.stdout!.on('data', (chunk) => {
          report += String(chunk)
        })
        child.stderr!.resume()
        assert.equal(
          (await once(child, 'exit'))[0],
          outcome === 'succeeded' ? 0 : 1,
        )
        assert.match(report, new RegExp(outcome))
        console.log('CLI build ' + outcome + ': ' + report.trim())
      }
      const response = await fetch(url + '/api/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      })
      const job = (await response.json()) as { id: string }
      console.log(
        'POST /api/jobs',
        JSON.stringify(request),
        '->',
        response.status,
        JSON.stringify(job),
      )
      const retryBody = JSON.stringify({
        ...request,
        idempotencyKey: 'fixture-retry',
      })
      const retry1 = await fetch(url + '/api/jobs', {
        method: 'POST',
        headers,
        body: retryBody,
      })
      const retryJob1 = (await retry1.json()) as { id: string }
      const retry2 = await fetch(url + '/api/jobs', {
        method: 'POST',
        headers,
        body: retryBody,
      })
      const retryJob2 = (await retry2.json()) as { id: string }
      assert.equal(retryJob1.id, retryJob2.id)
      console.log(
        'POST /api/jobs twice',
        retryBody,
        '->',
        retry1.status,
        retry2.status,
        'same job',
        retryJob1.id,
      )
      assert.equal(response.status, 202)
      assert.equal((await completed(worker, job.id))!.status, 'succeeded')
      assert.match(
        await (
          await fetch(url + `/api/jobs/${job.id}/log`, { headers })
        ).text(),
        /fixture completed/,
      )
      console.log(
        'GET /api/jobs/' + job.id + '/log ->',
        await (
          await fetch(url + '/api/jobs/' + job.id + '/log', {
            headers,
          })
        ).text(),
      )
      await completed(worker, retryJob1.id)
      assert.throws(() => new Worker(store))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await worker.close()
    }
  })
  it('requires explicit recovery after uncertain execution ownership', async () => {
    const job = store.enqueue(request, 'test')
    store.claim()
    const worker = new Worker(store)
    assert.equal(store.job(job.id)!.status, 'interrupted')
    assert.equal(store.claim(), undefined)
    assert.throws(() => recover(store, job.id, true))
    await worker.close()
    assert.throws(() => recover(store, job.id, false))
    recover(store, job.id, true)
    assert.equal(store.job(job.id)!.quarantine, 0)
    assert.throws(() => recover(store, job.id, true))
  })
  it('rejects symlink state paths and insecure private client configuration', async () => {
    const link = path.join(root, 'link')
    symlinkSync(store.config.workspace, link)
    assert.throws(
      () => new BuilderStore({ ...store.config, workspace: link }),
    )
    const file = path.join(root, 'config')
    writeBootstrap(file, {
      url: 'https://example.test',
      keyFile: 'key',
    })
    chmodSync(file, 0o644)
    await assert.rejects(buildClient(file, request))
  })
  it('exposes app import and key management through CLI', async () => {
    const config = path.join(root, 'config'),
      app = path.join(root, 'app'),
      key = path.join(root, 'key')
    writeBootstrap(config, store.config)
    writeBootstrap(app, definition)
    const output: string[] = []
    await builderCommand(
      ['app-import', '--config', config, '--file', app],
      (s) => output.push(s),
    )
    await builderCommand(['apps', '--config', config], (s) =>
      output.push(s),
    )
    await builderCommand(
      ['key-create', '--config', config, '--output', key],
      (s) => output.push(s),
    )
    const { id } = JSON.parse(output[2]!) as { id: string }
    await builderCommand(
      ['key-revoke', '--config', config, '--id', id],
      () => undefined,
    )
    assert.equal(
      store.authenticate(readFileSync(key, 'utf8').trim()),
      undefined,
    )
    for (const args of [
      [],
      ['bad'],
      ['apps', '--bad', 'x'],
      ['apps', '--config'],
      ['apps'],
      ['apps', '--config', config, '--config', config],
    ])
      await assert.rejects(builderCommand(args))
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
    assert.throws(() =>
      process.kill(Number(readFileSync(pidFile, 'utf8')), 0),
    )
  })
  it('bounds API requests, accepts cancellation and shuts down its explicit role', async () => {
    const service = serveBuilder(store)
    await once(service.server, 'listening')
    const keyFile = path.join(root, 'key')
    store.key(keyFile)
    const headers = {
      Authorization: 'Bearer ' + readFileSync(keyFile, 'utf8').trim(),
      'Content-Type': 'application/json',
    }
    const url = `http://127.0.0.1:${store.config.port}`
    try {
      assert.equal(
        (
          await fetch(url + '/api/jobs', {
            method: 'POST',
            headers,
            body: '{',
          })
        ).status,
        400,
      )
      const job = store.enqueue(request, 'test')
      assert.equal(
        (
          await fetch(url + `/api/jobs/${job.id}/cancel`, {
            method: 'POST',
            headers,
          })
        ).status,
        200,
      )
      console.log(
        'POST /api/jobs/' + job.id + '/cancel ->',
        JSON.stringify(publicJob(store.job(job.id)!)),
      )
      for (let i = 0; i < 1201; i++)
        await fetch(url + '/api/jobs/invalid', { headers })
      assert.equal(
        (await fetch(url + '/api/jobs/invalid', { headers })).status,
        429,
      )
    } finally {
      service.server.closeAllConnections()
      await service.close()
      store = new BuilderStore(store.config)
    }
  })
  it('cleans recovered injection manifests and stops live workers before releasing ownership', async () => {
    const repo = fixture('setInterval(()=>{},1000)')
    const resolver = path.join(root, 'resolver')
    writeBootstrap(resolver, { [definition.repository]: repo })
    const worker = new Worker(store, resolver)
    const job = store.enqueue(request, 'test')
    while (store.job(job.id)!.commit_sha == null)
      await new Promise((resolve) => setTimeout(resolve, 50))
    await worker.close()
    assert.equal(store.job(job.id)!.status, 'interrupted')
    const another = store.enqueue(request, 'test')
    store.claim()
    const abandoned = path.join(store.config.workspace, 'files', 'injected')
    writeFileSync(abandoned, 'fixture')
    writeBootstrap(
      path.join(
        store.config.workspace,
        'executions',
        another.id + '.files.json',
      ),
      [abandoned],
    )
    const restarted = new Worker(store)
    await restarted.close()
    recover(store, another.id, true)
    assert(!existsSync(abandoned))
  })
  it('runs the compiled role and handles listener failures without exposing configuration', async () => {
    const config = path.join(root, 'config')
    writeBootstrap(config, store.config)
    const args = ['lib/cli.js', 'builder', 'serve', '--config', config]
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await once(child.stdout!, 'data')
    const second = spawn(process.execPath, args, { stdio: 'ignore' })
    assert.equal((await once(second, 'exit'))[0], 1)
    child.kill('SIGTERM')
    assert.equal((await once(child, 'exit'))[0], 0)
    const job = store.enqueue(request, 'test')
    store.claim()
    await builderCommand(
      [
        'recover',
        '--config',
        config,
        '--job',
        job.id,
        '--confirm-stopped',
        'yes',
      ],
      () => undefined,
    )
  })
  it('contains abrupt server death and quarantines a separately killed guardian', async () => {
    const pidFile = path.join(root, 'compiler.pid')
    const repo = fixture(
      `import {spawn} from 'node:child_process'; import fs from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000)`,
    )
    const config = path.join(root, 'config'),
      resolver = path.join(root, 'resolver')
    writeBootstrap(config, store.config)
    writeBootstrap(resolver, { [definition.repository]: repo })
    const runner = path.join(root, 'server.mjs')
    writeFileSync(
      runner,
      `import {BuilderStore} from ${JSON.stringify(new URL('../../lib/builder/store.js', import.meta.url).href)}; import {Worker} from ${JSON.stringify(new URL('../../lib/builder/worker.js', import.meta.url).href)}; import fs from 'node:fs'; const store=new BuilderStore(JSON.parse(fs.readFileSync(process.argv[2]))); new Worker(store,process.argv[3]); console.log('ready');`,
    )
    const launch = async (): Promise<ReturnType<typeof spawn>> => {
      const child = spawn(process.execPath, [runner, config, resolver], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      await once(child.stdout!, 'data')
      return child
    }
    const server = await launch()
    const job = store.enqueue(request, 'fixture')
    while (!existsSync(pidFile))
      await new Promise((resolve) => setTimeout(resolve, 50))
    const compiler = Number(readFileSync(pidFile, 'utf8'))
    server.kill('SIGKILL')
    await once(server, 'exit')
    const restarted = new Worker(store, resolver)
    const next = store.enqueue(request, 'fixture')
    store.cancel(next.id)
    const done = await completed(restarted, job.id)
    assert.equal(done!.status, 'interrupted')
    assert.throws(() => process.kill(compiler, 0))
    console.log(
      'Abrupt server restart observation:',
      JSON.stringify({
        job: job.id,
        status: done!.status,
        ownedCompilerGone: true,
        nextJob: store.job(next.id)!.status,
      }),
    )
    await restarted.close()
    rmSync(pidFile)
    const again = await launch()
    const orphanJob = store.enqueue(request, 'fixture')
    while (!existsSync(pidFile))
      await new Promise((resolve) => setTimeout(resolve, 50))
    const childRows = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
    const guardian = childRows.find((row) => row[1] === again.pid)![0]!
    const masonfile = childRows.find((row) => row[1] === guardian)![0]!
    process.kill(guardian, 'SIGKILL')
    while (store.job(orphanJob.id)!.status === 'running')
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(store.job(orphanJob.id)!.quarantine, 1)
    assert.equal(store.claim(), undefined)
    console.log(
      'Killed guardian observation:',
      JSON.stringify({
        job: orphanJob.id,
        status: store.job(orphanJob.id)!.status,
        quarantine: store.job(orphanJob.id)!.quarantine,
        nextClaimBlocked: true,
      }),
    )
    for (const pid of [Number(readFileSync(pidFile, 'utf8')), masonfile]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
    }
    again.kill('SIGKILL')
    await once(again, 'exit')
    recover(store, orphanJob.id, true)
    assert.equal(store.job(orphanJob.id)!.quarantine, 0)
  })
})
