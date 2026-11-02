import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import type { Graph } from '../pipeline/graph.js'
import { MasterDatabase } from './database.js'
import { Jobs } from './jobs.js'
import { Mirrors } from './mirrors.js'
import { Poller } from './poller.js'
import { Projects, type Project } from './projects.js'
import { MAX_SOURCES, Pushes, type PushResult } from './pushes.js'
import { localOperator } from './roles.js'

const commit = (n: number): string => n.toString(16).padStart(40, 'c')

/** A mirror whose commits are maps of file to text; `throws` fails every read. */
class FakeMirrors {
  readonly commits = new Map<string, Record<string, string>>()
  throws = false
  hang = false
  reads = 0
  async ensure(): Promise<string | undefined> {
    if (this.hang) await new Promise(() => undefined)
    return undefined
  }
  /** Entries other than regular files, by commit: a path and its mode. */
  readonly special = new Map<string, Record<string, string>>()
  async tree(
    _project: string,
    _repository: string,
    at: string,
    dir: string,
  ): Promise<Array<{ mode: string; name: string }> | undefined> {
    const prefix = dir === '' ? '' : `${dir}/`
    const entries = new Map<string, string>()
    for (const file of Object.keys(this.commits.get(at) ?? {}))
      if (file.startsWith(prefix)) {
        const [name, ...rest] = file.slice(prefix.length).split('/')
        entries.set(name!, rest.length === 0 ? '100644' : '040000')
      }
    for (const [file, mode] of Object.entries(this.special.get(at) ?? {}))
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
        entries.set(file.slice(prefix.length), mode)
    if (dir !== '' && entries.size === 0) return undefined
    return [...entries].map(([name, mode]) => ({ mode, name }))
  }
  async file(
    _project: string,
    _repository: string,
    at: string,
    file: string,
    maxBytes: number,
  ): Promise<{ blob: string; text?: string } | undefined> {
    this.reads++
    if (this.throws) throw new Error('git show failed: maxBuffer exceeded')
    const text = this.commits.get(at)?.[file]
    if (text == null) return undefined
    const blob = createHash('sha1').update(text).digest('hex')
    return Buffer.byteLength(text) > maxBytes ? { blob } : { blob, text }
  }
}

const computed = `import { B } from './ci/b.ts'
export function setup(m) {
  m.workflow('build', { triggers: [{ push: true, branches: B }] }, () => {})
}
`
const graph = (branches: string[]): Graph =>
  ({
    apiVersion: 1,
    format: 'pipeline',
    workflows: [{ name: 'build', triggers: [{ push: true, branches }] }],
    buildNumbers: {},
    warnings: [],
  }) as unknown as Graph

function setup(): {
  master: MasterDatabase
  projects: Projects
  mirrors: FakeMirrors
  pushes: Pushes
  project: () => Project
} {
  const master = new MasterDatabase(new DatabaseSync(':memory:'))
  const projects = new Projects(master)
  projects.save(localOperator, 'p', {
    repository: 'https://github.com/a/b',
    format: 'pipeline',
  })
  projects.setRules(localOperator, 'p', [{ pattern: '**', mode: 'automatic' }])
  const mirrors = new FakeMirrors()
  const pushes = new Pushes({
    master,
    jobs: new Jobs(master, projects),
    mirrors,
    fetchMs: 100,
  })
  return { master, projects, mirrors, pushes, project: () => projects.get('p') }
}

