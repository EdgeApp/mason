import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Json, ParamSpec, Setup, Stage } from '../../types/mason/index.js'
import { MaskedLog } from '../builder/execution.js'
import { createContext, inside, type StageSnapshot } from './context.js'
import {
  GraphError,
  ParamsError,
  Recorder,
  decide,
  evaluateWhen,
  postRuns,
  runStatus,
  scriptGraph,
  seconds,
  validateGraph,
  validateParams,
  type Graph,
  type GraphStage,
  type ProjectFacts,
  type SetupContext,
} from './graph.js'
import { runSetup, SetupFailed } from './setup.js'
import {
  maskValue,
  runStage,
  secretForms,
  type StageOptions,
  type StepRecord,
} from './stage.js'
import { StepChannel, type Port } from './steps.js'

const root = (): string =>
  mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'pipeline-'),
  )

const context: SetupContext = {
  workflow: 'build',
  branch: 'master',
  commit: 'a'.repeat(40),
  trigger: 'push',
  params: {},
}

function record(
  setup: (m: Setup) => void,
  exports: Record<string, unknown> = {},
  ctx: Partial<SetupContext> = {},
): Graph {
  const recorder = new Recorder({ ...context, ...ctx }, { setup, ...exports })
  setup(recorder.setup())
  return recorder.graph()
}

/** A checkout holding `Masonfile.ts`, with no node_modules anywhere. */
function checkout(source: string): { dir: string; masonfile: string } {
  const dir = root()
  const masonfile = path.join(dir, 'Masonfile.ts')
  writeFileSync(masonfile, source)
  return { dir, masonfile }
}

function memoryLog(): { write: (text: string) => void; text: () => string } {
  let out = ''
  return {
    write: (text): void => {
      out += text
    },
    text: () => out,
  }
}

const project: ProjectFacts = {
  apps: ['app.example.one'],
  secrets: ['API_TOKEN', 'SIGNING_KEY'],
}

