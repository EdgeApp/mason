import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from '../master/database.js'
import {
  graphSvg,
  layoutGraph,
  stageLabel,
  timeline,
  timelineHtml,
  type Layout,
  type LayoutStage,
  type StageState,
} from './graph.js'
import { ansiLine, lineAt, logHtml, plainLog } from './log.js'
import {
  graphFromJson,
  runBuilds,
  runData,
  runView,
  type RunViewOptions,
} from './run.js'

const at = (layout: Layout, name: string): [number, number] => {
  const bubble = layout.bubbles.find((entry) => entry.name === name)
  assert(bubble != null, name)
  return [bubble.col, bubble.row]
}
const rails = (layout: Layout): string[] =>
  layout.rails.map((rail) => `${rail.from}>${rail.to}`).sort()
const stage = (
  name: string,
  needs: string[] = [],
  extra: Partial<LayoutStage> = {},
): LayoutStage => ({ name, kind: 'stage', needs, ...extra })

describe('Run view', () => {
  it('U18.1 lays sequential stages along one row from Start to End', () => {
    const layout = layoutGraph(
      [stage('test'), stage('build', ['test']), stage('ship', ['build'])],
      [],
    )
    assert.deepEqual(
      ['@start', 'test', 'build', 'ship', '@end'].map((name) =>
        at(layout, name),
      ),
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ],
    )
    assert.deepEqual(
      rails(layout),
      ['@start>test', 'build>ship', 'ship>@end', 'test>build'].sort(),
    )
    assert.equal(layout.rows, 1)
    assert.deepEqual(layoutGraph([], []).rails, [
      { from: '@start', to: '@end' },
    ])
  })

  it('U18.1 forks a parallel group into a row per member and joins it again, Jenkins-style', () => {
    const group = { group: 'build' }
    const layout = layoutGraph(
      [
        stage('test'),
        stage('build/ios', ['test'], group),
        stage('build/android', ['test'], group),
        stage('build/web', ['test'], group),
        stage('deploy', ['build/ios', 'build/android', 'build/web']),
      ],
      [],
    )
    assert.deepEqual(at(layout, 'build/ios'), [2, 0])
    assert.deepEqual(at(layout, 'build/android'), [2, 1])
    assert.deepEqual(at(layout, 'build/web'), [2, 2])
    // The plain group's join is on its top row, the full fork and join.
    assert.deepEqual(at(layout, 'deploy'), [3, 0])
    assert.equal(layout.rows, 3)
    assert.equal(stageLabel('build/android'), 'android')
  })

  it('U18.1 runs a sequence member along its own row, labelled with the member', () => {
    const group = { group: 'build' }
    const layout = layoutGraph(
      [
        stage('build/ios/preTest', [], group),
        stage('build/ios/compile', ['build/ios/preTest'], group),
        stage('build/android/compile', [], group),
        stage('report', ['build/ios/compile', 'build/android/compile']),
      ],
      [],
    )
    assert.deepEqual(at(layout, 'build/ios/preTest'), [1, 0])
    assert.deepEqual(at(layout, 'build/ios/compile'), [2, 0])
    assert.deepEqual(at(layout, 'build/android/compile'), [1, 1])
    const labels = layout.bubbles
      .filter((bubble) => bubble.rowLabel != null)
      .map((bubble) => [bubble.name, bubble.rowLabel])
    assert.deepEqual(labels, [
      ['build/ios/preTest', 'ios'],
      ['build/android/compile', 'android'],
    ])
    assert.match(graphSvg(layout), /<text class="row-label"[^>]*>ios<\/text>/)
  })

  it('U18.1 draws matrices as rows, approvals with a hand and post stages before End', () => {
    const matrix = { group: 'm' }
    const layout = layoutGraph(
      [
        stage('m/a', [], { ...matrix, matrix: { os: 'a' } }),
        stage('m/b', [], { ...matrix, matrix: { os: 'b' } }),
        { name: 'approve', kind: 'approval', needs: ['m/a', 'm/b'] },
      ],
      [stage('notify')],
      new Map([['approve', { status: 'awaiting_approval' }]]),
    )
    assert.deepEqual(at(layout, 'm/a'), [1, 0])
    assert.deepEqual(at(layout, 'm/b'), [1, 1])
    assert.deepEqual(at(layout, 'approve'), [2, 0])
    assert.deepEqual(at(layout, 'notify'), [3, 0])
    assert.deepEqual(at(layout, '@end'), [4, 0])
    assert.deepEqual(
      rails(layout).filter((rail) => rail.includes('notify')),
      ['approve>notify', 'notify>@end'],
    )
    const svg = graphSvg(layout)
    assert.match(svg, /class="bubble approval status-awaiting_approval"/)
    assert.match(svg, /class="glyph"[^>]*>&#x[0-9a-f]+;<\/text>/)
    assert.match(svg, /waiting for approval/)
    assert.match(svg, /class="bubble post status-queued"/)
  })

  it('U18.1 lays a needs graph out by depth: one input continues its row, several funnel only their own rails, the rest run to End', () => {
    const layout = layoutGraph(
      [
        stage('ios'),
        stage('android'),
        stage('web'),
        stage('lint'),
        stage('e2e', ['ios', 'android']),
        stage('deploy', ['web']),
      ],
      [],
      new Map<string, StageState>([
        [
          'ios',
          {
            status: 'succeeded',
            started: 1000,
            finished: 61_000,
            worker: 'buildbox',
          },
        ],
        ['android', { status: 'running', started: 1000 }],
        ['web', { status: 'failed', started: 1000, finished: 5000 }],
        ['lint', { status: 'skipped' }],
      ]),
      121_000,
    )
    assert.deepEqual(
      ['ios', 'android', 'web', 'lint'].map((name) => at(layout, name)),
      [
        [1, 0],
        [1, 1],
        [1, 2],
        [1, 3],
      ],
    )
    // e2e sits between its inputs' rows; deploy continues web's row.
    assert.deepEqual(at(layout, 'e2e'), [2, 1])
    assert.deepEqual(at(layout, 'deploy'), [2, 2])
    assert.deepEqual(
      rails(layout).filter((rail) => rail.endsWith('>e2e')),
      ['android>e2e', 'ios>e2e'],
    )
    assert.deepEqual(
      rails(layout).filter((rail) => rail.endsWith('>@end')),
      ['deploy>@end', 'e2e>@end', 'lint>@end'],
    )
    const e2e = layout.bubbles.find((bubble) => bubble.name === 'e2e')!
    assert.deepEqual(e2e.waitingFor, ['android'])
    assert.deepEqual(e2e.needs, ['ios', 'android'])
    assert.deepEqual(
      layout.bubbles.find((bubble) => bubble.name === 'ios')!.dependents,
      ['e2e'],
    )
    const svg = graphSvg(layout, 'e2e')
    for (const status of [
      'succeeded',
      'running',
      'failed',
      'skipped',
      'queued',
    ])
      assert.match(svg, new RegExp(`status-${status}`))
    assert.match(svg, /class="ring"/)
    assert.match(svg, /e2e · queued · waiting for android/)
    assert.match(svg, /ios · succeeded · on buildbox · 1m 0s/)
    assert.match(svg, /android · running · 2m 0s/)
    assert.match(
      svg,
      /class="bubble stage status-queued selected" data-stage="e2e" data-needs="ios android"/,
    )
    assert.match(svg, /href="\?stage=e2e"/)
    assert.throws(
      () => layoutGraph([stage('a', ['b']), stage('b', ['a'])], []),
      /loop/,
    )
  })

  it('U18.1 places Timeline bars by real time and highlights the critical path', () => {
    const stages = [
      stage('setup'),
      stage('fast', ['setup']),
      stage('slow', ['setup']),
      stage('ship', ['fast', 'slow']),
    ]
    const data = timeline(
      stages,
      new Map<string, StageState>([
        ['setup', { status: 'succeeded', started: 0, finished: 10 }],
        ['fast', { status: 'succeeded', started: 10, finished: 20 }],
        ['slow', { status: 'succeeded', started: 10, finished: 60 }],
        ['ship', { status: 'running', started: 60 }],
      ]),
      100,
    )
    assert.deepEqual(
      data.bars.map((bar) => [bar.name, bar.critical]),
      [
        ['setup', true],
        ['fast', false],
        ['slow', true],
        ['ship', true],
      ],
    )
    assert.deepEqual([data.from, data.to], [0, 100])
    const html = timelineHtml(data)
    assert.match(html, /left:10\.00%;width:50\.00%/)
    assert.match(html, /slow · 50ms|slow · 0s · critical path/)
    assert.match(
      timelineHtml(timeline(stages, new Map(), 5)),
      /No stage has started yet/,
    )
  })

  it('U18.2 renders ANSI colour, bold and underline, escapes the rest, numbers lines and strips escapes for plain text', () => {
    const text =
      '\x1b[31mred\x1b[0m and \x1b[1;4mbold\x1b[22m under\x1b[0m\n<b>&</b> \x1b[92mbright\x1b[39m plain\x1b[2K\nnext \x1b[mreset'
    const html = logHtml(text, 5)
    assert.match(
      html,
      /<span class="line" data-line="5"><span class="ansi-red">red<\/span> and <span class="ansi-bold ansi-underline">bold<\/span><span class="ansi-underline"> under<\/span><\/span>/,
    )
    assert.match(
      html,
      /data-line="6">&lt;b&gt;&amp;&lt;\/b&gt; <span class="ansi-bright-green">bright<\/span> plain<\/span>/,
    )
    assert.match(html, /data-line="7">next reset<\/span>/)
    assert.equal(logHtml(''), '<pre class="log"><code></code></pre>')
    // Lines are blocks; a newline between them would show as a blank line.
    assert.equal(
      logHtml('a\nb'),
      '<pre class="log"><code><span class="line" data-line="1">a</span><span class="line" data-line="2">b</span></code></pre>',
    )
    // A colour carries over to the next line, as in a terminal.
    assert.match(
      logHtml('\x1b[34mone\ntwo\x1b[0m'),
      /data-line="2"><span class="ansi-blue">two<\/span>/,
    )
    assert.equal(
      plainLog(text),
      'red and bold under\n<b>&</b> bright plain\nnext reset',
    )
    assert.equal(ansiLine('\x1b]0;title\x07x').html, 'x')
    assert.equal(lineAt(Buffer.from('a\nb\nc'), 4), 3)
    assert.equal(lineAt(Buffer.from('a\nb'), 99), 2)
  })

  it('U18.7 shows only the selected stage: its details, steps and log; a step shows its own lines; the header shows the whole run', () => {
    const db = new MasterDatabase(new DatabaseSync(':memory:'), () => 0).db
    db.prepare(
      "INSERT INTO projects(id,slug,name,repository,format,timeout_seconds,created_at) VALUES(1,'phones','Phones','git@github.com:example/phones.git','pipeline',3600,0)",
    ).run()
    db.prepare(
      "INSERT INTO jobs(id,project_id,workflow,number,branch,commit_sha,trigger,status,created,started,request,actor,description,params) VALUES('r1',1,'build',7,'main',?,'push','running',1000,2000,'{}','dana','1.0 (7)','{\"seat\":\"1\"}')",
    ).run('a'.repeat(40))
    const add = db.prepare(
      'INSERT INTO job_stages(job_id,name,position,kind,status,worker,started,finished,attempt) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    add.run('r1', '@setup', -1, 'setup', 'succeeded', null, 1000, 1500, 1)
    add.run('r1', 'test', 0, 'stage', 'succeeded', 'abc123', 2000, 62_000, 1)
    add.run('r1', 'build/ios', 1, 'stage', 'running', 'abc123', 62_000, null, 1)
    add.run(
      'r1',
      'approve',
      2,
      'approval',
      'awaiting_approval',
      null,
      null,
      null,
      0,
    )
    db.prepare(
      "INSERT INTO job_steps(job_id,stage,attempt,id,kind,title,status,ms,at,log_start,log_end) VALUES('r1','test',1,1,'exec','npm ci','succeeded',5000,0,0,6),('r1','test',1,2,'exec','npm test','succeeded',9000,0,6,NULL)",
    ).run()
    db.prepare(
      "INSERT INTO run_artifacts(job_id,stage,name,kind,size,digest,storage_key,created_at) VALUES('r1','test','junit','data',2000,'d','k',0)",
    ).run()
    db.prepare(
      "INSERT INTO jobs(id,project_id,workflow,number,branch,trigger,status,created,request) VALUES('r0',1,'build',6,'main','push','failed',500,'{}')",
    ).run()
    const graph = graphFromJson(
      JSON.stringify({
        workflows: [
          {
            name: 'build',
            params: {
              seat: { type: 'choice', choices: ['none', '1'], default: 'none' },
            },
            stages: [
              { name: 'test', kind: 'stage', needs: [] },
              {
                name: 'build/ios',
                kind: 'stage',
                needs: ['test'],
                group: 'build',
              },
              {
                name: 'approve',
                kind: 'approval',
                needs: ['build/ios'],
                approval: {
                  roles: ['manager'],
                  message: 'Ship it?',
                  params: { notes: { type: 'text' } },
                },
              },
            ],
            post: [],
          },
        ],
      }),
      'build',
    )!
    assert.equal(graphFromJson('{', 'build'), undefined)
    assert.equal(graphFromJson(null, 'build'), undefined)
    assert.equal(graphFromJson('{"workflows":[]}', 'build'), undefined)
    const run = runData(db, 'r1', () => graph, {
      repository: () => 'git@github.com:example/phones.git',
      nodeName: () => 'buildbox',
    })!
    assert.equal(
      runData(db, 'none', () => undefined),
      undefined,
    )
    assert.deepEqual(
      run.stages.map((entry) => entry.name),
      ['test', 'build/ios', 'approve'],
    )
    assert.deepEqual(
      run.history.map((entry) => entry.number),
      [7, 6],
    )
    const options = (extra: Partial<RunViewOptions>): RunViewOptions => ({
      tab: 'graph',
      now: 122_000,
      log: { text: 'one\ntwo\n' },
      can: { cancel: true, restart: true, request: true, approve: () => true },
      base: '',
      ...extra,
    })
    const whole = runView(run, options({}))
    assert.match(whole, /<h2>.*Whole run log<\/h2>/)
    assert.match(whole, /data-run="r1" data-live="1"/)
    assert.match(whole, /build #7/)
    assert.match(whole, /Push by dana/)
    assert.match(whole, /1\.0 \(7\)/)
    assert.match(whole, /on <span class="mono">buildbox<\/span>/)
    assert.match(
      whole,
      /<span class="mono">seat<\/span> = <span class="mono">&quot;1&quot;<\/span>/,
    )
    assert.match(whole, /data-path="\/api\/v2\/runs\/r1\/cancel"/)
    assert.match(whole, /name="seat"/)
    assert.match(whole, /href="\/runs\/r0">#6/)
    const selected = runView(run, options({ selected: 'test', logOffset: 8 }))
    assert.match(selected, /data-stage="test" data-status="[a-z_]+"><h2>/)
    assert.match(selected, /npm ci/)
    assert.match(selected, /npm test/)
    assert.doesNotMatch(selected, /Whole run log/)
    assert.match(selected, /junit/)
    assert.match(selected, /data-offset="8"/)
    assert.match(
      selected,
      /href="\/api\/v2\/runs\/r1\/logs\?plain=1&amp;stage=test" download/,
    )
    assert.match(
      selected,
      /<li data-name="test" data-status="succeeded"[^>]*><a href="\?stage=test" aria-current="true"/,
    )
    const step = runView(
      run,
      options({
        selected: 'test',
        step: 2,
        log: { text: 'two\n', first: 2 },
        logSource: '/x',
      }),
    )
    assert.match(step, /Lines of this step/)
    assert.match(step, /data-line="2">two/)
    assert.match(step, /data-offset="-1" data-src="\/x"/)
    assert.match(step, /class="step open"/)
    const approval = runView(run, options({ selected: 'approve' }))
    assert.match(approval, /Ship it\?/)
    assert.match(approval, /data-fields="stage,approve,notes"/)
    assert.match(
      runView(
        run,
        options({
          selected: 'approve',
          can: {
            cancel: false,
            restart: false,
            request: false,
            approve: () => false,
          },
        }),
      ),
      /Waiting for manager to approve/,
    )
    const timelineTab = runView(
      run,
      options({
        tab: 'timeline',
        log: { unavailable: 'Logs are on the master.' },
      }),
    )
    assert.match(timelineTab, /class="timeline"/)
    assert.match(timelineTab, /Logs are on the master\./)
    assert.equal(runBuilds(db, run), '')
  })
})