describe('Push decisions', () => {
  it('M1 records whether a branch’s build runs when a device is registered, even when its sources cannot be hashed', async () => {
    const { master, mirrors, pushes, project } = setup()
    mirrors.commits.set(commit(1), {
      'Masonfile.ts': 'export function setup(m) {}\n',
    })
    mirrors.commits.set(commit(2), {
      'Masonfile.ts': `import { readFile } from 'node:fs/promises'\nexport function setup(m) {}\n`,
    })
    const recorded = async (at: string, built: Graph): Promise<unknown> => {
      pushes.remember(project(), 'main', at, built)
      await pushes.settled()
      return master.db
        .prepare(
          "SELECT device_registered FROM automatic_branches WHERE branch='main'",
        )
        .get()?.device_registered
    }
    const device = graph(['main'])
    device.workflows[0]!.triggers.push({ deviceRegistered: true })
    assert.equal(typeof (await recorded(commit(1), device)), 'number')
    assert.equal(await recorded(commit(1), graph(['main'])), null)
    // A Masonfile that imports node: keeps no push triggers, but the flag.
    assert.equal(typeof (await recorded(commit(2), device)), 'number')
    assert.equal(
      master.db.prepare('SELECT 1 FROM push_triggers').get(),
      undefined,
    )
  })

  it('M1 leaves a push to setup when the mirror fails or does not answer in time, never taking it for no Masonfile', async () => {
    const { mirrors, pushes, project } = setup()
    mirrors.throws = true
    const failed = await pushes.schedule(project(), 'a', commit(1))
    assert.equal(failed.status, 'scheduled')
    assert.equal(failed.by, 'setup')
    mirrors.throws = false
    mirrors.hang = true
    const started = Date.now()
    const slow = await pushes.schedule(project(), 'b', commit(2))
    assert.equal(slow.by, 'setup')
    assert.equal(slow.status, 'scheduled')
    assert(Date.now() - started < 5000)
  })

  it('M1 decides a skipped push again once the project looks for its Masonfile elsewhere', async () => {
    const { mirrors, projects, pushes, project } = setup()
    mirrors.commits.set(commit(1), {
      'tools/Masonfile.ts': `export function setup(m) { m.stage('a', { run: a }) }\nexport async function a() {}`,
    })
    assert.deepEqual(await pushes.schedule(project(), 'main', commit(1)), {
      status: 'ignored',
      reason: `${commit(1).slice(0, 12)} has no Masonfile`,
      by: 'none',
    })
    // The same commit is not read again while nothing changed.
    const reads = mirrors.reads
    assert.equal(
      (await pushes.schedule(project(), 'main', commit(1))).by,
      undefined,
    )
    assert.equal(mirrors.reads, reads)
    projects.save(localOperator, 'p', { entrypoint: 'tools/Masonfile.ts' })
    const found = await pushes.schedule(project(), 'main', commit(1))
    assert.equal(found.status, 'scheduled')
    assert.equal(found.by, 'source')
  })

  it('M1 leaves a missing Masonfile to setup where a node could still find it: another case, or through a symlink or submodule', async () => {
    const { mirrors, projects, pushes, project } = setup()
    const masonfile = `export function setup(m) { m.stage('a', { run: a }) }\nexport async function a() {}`
    // A Mac's file system ignores case.
    mirrors.commits.set(commit(1), { 'masonfile.ts': masonfile })
    const lower = await pushes.schedule(project(), 'a', commit(1))
    assert.equal(lower.by, 'setup')
    assert.equal(lower.status, 'scheduled')
    projects.save(localOperator, 'p', { entrypoint: 'ci/Masonfile.ts' })
    // A symlinked directory, or a submodule, on the way.
    mirrors.commits.set(commit(2), { 'real/Masonfile.ts': masonfile })
    mirrors.special.set(commit(2), { ci: '120000' })
    assert.equal((await pushes.schedule(project(), 'b', commit(2))).by, 'setup')
    mirrors.special.set(commit(2), { ci: '160000' })
    assert.equal((await pushes.schedule(project(), 'c', commit(2))).by, 'setup')
    // A directory of another case.
    mirrors.commits.set(commit(3), { 'CI/Masonfile.ts': masonfile })
    assert.equal((await pushes.schedule(project(), 'd', commit(3))).by, 'setup')
    // Truly absent, or a directory that lacks it: no Masonfile.
    mirrors.commits.set(commit(4), { 'ci/other.ts': '', 'README.md': '' })
    assert.equal((await pushes.schedule(project(), 'e', commit(4))).by, 'none')
    mirrors.commits.set(commit(5), { 'README.md': '' })
    assert.equal((await pushes.schedule(project(), 'f', commit(5))).by, 'none')
  })

  it('M1 a Masonfile too large to read here is left to setup', async () => {
    const { mirrors, pushes, project } = setup()
    mirrors.commits.set(commit(1), {
      'Masonfile.ts': `// ${'x'.repeat(300 * 1024)}\nexport function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: [] }] }, () => {}) }`,
    })
    assert.equal(
      (await pushes.schedule(project(), 'main', commit(1))).by,
      'setup',
    )
  })

  it('M1 the cache key follows imports of imports and deleted imports, and is never kept for packages, large files or too many files', async () => {
    const { master, mirrors, pushes, project } = setup()
    const cached = (): unknown =>
      master.db.prepare('SELECT sources FROM push_triggers').get()?.sources
    // Each scheduled run ends at once, so the branch is never busy.
    const schedule = async (n: number): Promise<PushResult> => {
      const result = await pushes.schedule(project(), 'feature/a', commit(n))
      master.db.prepare("UPDATE jobs SET status='failed'").run()
      return result
    }
    const remember = async (at: string): Promise<void> => {
      pushes.remember(project(), 'feature/a', at, graph(['main']))
      await pushes.settled()
    }
    const decide = async (
      n: number,
      files: Record<string, string>,
    ): Promise<PushResult> => {
      mirrors.commits.set(commit(n), files)
      return await schedule(n)
    }
    const base = {
      'Masonfile.ts': computed,
      'ci/b.ts': `import { names } from './names.ts'\nexport const B = names\n`,
      'ci/names.ts': `export const names = ['main']\n`,
    }
    mirrors.commits.set(commit(1), base)
    await remember(commit(1))
    assert.equal(typeof cached(), 'string')
    // Unchanged sources decide from the cache.
    assert.equal((await decide(2, { ...base, 'x.txt': 'x' })).by, 'cache')
    // A changed import of an import does not.
    assert.equal(
      (
        await decide(3, {
          ...base,
          'ci/names.ts': `export const names = ['main', 'feature/**']\n`,
        })
      ).by,
      'setup',
    )
    await remember(commit(1))
    // Nor does a deleted import, which may be reached another way: nothing is kept for it.
    const deleted: Record<string, string> = { ...base }
    delete deleted['ci/names.ts']
    assert.equal((await decide(4, deleted)).by, 'setup')
    await remember(commit(4))
    assert.equal(cached(), undefined)
    await remember(commit(1))
    // A package's code is not in the hashed files: nothing is kept.
    for (const [n, files] of [
      [
        5,
        { ...base, 'ci/b.ts': `import x from 'lodash'\nexport const B = x\n` },
      ],
      [
        6,
        {
          ...base,
          'ci/b.ts': `import x from '#branches'\nexport const B = x\n`,
        },
      ],
      [7, { ...base, 'ci/b.ts': `export const B = require(name)\n` }],
      [8, { ...base, 'ci/names.ts': `// ${'n'.repeat(300 * 1024)}\n` }],
      [9, { ...base, 'ci/b.ts': `import x from '../../outside.ts'\n` }],
    ] as const) {
      mirrors.commits.set(commit(n), files)
      await remember(commit(n))
      assert.equal(cached(), undefined, `commit ${n}`)
      assert.equal((await schedule(n)).by, 'setup')
      await remember(commit(1))
    }
    // Nor for a built-in that reads files, or code that reaches the process.
    for (const [n, b] of [
      [
        10,
        `import { readFileSync } from 'node:fs'\nexport const B = [String(readFileSync('x'))]\n`,
      ],
      [12, `export const B = [process.env.X ?? 'main']\n`],
      [13, `export const B = (await import('./names.ts')).names\n`],
    ] as const) {
      mirrors.commits.set(commit(n), { ...base, 'ci/b.ts': b })
      await remember(commit(n))
      assert.equal(cached(), undefined, `commit ${n}`)
    }
    // A JSON import is hashed like any file.
    mirrors.commits.set(commit(14), {
      ...base,
      'ci/b.ts': `import names from './names.json' with { type: 'json' }\nexport const B = names\n`,
      'ci/names.json': '["main"]',
    })
    await remember(commit(14))
    assert.equal(typeof cached(), 'string')
    // More files than the cap: nothing is kept.
    const chain: Record<string, string> = {
      'Masonfile.ts': computed,
      'ci/b.ts': `import './f0.ts'\nexport const B = ['main']\n`,
    }
    for (let i = 0; i < MAX_SOURCES; i++)
      chain[`ci/f${i}.ts`] = `import './f${i + 1}.ts'\n`
    mirrors.commits.set(commit(11), chain)
    await remember(commit(11))
    assert.equal(cached(), undefined)
  })

  it('M1 the mirror reads only regular files: a symlink or a submodule throws, a path through a symlinked directory is missing', async () => {
    const root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'mirror-'),
    )
    const work = path.join(root, 'work')
    mkdirSync(path.join(work, 'ci'), { recursive: true })
    mkdirSync(path.join(work, 'shared-real'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      }).trim()
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(work, 'ci', 'Masonfile.ts'), 'export const a = 1\n')
    writeFileSync(
      path.join(work, 'shared-real', 'x.ts'),
      'export const x = 1\n',
    )
    symlinkSync('ci/Masonfile.ts', path.join(work, 'Masonfile.ts'))
    symlinkSync('shared-real', path.join(work, 'shared'))
    git('add', '-A')
    git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},vendor`,
    )
    git('commit', '-q', '-m', 'Links')
    const head = git('rev-parse', 'HEAD')
    const mirrors = new Mirrors(path.join(root, 'mirrors'), async () => ({
      url: work,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }))
    const repository = 'https://github.com/a/links'
    await mirrors.ensure('p', repository, { commit: head })
    const read = (file: string): Promise<unknown> =>
      mirrors.file('p', repository, head, file, 1024)
    assert.deepEqual(await read('ci/Masonfile.ts'), {
      blob: git('rev-parse', 'HEAD:ci/Masonfile.ts'),
      text: 'export const a = 1',
    })
    // Over the limit: the blob, not the text.
    assert.deepEqual(
      await mirrors.file('p', repository, head, 'ci/Masonfile.ts', 4),
      {
        blob: git('rev-parse', 'HEAD:ci/Masonfile.ts'),
      },
    )
    await assert.rejects(read('Masonfile.ts'), /not a regular file/)
    await assert.rejects(read('vendor'), /not a regular file/)
    await assert.rejects(read('shared'), /not a regular file/)
    assert.equal(await read('shared/x.ts'), undefined)
    assert.equal(await read('none.ts'), undefined)
    const modes = Object.fromEntries(
      (await mirrors.tree('p', repository, head, ''))!.map((entry) => [
        entry.name,
        entry.mode,
      ]),
    )
    assert.deepEqual(modes, {
      'Masonfile.ts': '120000',
      ci: '040000',
      shared: '120000',
      'shared-real': '040000',
      vendor: '160000',
    })
    assert.deepEqual(await mirrors.tree('p', repository, head, 'ci'), [
      { mode: '100644', name: 'Masonfile.ts' },
    ])
    assert.equal(
      await mirrors.tree('p', repository, head, 'nothing'),
      undefined,
    )
  })

  it('M1 logs a push decided in the background that fails, naming it', async () => {
    const { master, projects, mirrors } = setup()
    const lines: string[] = []
    const pushes = new Pushes({
      master,
      jobs: Object.assign(Object.create(new Jobs(master, projects)) as Jobs, {
        automatic: (): never => {
          throw new Error('The queue is full')
        },
      }),
      mirrors,
      log: (line): void => {
        lines.push(line)
      },
    })
    mirrors.commits.set(commit(1), {
      'Masonfile.ts': `export function setup(m) { m.stage('a', { run: a }) }\nexport async function a() {}`,
    })
    await pushes.later(projects.get('p'), 'main', commit(1))
    assert.deepEqual(lines, [
      `Deciding the push of p main at ${commit(1).slice(0, 12)} failed: The queue is full`,
    ])
  })

  it('M1 the poll decides each push on its own, so one slow repository holds up no other', async () => {
    const master = new MasterDatabase(new DatabaseSync(':memory:'))
    const projects = new Projects(master)
    for (const slug of ['slow', 'quick']) {
      projects.save(localOperator, slug, {
        repository: `https://github.com/a/${slug}`,
      })
      projects.setRules(localOperator, slug, [
        { pattern: 'main', mode: 'automatic' },
      ])
    }
    const called: string[] = []
    let release: () => void = () => undefined
    const poller = new Poller(
      master,
      projects,
      {
        later: async (project): Promise<void> => {
          called.push(project.slug)
          if (project.slug === 'slow')
            await new Promise<void>((resolve) => (release = resolve))
        },
        decided: (): boolean => false,
        cached: (): undefined => undefined,
        latest: (): undefined => undefined,
      },
      async () => new Map([['main', commit(1)]]),
    )
    const polling = poller.poll()
    const deadline = Date.now() + 5000
    while (!called.includes('quick') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(called, ['slow', 'quick'])
    release()
    await polling
  })
})