describe('pipeline graph', () => {
  it('parses durations', () => {
    assert.equal(seconds('90s'), 90)
    assert.equal(seconds('20m'), 1200)
    assert.equal(seconds('4h'), 14400)
    assert.equal(seconds('2d'), 172800)
    assert.throws(() => seconds('5'), GraphError)
    assert.throws(() => seconds('0s'), GraphError)
    assert.throws(() => seconds('40d'), GraphError)
  })

  it('records sequential, parallel, sequence, approval and post stages with resolved needs', () => {
    const fn = (): void => {}
    const other = (): void => {}
    const graph = record(
      (m) => {
        m.apiVersion(1)
        const test = m.stage('test', {
          on: 'linux',
          run: fn,
          secrets: ['API_TOKEN'],
        })
        const builds = m.parallel('build', {
          ios: [
            { name: 'compile', on: 'mac-xcode', run: fn },
            {
              name: 'sign',
              on: { type: 'mac-xcode', labels: ['apple-signing'] },
              run: other,
            },
          ],
          web: { on: { os: 'linux', arch: 'x64' }, run: fn },
        })
        const ship = m.approval('ship', {
          message: 'Ship?',
          timeout: '1h',
          params: { notes: { type: 'text' } },
        })
        m.stage('upload', {
          needs: [ship],
          on: 'linux',
          run: fn,
          publishes: ['app.example.one'],
        })
        m.stage('lint', { needs: [], on: 'linux', run: fn })
        m.stage('after-test', {
          needs: [test, builds],
          on: 'linux',
          run: fn,
          timeout: '5m',
          activityTimeout: '1m',
        })
        m.post({
          always: { on: 'linux', run: other },
          failure: { on: 'linux', run: fn },
        })
      },
      { fn, other },
    )
    const build = graph.workflows[0]!
    assert.equal(build.name, 'build')
    assert.deepEqual(build.triggers, [{ push: true }, { request: true }])
    const needs = Object.fromEntries(
      build.stages.map((stage) => [stage.name, stage.needs]),
    )
    assert.deepEqual(needs, {
      test: [],
      'build/ios/compile': ['test'],
      'build/ios/sign': ['build/ios/compile'],
      'build/web': ['test'],
      ship: ['build/ios/sign', 'build/web'],
      upload: ['ship'],
      lint: [],
      'after-test': ['test', 'build/ios/sign', 'build/web'],
    })
    const byName = (name: string): GraphStage =>
      build.stages.find((stage) => stage.name === name)!
    assert.equal(byName('build/ios/sign').run, 'other')
    assert.equal(byName('build/web').group, 'build')
    assert.equal(byName('ship').kind, 'approval')
    assert.deepEqual(byName('ship').approval, {
      roles: ['admin', 'manager'],
      message: 'Ship?',
      timeout: 3600,
      params: { notes: { type: 'text' } },
    })
    assert.equal(byName('after-test').timeout, 300)
    assert.equal(byName('after-test').activityTimeout, 60)
    assert.equal(byName('test').timeout, 7200)
    assert.deepEqual(
      build.post.map((stage) => [stage.name, stage.post]),
      [
        ['post/always', 'always'],
        ['post/failure', 'failure'],
      ],
    )
    assert.equal(
      validateGraph(JSON.parse(JSON.stringify(graph)), project).workflows
        .length,
      1,
    )
  })

  it('records workflows, their options and the setup context', () => {
    const fn = (): void => {}
    const seen: unknown[] = []
    const graph = record(
      (m) => {
        m.apiVersion(1)
        seen.push(
          m.currentWorkflow,
          m.branch,
          m.commit,
          m.trigger,
          m.params.track,
        )
        m.workflow('build', { failFast: false, env: { A: '1' } }, (w) => {
          w.stage('one', { on: 'linux', run: fn })
        })
        m.stage('two', { on: 'linux', run: fn, env: { B: '2' } })
        m.workflow(
          'release',
          {
            triggers: [
              { request: true },
              { after: { workflow: 'build', status: 'success' } },
              { schedule: '0 3 * * *', branches: ['master'] },
            ],
            params: {
              track: {
                type: 'choice',
                choices: ['testflight', 'store'],
                default: 'testflight',
              },
            },
            concurrency: { group: 'project', cancelPrevious: true },
            keep: { runs: 10, stashes: 1 },
            timeout: '1h',
          },
          (w) => {
            w.stage('ship', { on: 'master', run: fn })
          },
        )
      },
      { fn },
      { workflow: 'release', params: { track: 'store' } },
    )
    assert.deepEqual(seen, [
      'release',
      'master',
      'a'.repeat(40),
      'push',
      'store',
    ])
    const [build, release] = graph.workflows
    assert.equal(build!.failFast, false)
    assert.deepEqual(build!.env, { A: '1' })
    assert.deepEqual(
      build!.stages.map((stage) => [stage.name, stage.env]),
      [
        ['one', {}],
        ['two', { B: '2' }],
      ],
    )
    assert.deepEqual(release!.concurrency, {
      group: 'project',
      cancelPrevious: true,
    })
    assert.deepEqual(release!.keep, { runs: 10, stashes: 1 })
    assert.equal(release!.timeout, 3600)
    assert.deepEqual(build!.keep, { stashes: 3 })
    assert.deepEqual(build!.concurrency, {
      group: 'branch',
      cancelPrevious: false,
    })
  })

  it('U6.3 refuses graphs setup gets wrong', () => {
    const fn = (): void => {}
    const fails = (
      setup: (m: Setup) => void,
      pattern: RegExp,
      exports: Record<string, unknown> = { fn },
    ): void => {
      assert.throws(
        () => record(setup, exports),
        (error: Error) =>
          error instanceof GraphError && pattern.test(error.message),
      )
    }
    fails((m) => {
      m.stage('x', { on: 'linux', run: fn })
    }, /apiVersion\(1\)/)
    fails((m) => {
      m.apiVersion(2 as 1)
    }, /version 2 is not supported/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn })
      m.stage('x', { on: 'linux', run: fn })
    }, /declared twice/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn })
      m.approval('x')
    }, /declared twice/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('g/a', { on: 'linux', run: fn })
    }, /Invalid stage name g\/a/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: { os: 'beos' as 'linux' }, run: fn })
    }, /unknown OS beos/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: { arch: 'mips' as 'x64' }, run: fn })
    }, /unknown architecture/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn, tools: { cobol: '1' } as never })
    }, /unknown tool cobol/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: () => {} })
    }, /not exported/)
    fails((m) => {
      m.apiVersion(1)
      for (let i = 0; i < 501; i++) m.stage(`s${i}`, { on: 'linux', run: fn })
    }, /at most 500 stages/)
    fails((m) => {
      m.apiVersion(1)
      m.matrix('big', {
        axes: {
          a: Array.from({ length: 20 }, (_, i) => i),
          b: Array.from({ length: 20 }, (_, i) => i),
        },
        on: 'linux',
        run: fn,
      })
    }, /400 combinations/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', {
        on: 'linux',
        run: fn,
        needs: [{ name: 'later', kind: 'stage' }],
      })
    }, /not declared before it/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn, timeout: 'soon' as '1h' })
    }, /Invalid Stage x timeout/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn, retry: 11 })
    }, /retry/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn, workspace: { path: '../up' } })
    }, /cannot contain/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', {
        on: 'linux',
        run: fn,
        apple: { distribution: 'pirate' as 'adHoc' },
      })
    }, /apple distribution/)
    fails((m) => {
      m.apiVersion(1)
      m.workflow('nightly', { triggers: [{ schedule: 'daily' }] }, () => {})
    }, /5-field cron/)
    fails((m) => {
      m.apiVersion(1)
      m.workflow('n', { triggers: [{ bogus: true } as never] }, () => {})
    }, /unknown trigger/)
    fails((m) => {
      m.apiVersion(1)
      m.workflow('n', {}, () => {})
      m.workflow('n', {}, () => {})
    }, /declared twice/)
    fails((m) => {
      m.apiVersion(1)
      m.post({ sometimes: { on: 'linux', run: fn } } as never)
    }, /Unknown post condition/)
    fails((m) => {
      m.apiVersion(1)
      m.approval('ok', { roles: ['king' as 'admin'] })
    }, /unknown role/)
    fails((m) => {
      m.apiVersion(1)
      m.workflow(
        'r',
        { params: { x: { type: 'choice', choices: ['a'], default: 'b' } } },
        () => {},
      )
    }, /must be one of a/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', {
        on: 'linux',
        run: fn,
        when: { weather: 'sunny' } as never,
      })
    }, /unknown when field/)
    fails((m) => {
      m.apiVersion(1)
      m.stage('x', { on: 'linux', run: fn, env: { MASON_APP: 'x' } })
    }, /env must map/)

    const fixed = record(
      (m) => {
        m.apiVersion(1)
        m.stage('a', {
          on: 'linux',
          run: fn,
          secrets: ['API_TOKEN'],
          publishes: ['app.example.one'],
        })
        m.stage('b', { on: 'linux', run: fn })
      },
      { fn },
    )
    const copy = (): Graph => JSON.parse(JSON.stringify(fixed)) as Graph
    const invalid = (
      graph: unknown,
      pattern: RegExp,
      facts = project,
    ): void => {
      assert.throws(
        () => validateGraph(graph, facts),
        (error: Error) =>
          error instanceof GraphError && pattern.test(error.message),
      )
    }
    const cycle = copy()
    cycle.workflows[0]!.stages[0]!.needs = ['b']
    invalid(cycle, /cycle: a → b → a/)
    const secret = copy()
    secret.workflows[0]!.stages[0]!.secrets = ['ROOT_PASSWORD']
    invalid(secret, /secret ROOT_PASSWORD, which the project does not have/)
    const app = copy()
    app.workflows[0]!.stages[0]!.publishes = ['com.someone.else']
    invalid(app, /app ID com.someone.else, which this project does not own/)
    const version = copy()
    version.apiVersion = 3
    invalid(version, /version 3 is not supported/)
    invalid(null, /no graph/)
    const big = copy()
    big.warnings = ['x'.repeat(1024 * 1024)]
    invalid(big, /larger than 1 MiB/)
    const duplicate = copy()
    duplicate.workflows.push(copy().workflows[0]!)
    invalid(duplicate, /Workflow build is declared twice/)
    const unknownType = copy()
    unknownType.workflows[0]!.stages[0]!.on = 'mac-quantum'
    invalid(unknownType, /unknown node type mac-quantum/, {
      ...project,
      nodeTypes: ['linux'],
    })
    const os = copy()
    os.workflows[0]!.stages[0]!.on = { os: 'plan9' as 'linux' }
    invalid(os, /unknown OS/)
    const after = copy()
    after.workflows[0]!.triggers = [{ after: { workflow: 'ghost' } }]
    invalid(after, /after unknown workflow ghost/)
    const twice = copy()
    twice.workflows[0]!.stages[1]!.name = 'a'
    twice.workflows[0]!.stages[1]!.needs = []
    invalid(twice, /Stage a is declared twice/)
  })

  it('U6.6 matches when conditions and skips dependents of stages that did not succeed', () => {
    const facts = {
      branch: 'release/1.2/hotfix',
      trigger: 'push' as const,
      params: { dryRun: false },
    }
    assert.equal(evaluateWhen(undefined, facts), true)
    assert.equal(
      evaluateWhen({ branch: ['master', 'release/**'] }, facts),
      true,
    )
    assert.equal(evaluateWhen({ branch: ['release/*'] }, facts), false)
    assert.equal(evaluateWhen({ notBranch: ['release/**'] }, facts), false)
    assert.equal(evaluateWhen({ trigger: ['schedule'] }, facts), false)
    assert.equal(evaluateWhen({ params: { dryRun: false } }, facts), true)
    assert.equal(evaluateWhen({ params: { dryRun: true } }, facts), false)
    assert.equal(
      evaluateWhen({ changed: ['ios/**'] }, facts),
      true,
      'unknown changes run the stage',
    )
    assert.equal(
      evaluateWhen(
        { changed: ['ios/**'] },
        { ...facts, changed: ['android/a.kt'] },
      ),
      false,
    )
    assert.equal(
      evaluateWhen(
        { changed: ['ios/**'] },
        { ...facts, changed: ['ios/App/a.swift'] },
      ),
      true,
    )

    const stage = (
      name: string,
      needs: string[],
      extra: Partial<GraphStage> = {},
    ): GraphStage => ({
      ...scriptGraph({ timeoutSeconds: 60, script: {} }).workflows[0]!
        .stages[0]!,
      kind: 'stage',
      name,
      needs,
      ...extra,
    })
    const deploy = stage('deploy', ['test', 'build'])
    assert.equal(
      decide(deploy, { test: 'succeeded', build: 'running' }, facts),
      'wait',
    )
    assert.equal(decide(deploy, { test: 'succeeded' }, facts), 'wait')
    assert.equal(
      decide(deploy, { test: 'succeeded', build: 'succeeded' }, facts),
      'run',
    )
    assert.equal(
      decide(deploy, { test: 'succeeded', build: 'unstable' }, facts),
      'run',
    )
    assert.equal(
      decide(
        { ...deploy, requireSuccess: true },
        { test: 'succeeded', build: 'unstable' },
        facts,
      ),
      'skip',
    )
    assert.equal(
      decide(deploy, { test: 'failed', build: 'succeeded' }, facts),
      'skip',
    )
    assert.equal(
      decide(deploy, { test: 'skipped', build: 'succeeded' }, facts),
      'skip',
    )
    assert.equal(
      decide(deploy, { test: 'cancelled', build: 'succeeded' }, facts),
      'skip',
    )
    assert.equal(
      decide(
        { ...deploy, when: { branch: ['master'] } },
        { test: 'succeeded', build: 'succeeded' },
        facts,
      ),
      'skip',
    )
    assert.equal(decide(stage('first', []), {}, facts), 'run')

    assert.equal(runStatus(['succeeded', 'skipped']), 'succeeded')
    assert.equal(runStatus(['succeeded', 'unstable']), 'unstable')
    assert.equal(runStatus(['unstable', 'cancelled']), 'cancelled')
    assert.equal(runStatus(['cancelled', 'failed', 'unstable']), 'failed')
    assert.equal(runStatus(['timed_out', 'interrupted']), 'timed_out')
    assert.equal(
      runStatus(['failed'], [stage('x', [], { continueOnError: true })]),
      'unstable',
    )

    assert.equal(postRuns('always', 'failed', undefined), true)
    assert.equal(postRuns('success', 'succeeded', undefined), true)
    assert.equal(postRuns('success', 'unstable', undefined), false)
    assert.equal(postRuns('unstable', 'unstable', undefined), true)
    assert.equal(postRuns('failure', 'timed_out', undefined), true)
    assert.equal(postRuns('failure', 'cancelled', undefined), false)
    assert.equal(postRuns('aborted', 'cancelled', undefined), true)
    assert.equal(postRuns('fixed', 'succeeded', 'failed'), true)
    assert.equal(postRuns('fixed', 'succeeded', 'succeeded'), false)
    assert.equal(postRuns('fixed', 'succeeded', undefined), false)
    assert.equal(postRuns('regression', 'failed', 'succeeded'), true)
    assert.equal(postRuns('regression', 'cancelled', 'succeeded'), false)
    assert.equal(postRuns('regression', 'failed', 'failed'), false)
  })

  it('U6.7 gives a script project one build stage', () => {
    const graph = scriptGraph({ timeoutSeconds: 1800, script: {} })
    assert.equal(graph.format, 'script')
    assert.deepEqual(
      graph.workflows.map((workflow) => workflow.name),
      ['build'],
    )
    const [stage] = graph.workflows[0]!.stages
    assert.equal(stage!.name, 'build')
    assert.equal(stage!.kind, 'script')
    assert.deepEqual(stage!.on, { os: 'macos' })
    assert.equal(stage!.timeout, 1800)
    assert.deepEqual(
      scriptGraph({ timeoutSeconds: 60, script: { on: 'linux' } }).workflows[0]!
        .stages[0]!.on,
      'linux',
    )
    assert.equal(validateGraph(graph, project), graph)
  })

  it('U6.8 records and validates build-number schemes and warns about dateless per-branch TestFlight numbers', () => {
    async function ship(ctx: Stage): Promise<void> {
      await ctx.apple.testflight({ path: 'a.ipa' })
    }
    const fn = (): void => {}
    const graph = record(
      (m) => {
        m.apiVersion(1)
        m.buildNumber('app.example.one', { scope: 'branch' })
        m.buildNumber('dated', {
          scope: 'branch',
          format: 'YYMMDDCC',
          check: 'apple',
        })
        m.stage('ship', {
          on: 'mac-xcode',
          run: ship,
          publishes: ['app.example.one'],
        })
        m.stage('store', {
          on: 'mac-xcode',
          run: fn,
          buildNumbers: ['app.example.one'],
          apple: { distribution: 'appStore' },
        })
        m.stage('fine', { on: 'mac-xcode', run: ship, buildNumbers: ['dated'] })
      },
      { ship, fn },
    )
    assert.deepEqual(graph.buildNumbers['dated'], {
      scope: 'branch',
      format: 'YYMMDDCC',
      start: 1,
      timeZone: 'UTC',
      check: 'apple',
    })
    assert.deepEqual(graph.buildNumbers['app.example.one'], {
      scope: 'branch',
      format: 'N',
      start: 1,
      timeZone: 'UTC',
    })
    assert.equal(graph.warnings.length, 1)
    assert.match(
      graph.warnings[0]!,
      /app\.example\.one to TestFlight with a per-branch build number that has no date/,
    )
    assert.throws(
      () =>
        record((m) => {
          m.apiVersion(1)
          m.buildNumber('x', { format: 'NN' })
        }),
      /Build number x: A build-number format has exactly one/,
    )
    assert.throws(
      () =>
        record((m) => {
          m.apiVersion(1)
          m.buildNumber('x')
          m.buildNumber('x')
        }),
      /declared twice/,
    )
    assert.throws(
      () =>
        record((m) => {
          m.apiVersion(1)
          m.buildNumber('')
        }),
      /1–160 characters/,
    )
    // A sequence's apps take their numbers from it, each from one sequence only.
    const shared = record((m) => {
      m.apiVersion(1)
      m.buildNumber('app', {
        apps: ['app.example.one', 'app.example.one', 'app.example.two'],
      })
    })
    assert.deepEqual(shared.buildNumbers['app']!.apps, [
      'app.example.one',
      'app.example.two',
    ])
    for (const [apps, error] of [
      ['app.example.one', /apps lists app IDs/],
      [[''], /apps lists app IDs/],
      [[7], /apps lists app IDs/],
    ] as const)
      assert.throws(
        () =>
          record((m) => {
            m.apiVersion(1)
            m.buildNumber('app', { apps: apps as never })
          }),
        error,
      )
    assert.throws(
      () =>
        record((m) => {
          m.apiVersion(1)
          m.buildNumber('a', { apps: ['app.example.one'] })
          m.buildNumber('b', { apps: ['app.example.one'] })
        }),
      /app\.example\.one already takes its numbers from a/,
    )
  })

  it('U6.9 expands a matrix with stable names and checks request parameters', () => {
    const fn = (): void => {}
    const graph = record(
      (m) => {
        m.apiVersion(1)
        const before = m.stage('before', { on: 'linux', run: fn })
        m.matrix('platforms', {
          axes: {
            target: ['ios', 'android', 'cli'],
            config: ['debug', 'release'],
          },
          exclude: [{ target: 'cli', config: 'debug' }],
          on: ({ target }) => (target === 'ios' ? 'mac-xcode' : 'linux'),
          tools: ({ target }) => (target === 'android' ? { java: '21' } : {}),
          needs: [before],
          run: fn,
        })
        m.matrix('tests', {
          axes: { shard: [1, 2] },
          on: 'linux',
          run: fn,
          failFast: false,
        })
      },
      { fn },
    )
    const stages = graph.workflows[0]!.stages
    assert.deepEqual(
      stages.map((stage) => stage.name),
      [
        'before',
        'platforms[target=ios,config=debug]',
        'platforms[target=ios,config=release]',
        'platforms[target=android,config=debug]',
        'platforms[target=android,config=release]',
        'platforms[target=cli,config=release]',
        'tests[shard=1]',
        'tests[shard=2]',
      ],
    )
    const ios = stages[1]!
    assert.equal(ios.on, 'mac-xcode')
    assert.equal(ios.group, 'platforms')
    assert.deepEqual(ios.matrix, { target: 'ios', config: 'debug' })
    assert.deepEqual(ios.needs, ['before'])
    assert.deepEqual(stages[3]!.tools, { java: '21' })
    assert.equal(stages[5]!.on, 'linux')
    assert.deepEqual(
      stages[6]!.needs,
      stages.slice(1, 6).map((stage) => stage.name),
    )
    assert.equal(stages[6]!.failFast, false)
    assert.throws(
      () =>
        record(
          (m) => {
            m.apiVersion(1)
            m.matrix('none', {
              axes: { a: [1] },
              exclude: [{ a: 1 }],
              on: 'linux',
              run: fn,
            })
          },
          { fn },
        ),
      /excludes every combination/,
    )
    assert.throws(
      () =>
        record(
          (m) => {
            m.apiVersion(1)
            m.matrix('empty', { axes: { a: [] }, on: 'linux', run: fn })
          },
          { fn },
        ),
      /non-empty list/,
    )

    const specs = {
      track: {
        type: 'choice',
        choices: ['testflight', 'store'],
        default: 'testflight',
      },
      dryRun: { type: 'boolean', default: true },
      shards: { type: 'number', default: 4, min: 1, max: 16 },
      notes: { type: 'text' },
      tag: {
        type: 'string',
        pattern: '^v\\d+\\.\\d+\\.\\d+$',
        default: 'v1.0.0',
      },
    } satisfies Record<string, ParamSpec>
    assert.deepEqual(validateParams(specs, { notes: 'hi\nthere' }), {
      track: 'testflight',
      dryRun: true,
      shards: 4,
      notes: 'hi\nthere',
      tag: 'v1.0.0',
    })
    const bad = (values: unknown, pattern: RegExp): void => {
      assert.throws(
        () => validateParams(specs, values),
        (error: Error) =>
          error instanceof ParamsError && pattern.test(error.message),
      )
    }
    bad({}, /notes is required/)
    bad({ notes: 'x', track: 'beta' }, /track must be one of testflight, store/)
    bad({ notes: 'x', dryRun: 'yes' }, /dryRun must be true or false/)
    bad({ notes: 'x', shards: 0 }, /at least 1/)
    bad({ notes: 'x', shards: 17 }, /at most 16/)
    bad({ notes: 'x', shards: '4' }, /must be a number/)
    bad({ notes: 'x', tag: '1.0' }, /must match/)
    bad({ notes: 'x', tag: 'v1.0.0\nv2.0.0' }, /one line/)
    bad({ notes: 3 }, /must be text/)
    bad({ notes: 'x', extra: 1 }, /Unknown parameter extra/)
    bad([], /must be an object/)
    assert.deepEqual(validateParams({}, undefined), {})
  })
})

describe('pipeline setup run', function () {
  this.timeout(30000)

  it('U6.1/U6.2 runs setup with no secrets, records the graph to MASON_RESULT_FILE and calls no stage function', async () => {
    const { dir, masonfile } = checkout(`
import type { Setup, Stage } from '@mason/types'
import { writeFileSync } from 'node:fs'

export function setup(m: Setup) {
  m.apiVersion(1)
  const probes: string[] = []
  for (const name of ['secret', 'secretFile', 'sh', 'publish'])
    try { (m as any)[name] } catch (error) { probes.push((error as Error).message) }
  m.stage('env', {
    on: 'linux',
    run: build,
    env: {
      KEYS: Object.keys(process.env).sort().join(','),
      VALUES: Object.values(process.env).join(','),
      PROBES: probes.join('|'),
      WORKFLOW: m.currentWorkflow,
    },
  })
}

export async function build(ctx: Stage) {
  writeFileSync('called', 'yes')
}
`)
    process.env.MASON_TEST_SECRET = 'hunter2-setup'
    const log = memoryLog()
    try {
      const graph = (await runSetup({
        masonfile,
        checkout: dir,
        context: { ...context, workflow: 'nightly' },
        scratch: dir,
        log,
      })) as Graph
      const env = graph.workflows[0]!.stages[0]!.env
      assert(!env.KEYS!.split(',').includes('MASON_TEST_SECRET'))
      assert(
        !env
          .KEYS!.split(',')
          .some(
            (name) =>
              name.startsWith('MASON_') &&
              name !== 'MASON_RESULT_FILE' &&
              name !== 'MASON_SETUP_CONTEXT',
          ),
      )
      assert(!env.VALUES!.includes('hunter2-setup'))
      assert.equal(env.WORKFLOW, 'nightly')
      const probes = env.PROBES!.split('|')
      assert.equal(probes.length, 4)
      for (const probe of probes) assert.match(probe, /is not part of setup/)
      assert.equal(existsSync(path.join(dir, 'called')), false)
      assert.deepEqual(
        validateGraph(graph, project).workflows[0]!.stages.map(
          (stage) => stage.run,
        ),
        ['build'],
      )
    } finally {
      delete process.env.MASON_TEST_SECRET
    }
  })

  it('records every reference example Masonfile', async () => {
    const examples = fileURLToPath(
      new URL('../../test/masonfile-examples/', import.meta.url),
    )
    const shapes: Record<string, string> = {}
    for (const name of [
      'eddy',
      'nightly',
      'release',
      'matrix',
      'teamstation',
    ]) {
      const dir = root()
      copyFileSync(
        path.join(examples, `${name}.masonfile.ts`),
        path.join(dir, 'Masonfile.ts'),
      )
      const graph = (await runSetup({
        masonfile: path.join(dir, 'Masonfile.ts'),
        checkout: dir,
        context,
        scratch: dir,
        log: memoryLog(),
      })) as Graph
      shapes[name] = graph.workflows
        .map(
          (workflow) =>
            `${workflow.name}:${workflow.stages.length}+${workflow.post.length}`,
        )
        .join(' ')
    }
    assert.deepEqual(shapes, {
      eddy: 'build:2+0',
      nightly: 'build:4+0 nightly:1+2',
      release: 'release:3+0',
      matrix: 'build:11+0',
      teamstation: 'build:5+1 release:2+0',
    })
  })

  it('fails setup with its error, on a timeout and on cancel', async () => {
    const run = async (
      source: string,
      extra: { timeoutSeconds?: number; signal?: AbortSignal } = {},
    ): Promise<Error> => {
      const { dir, masonfile } = checkout(source)
      return await runSetup({
        masonfile,
        checkout: dir,
        context,
        scratch: dir,
        log: memoryLog(),
        ...extra,
      }).then(
        () => assert.fail('setup succeeded'),
        (error: Error) => error,
      )
    }
    const missing = await run(`export const x = 1\n`)
    assert(missing instanceof SetupFailed)
    assert.match(missing.message, /does not export a setup function/)
    const graphError = await run(
      `export function setup(m: any) { m.stage('x', { on: 'linux', run: () => {} }) }\n`,
    )
    assert.match(graphError.message, /not exported from the Masonfile/)
    const thrown = await run(
      `export function setup() { throw new Error('boom in setup') }\n`,
    )
    assert.match(thrown.message, /boom in setup/)
    const slow = await run(
      `export async function setup() { await new Promise((r) => setTimeout(r, 60000)) }\n`,
      { timeoutSeconds: 1 },
    )
    assert.equal(slow.message, 'Setup timed out')
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 500)
    const cancelled = await run(
      `export async function setup() { await new Promise((r) => setTimeout(r, 60000)) }\n`,
      { signal: controller.signal },
    )
    assert.equal(cancelled.message, 'Setup cancelled')
  })
})

describe('pipeline step channel', () => {
  function pair(): [StepChannel, StepChannel] {
    const a = new EventEmitter()
    const b = new EventEmitter()
    const port = (self: EventEmitter, other: EventEmitter): Port => ({
      send: (message): boolean => {
        setImmediate(() =>
          other.emit('message', JSON.parse(JSON.stringify(message))),
        )
        return true
      },
      on: (event, listener) => self.on(event, listener),
      off: (event, listener) => self.off(event, listener),
    })
    return [new StepChannel(port(a, b)), new StepChannel(port(b, a))]
  }

  it('carries requests, errors and notices, and rejects pending requests on close', async () => {
    const [runner, worker] = pair()
    worker.handle((method, params) => {
      if (method === 'boom') throw new Error('it broke')
      if (method === 'string') throw 'plain'
      return { method, params }
    })
    assert.deepEqual(await runner.request('echo', { a: 1 }), {
      method: 'echo',
      params: { a: 1 },
    })
    assert.deepEqual(await runner.request('nothing'), {
      method: 'nothing',
      params: null,
    })
    await assert.rejects(runner.request('boom'), /it broke/)
    await assert.rejects(runner.request('string'), /plain/)
    await assert.rejects(
      worker.request('anything'),
      /anything is not available on this node/,
    )
    const seen: unknown[] = []
    worker.onNotice((type, data) => seen.push([type, data]))
    runner.notify('describe', { text: 'x' })
    runner.notify('ready')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, [
      ['describe', { text: 'x' }],
      ['ready', null],
    ])
    worker.handle(async () => await new Promise(() => {}))
    const pending = runner.request('forever')
    runner.close('gone')
    runner.close()
    await assert.rejects(pending, /gone/)
    await assert.rejects(runner.request('after'), /closed/)
    runner.notify('ignored')
  })

  it('closes when the port cannot send', async () => {
    const port: Port = {
      send: () => {
        throw new Error('channel closed')
      },
      on: () => undefined,
      off: () => undefined,
    }
    const channel = new StepChannel(port)
    await assert.rejects(channel.request('x'), /closed/)
  })
})

function snapshot(
  dir: string,
  masonfile: string,
  extra: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    masonfile,
    function: 'main',
    workspace: dir,
    privateDir: path.join(dir, '.private'),
    run: {
      id: 'run-1',
      number: 7,
      workflow: 'build',
      branch: 'master',
      commit: 'a'.repeat(40),
      trigger: 'push',
      params: { dryRun: true },
      url: 'https://example.invalid/runs/run-1',
      changes: [],
    },
    stage: { name: 'main', attempt: 1, matrix: { target: 'ios' } },
    node: {
      name: 'worker-1',
      type: 'linux',
      os: 'linux',
      arch: 'arm64',
      labels: [],
    },
    env: { STAGE_ENV: 'plain' },
    secrets: {},
    files: {},
    buildNumbers: {},
    outputs: {},
    ...extra,
  }
}

async function stage(
  source: string,
  extra: Partial<StageSnapshot> = {},
  options: Partial<StageOptions> = {},
): Promise<{
  result: Awaited<ReturnType<typeof runStage>>
  log: string
  dir: string
  steps: StepRecord[]
  descriptions: string[]
}> {
  const { dir, masonfile } = checkout(source)
  const snap = snapshot(dir, masonfile, extra)
  const logFile = path.join(dir, 'stage.log')
  const log = new MaskedLog(
    logFile,
    secretForms([...Object.values(snap.secrets), ...Object.values(snap.files)]),
  )
  const steps: StepRecord[] = []
  const descriptions: string[] = []
  const result = await runStage({
    snapshot: snap,
    log,
    timeout: 60,
    onStep: (step) => steps.push(step),
    onDescribe: (text) => descriptions.push(text),
    ...options,
  })
  log.write('', true)
  return {
    result,
    log: readFileSync(logFile, 'utf8'),
    dir,
    steps,
    descriptions,
  }
}

describe('pipeline stage run', function () {
  this.timeout(60000)

  it('U6.4/U6.5/U6.7 calls only the named export with declared secrets kept out of the environment and the log', async () => {
    const out = await stage(
      `
import type { Stage } from '@mason/types'
import { writeFileSync } from 'node:fs'

export async function other(ctx: Stage) {
  writeFileSync('other-called', 'yes')
}

export async function main(ctx: Stage) {
  const token = ctx.secret('API_TOKEN')
  const results: Record<string, unknown> = {}
  results.inEnv = Object.values(process.env).includes(token)
  results.childWithout = (await ctx.sh('echo "[$API_TOKEN]"', { quiet: true })).stdout.trim()
  results.childWith = (await ctx.sh('printf %s "$API_TOKEN" | wc -c', { env: { API_TOKEN: token } })).stdout.trim()
  await ctx.sh('echo "token=$T b64=$(printf %s "$T" | base64)"', { env: { T: token } })
  try { ctx.secret('OTHER') } catch (error) { results.undeclared = (error as Error).message }
  try { await ctx.sh('echo failing; exit 3') } catch (error) { results.failed = (error as Error).message }
  try { await ctx.sh('seq 1 100; echo "quiet reason $API_TOKEN" >&2; exit 5', { quiet: true, env: { API_TOKEN: token } }) } catch {}
  results.allowed = (await ctx.sh('exit 4', { allowFailure: true })).code
  results.exec = (await ctx.exec('printf', ['%s-%s', 'a', 'b'])).stdout
  results.input = (await ctx.sh('cat', { input: 'from stdin' })).stdout
  results.cwd = (await ctx.sh('mkdir -p sub && cd sub && pwd')).stdout.trim().endsWith('/sub')
  results.inSub = (await ctx.sh('pwd', { cwd: 'sub' })).stdout.trim().endsWith('/sub')
  results.colour = (await ctx.sh('echo $FORCE_COLOR')).stdout.trim()
  results.noColour = (await ctx.sh('echo "[$FORCE_COLOR]"', { color: false })).stdout.trim()
  results.stageEnv = process.env.STAGE_ENV
  results.file = ctx.secretFile('SIGNING_KEY')
  results.fileAgain = ctx.secretFile('SIGNING_KEY') === results.file
  results.fileMode = (await import('node:fs')).statSync(results.file as string).mode & 0o777
  results.fileContents = (await import('node:fs')).readFileSync(results.file as string, 'utf8') === 'key material'
  try { ctx.secretFile('NOPE') } catch (error) { results.noFile = (error as Error).message }
  results.leak = token
  console.log('printed', token)
  return results
}
`,
      {
        secrets: { API_TOKEN: 's3cr3t-value' },
        files: { SIGNING_KEY: 'key material' },
      },
    )
    assert.equal(out.result.status, 'succeeded', out.log)
    const value = out.result.value as Record<string, Json>
    assert.equal(value.inEnv, false)
    assert.equal(value.childWithout, '[]')
    assert.equal(value.childWith, '12')
    assert.match(String(value.undeclared), /did not declare the secret OTHER/)
    assert.equal(
      value.failed,
      'Command failed with exit code 3: echo failing; exit 3',
    )
    assert.equal(value.allowed, 4)
    assert.equal(value.exec, 'a-b')
    assert.equal(value.input, 'from stdin')
    assert.equal(value.cwd, true)
    assert.equal(value.inSub, true)
    assert.equal(value.colour, '1')
    assert.equal(value.noColour, '[]')
    assert.equal(value.stageEnv, 'plain')
    assert.equal(value.fileAgain, true)
    assert.equal(value.fileMode, 0o600)
    assert.equal(value.fileContents, true)
    assert.match(String(value.noFile), /did not declare the secret file NOPE/)
    assert.equal(value.leak, '[redacted]', 'returned values are masked')
    assert.equal(existsSync(path.join(out.dir, 'other-called')), false)
    assert.equal(
      existsSync(path.join(out.dir, '.private')),
      false,
      'secret files are deleted after the stage',
    )
    assert(!out.log.includes('s3cr3t-value'), out.log)
    assert(
      !out.log.includes(Buffer.from('s3cr3t-value').toString('base64')),
      out.log,
    )
    assert.match(out.log, /token=\[redacted\] b64=\[redacted\]/)
    assert.match(out.log, /printed \[redacted\]/)
    assert.match(out.log, /\$ echo failing; exit 3\nfailing\n/)
    assert.match(
      out.log,
      /\$ echo "\[\$API_TOKEN\]"\n\$ printf/,
      'quiet commands log the command line only',
    )
    // A quiet command that fails shows its last 40 lines, masked.
    assert.match(
      out.log,
      /The quiet command failed; its last lines:\n62\n(?:\d+\n){37}100\nquiet reason \[redacted\]\n/,
    )
    assert(!/^61$/m.test(out.log.split('The quiet command failed')[1]!))
    assert(
      out.steps.some(
        (step) =>
          step.kind === 'sh' &&
          step.status === 'failed' &&
          step.title === 'echo failing; exit 3',
      ),
    )
    assert(
      out.steps.some(
        (step) => step.kind === 'exec' && step.status === 'succeeded',
      ),
    )
  })

  it('U6.4 fails a missing export and a throwing stage with the error in the log', async () => {
    const missing = await stage(`export function other() {}\n`)
    assert.equal(missing.result.status, 'failed')
    assert.match(
      missing.result.reason!,
      /does not export a function named main/,
    )
    const thrown = await stage(
      `export function main() { throw new Error('stage broke') }\n`,
    )
    assert.equal(thrown.result.status, 'failed')
    assert.equal(thrown.result.reason, 'stage broke')
    assert.match(thrown.log, /Error: stage broke\n\s+at main/)
    const large = await stage(
      `export function main() { return 'x'.repeat(70000) }\n`,
    )
    assert.equal(large.result.status, 'failed')
    assert.match(large.result.reason!, /64 KiB/)
    const exited = await stage(`export function main() { process.exit(0) }\n`)
    assert.equal(exited.result.status, 'failed')
    assert.equal(
      exited.result.reason,
      'The stage runner exited without a result',
    )
    const thrownString = await stage(
      `export function main() { throw 'just text' }\n`,
    )
    assert.equal(thrownString.result.reason, 'just text')
    const softly = await stage(
      `export function main() { throw new Error('soft') }\n`,
      {},
      { continueOnError: true },
    )
    assert.equal(softly.result.status, 'unstable')
  })

  it('U6.8 hands out reserved build numbers and the context values', async () => {
    const out = await stage(
      `
import type { Stage } from '@mason/types'
export async function main(ctx: Stage) {
  const first = ctx.getBuildNumber('app.example.one')
  let missing = ''
  try { ctx.getBuildNumber('other') } catch (error) { missing = (error as Error).message }
  let signing = ''
  try { ctx.apple.signing } catch (error) { signing = (error as Error).message }
  ctx.describe('TestFlight 1.4.2 (' + first + ')')
  ctx.log.info('plain line')
  ctx.log.warn('careful')
  ctx.log.error('bad thing')
  const sectioned = await ctx.log.section('Build', async () => 'inside')
  ctx.unstable('3 tests failed')
  return {
    first, again: ctx.getBuildNumber('app.example.one'), missing, signing, sectioned,
    run: ctx.run.number, params: ctx.run.params, stage: ctx.stage, node: ctx.node.name,
    workspace: ctx.workspace === process.cwd(),
    upstream: await ctx.output('test'),
    late: await ctx.output('later'),
  }
}
`,
      {
        buildNumbers: { 'app.example.one': '26101751' },
        outputs: { test: { version: '1.4.2' } },
      },
      { output: (name) => ({ late: name }) },
    )
    assert.equal(out.result.status, 'unstable', out.log)
    assert.equal(out.result.reason, '3 tests failed')
    assert.equal(out.result.description, 'TestFlight 1.4.2 (26101751)')
    assert.deepEqual(out.descriptions, ['TestFlight 1.4.2 (26101751)'])
    const value = out.result.value as Record<string, Json>
    assert.equal(value.first, '26101751')
    assert.equal(value.again, '26101751')
    assert.match(
      String(value.missing),
      /no build number for other; list it in buildNumbers or publishes/,
    )
    assert.match(String(value.signing), /declared no apple signing/)
    assert.equal(value.sectioned, 'inside')
    assert.equal(value.run, 7)
    assert.deepEqual(value.params, { dryRun: true })
    assert.deepEqual(value.stage, {
      name: 'main',
      attempt: 1,
      matrix: { target: 'ios' },
    })
    assert.equal(value.node, 'worker-1')
    assert.equal(value.workspace, true)
    assert.deepEqual(value.upstream, { version: '1.4.2' })
    assert.deepEqual(value.late, { late: 'later' })
    assert.match(
      out.log,
      /plain line\n\u001b\[33mwarning: careful\u001b\[0m\n\u001b\[31merror: bad thing\u001b\[0m\n::group::Build\n::endgroup::\n/,
    )
    assert(
      out.steps.some(
        (step) =>
          step.kind === 'section' &&
          step.title === 'Build' &&
          step.status === 'succeeded',
      ),
    )
  })

  it('passes worker services over the step channel and refuses ones the node lacks', async () => {
    const calls: unknown[] = []
    const out = await stage(
      `
import type { Stage } from '@mason/types'
export async function main(ctx: Stage) {
  await ctx.stash('web', 'dist/**', { exclude: ['*.map'] })
  await ctx.unstash('web')
  await ctx.artifacts.save('coverage', 'coverage/**', { kind: 'report' })
  await ctx.artifacts.fetch({ workflow: 'build', name: 'cli' }, 'out')
  await ctx.tests('junit', 'reports/*.xml')
  await ctx.publish({ app: 'app.example.one', platform: 'ios', path: 'a.ipa' })
  await ctx.cache.restore('k', ['node_modules'])
  await ctx.cache.save('k', ['node_modules'])
  await ctx.checkout({ repository: 'git@github.com:a/b.git', path: 'b' })
  await ctx.git.tag('v1', { push: true })
  await ctx.apple.archive({ scheme: 'App' })
  await ctx.apple.testflight({ path: 'a.ipa' })
  await ctx.apple.notarize({ path: 'a.dmg' })
  let refused = ''
  try { await ctx.stash('refused', 'x') } catch (error) { refused = (error as Error).message }
  return refused
}
`,
      {},
      {
        steps: (method, args) => {
          calls.push([method, args])
          if ((args as unknown[])[0] === 'refused')
            throw new Error('No stash space')
          return null
        },
      },
    )
    assert.equal(out.result.status, 'succeeded', out.log)
    assert.equal(out.result.value, 'No stash space')
    assert.deepEqual(
      calls.map((call) => (call as [string])[0]),
      [
        'stash',
        'unstash',
        'artifacts.save',
        'artifacts.fetch',
        'tests',
        'publish',
        'cache.restore',
        'cache.save',
        'checkout',
        'git.tag',
        'apple.archive',
        'apple.testflight',
        'apple.notarize',
        'stash',
      ],
    )
    assert.deepEqual(calls[0], [
      'stash',
      ['web', 'dist/**', { exclude: ['*.map'] }],
    ])
    const none = await stage(`
import type { Stage } from '@mason/types'
export async function main(ctx: Stage) {
  try { await ctx.publish({ app: 'a', platform: 'ios', path: 'a' }) } catch (error) { return (error as Error).message }
}
`)
    assert.equal(none.result.value, 'publish is not available on this node')
    const noOutput = await stage(`
import type { Stage } from '@mason/types'
export async function main(ctx: Stage) { return await ctx.output('ghost') }
`)
    assert.equal(noOutput.result.status, 'failed')
    assert.equal(noOutput.result.reason, 'Stage ghost has no output')
  })

  it('scopes ctx.fs to the workspace and runs the timing helpers', async () => {
    const out = await stage(`
import type { Stage } from '@mason/types'
export async function main(ctx: Stage) {
  await ctx.fs.write('a/b/c.txt', 'hello')
  await ctx.fs.write('a/d.md', 'x')
  const info = await ctx.fs.stat('a/b/c.txt')
  const dir = await ctx.fs.stat('a')
  const read = await ctx.fs.read('a/b/c.txt')
  const all = await ctx.fs.glob('a/**')
  const text = await ctx.fs.glob(['**/*.txt'])
  let escaped = ''
  try { await ctx.fs.read('../../etc/passwd') } catch (error) { escaped = (error as Error).message }
  let tries = 0
  const retried = await ctx.retry(3, async () => { if (++tries < 3) throw new Error('flaky'); return tries })
  let exhausted = ''
  try { await ctx.retry(2, async () => { throw new Error('always') }) } catch (error) { exhausted = (error as Error).message }
  let timedOut = ''
  try { await ctx.timeout('1s', async (signal) => await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('inner'))))) } catch (error) { timedOut = (error as Error).message }
  const quick = await ctx.timeout('5s', async () => 'fast')
  await ctx.sleep('1s')
  let polls = 0
  await ctx.waitUntil(() => ++polls >= 2, { interval: '1s', timeout: '10s' })
  let never = ''
  try { await ctx.waitUntil(() => false, { interval: '1s', timeout: '1s' }) } catch (error) { never = (error as Error).message }
  let slow = ''
  try { await ctx.sh('sleep 30', { timeout: '1s' }) } catch (error) { slow = (error as Error).message }
  return { size: info.size, isFile: info.isFile, isDir: dir.isDirectory, read, all, text, escaped, retried, exhausted, timedOut, quick, polls, never, slow }
}
`)
    assert.equal(out.result.status, 'succeeded', out.log)
    const value = out.result.value as Record<string, Json>
    assert.equal(value.size, 5)
    assert.equal(value.isFile, true)
    assert.equal(value.isDir, true)
    assert.equal(value.read, 'hello')
    assert.deepEqual(value.all, ['a/b/c.txt', 'a/d.md'])
    assert.deepEqual(value.text, ['a/b/c.txt'])
    assert.match(String(value.escaped), /outside the workspace/)
    assert.equal(value.retried, 3)
    assert.equal(value.exhausted, 'always')
    assert.equal(value.timedOut, 'Timed out after 1s')
    assert.equal(value.quick, 'fast')
    assert.equal(value.polls, 2)
    assert.equal(value.never, 'Condition not met within 1s')
    assert.match(
      String(value.slow),
      /Command failed with exit code 128: sleep 30/,
    )
    assert.match(out.log, /Attempt 1 of 3 failed: flaky/)
    assert.match(out.log, /Command timed out after 1s: sleep 30/)
  })

  it('stops a stage on cancel, timeout and silence, killing what it started', async () => {
    const source = `
import type { Stage } from '@mason/types'
export async function main(ctx: Stage) {
  console.log('started')
  ctx.signal.addEventListener('abort', () => console.log('aborted: ' + (ctx.signal.reason as Error).message))
  await ctx.sh('sleep 30')
}
`
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 1500)
    const cancelled = await stage(source, {}, { signal: controller.signal })
    assert.equal(cancelled.result.status, 'cancelled')
    assert.match(cancelled.log, /The stage was cancelled\./)
    const timed = await stage(source, {}, { timeout: 1 })
    assert.equal(timed.result.status, 'timed_out')
    assert.match(timed.log, /passed its 1 s timeout/)
    const silent = await stage(source, {}, { activityTimeout: 1 })
    assert.equal(silent.result.status, 'timed_out')
    assert.match(silent.log, /No output for 1 s/)
    const early = new AbortController()
    early.abort()
    const before = await stage(
      `export function main() { return 1 }\n`,
      {},
      { signal: early.signal },
    )
    assert.equal(before.result.status, 'cancelled')
    assert.equal(before.result.value, undefined)
  })

  it('U6.7 runs a pipeline Masonfile whose @mason/types import is type-only with no package installed', async () => {
    const out = await stage(`
import type { Stage, Json } from '@mason/types'
type Shape = { ok: boolean }
export async function main(ctx: Stage): Promise<Json> {
  const value: Shape = { ok: true }
  return value
}
`)
    assert.equal(out.result.status, 'succeeded', out.log)
    assert.deepEqual(out.result.value, { ok: true })
    assert.equal(existsSync(path.join(out.dir, 'node_modules')), false)
  })
})

describe('pipeline context helpers', () => {
  it('masks secret forms in values and keeps paths inside the workspace', () => {
    assert.deepEqual(secretForms(['a b', '', 'a b']), ['a b', 'YSBi', 'a%20b'])
    assert.deepEqual(
      maskValue({ 'key a b': ['x a b y', 1, null, true, { z: 'YSBi' }] }, [
        'a b',
      ]),
      {
        'key [redacted]': [
          'x [redacted] y',
          1,
          null,
          true,
          { z: '[redacted]' },
        ],
      },
    )
    const dir = root()
    mkdirSync(path.join(dir, 'in'))
    assert.equal(inside(dir, 'in/new/file'), path.join(dir, 'in/new/file'))
    assert.equal(inside(dir, '.'), dir)
    assert.throws(() => inside(dir, '..'), /outside the workspace/)
    assert.equal(statSync(dir).isDirectory(), true)
  })

  it('refuses a cancelled context', async () => {
    const dir = root()
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const channel = new StepChannel({
      send: (): boolean => true,
      on: (): undefined => undefined,
      off: (): undefined => undefined,
    })
    const ctx = createContext(
      snapshot(dir, path.join(dir, 'M.ts')),
      channel,
      controller.signal,
      {},
    )
    await assert.rejects(ctx.sh('true'), /gone/)
    await assert.rejects(ctx.sleep('1s'), /gone/)
    const plain = new AbortController()
    plain.abort('no reason')
    const other = createContext(
      snapshot(dir, path.join(dir, 'M.ts')),
      channel,
      plain.signal,
      {},
    )
    await assert.rejects(other.sleep('1s'), /Stage cancelled/)
    await assert.rejects(
      other.retry(3, async () => await Promise.reject(new Error('once'))),
      /once/,
    )
  })
})
