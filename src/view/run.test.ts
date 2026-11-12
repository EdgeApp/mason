import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from '../master/database.js'
import {
  layoutGraph,
  stageLabel,
  type Layout,
  type LayoutStage,
  type StageState,
} from './graph.js'
import { ansiLine, lineAt, logHtml, plainLog } from './log.js'
import { graphFromJson, runData } from './run.js'

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
    const approve = layout.bubbles.find((bubble) => bubble.name === 'approve')!
    assert.equal(approve.kind, 'approval')
    assert.equal(approve.status, 'awaiting_approval')
    const notify = layout.bubbles.find((bubble) => bubble.name === 'notify')!
    assert.deepEqual([notify.kind, notify.status], ['post', 'queued'])
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
    const states = Object.fromEntries(
      layout.bubbles.map((bubble) => [bubble.name, bubble.status]),
    )
    assert.deepEqual(
      ['ios', 'android', 'web', 'lint', 'e2e'].map((name) => states[name]),
      ['succeeded', 'running', 'failed', 'skipped', 'queued'],
    )
    const ios = layout.bubbles.find((bubble) => bubble.name === 'ios')!
    assert.deepEqual([ios.node, ios.took], ['buildbox', 60_000])
    // A running stage has taken until now.
    assert.equal(
      layout.bubbles.find((bubble) => bubble.name === 'android')!.took,
      120_000,
    )
    assert.throws(
      () => layoutGraph([stage('a', ['b']), stage('b', ['a'])], []),
      /loop/,
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

  it('U18.7 reads a run for its page: stages by name, steps, artifacts, history, its recorded graph and every workflow, the requester and the build number', () => {
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
          {
            name: 'release',
            params: { rollout: { type: 'number', min: 1, max: 100 } },
            stages: [],
          },
        ],
      }),
      'build',
    )!
    assert.equal(graphFromJson('{', 'build'), undefined)
    assert.equal(graphFromJson(null, 'build'), undefined)
    assert.equal(graphFromJson('{"workflows":[]}', 'build'), undefined)
    // The approval: who decides, its message and parameters.
    assert.deepEqual(graph.approvals, {
      approve: {
        roles: ['manager'],
        message: 'Ship it?',
        params: { notes: { type: 'text' } },
      },
    })
    assert.deepEqual(graph.params.seat!.choices, ['none', '1'])
    // Every workflow the Masonfile declares, for the Request run sheet.
    assert.deepEqual(graph.workflows, [
      {
        name: 'build',
        params: {
          seat: { type: 'choice', choices: ['none', '1'], default: 'none' },
        },
      },
      {
        name: 'release',
        params: { rollout: { type: 'number', min: 1, max: 100 } },
      },
    ])
    const run = runData(db, 'r1', () => graph, {
      repository: () => 'git@github.com:example/phones.git',
      nodeName: () => 'buildbox',
    })!
    assert.equal(
      runData(db, 'none', () => undefined),
      undefined,
    )
    // Setup is not a stage the page shows.
    assert.deepEqual(
      run.stages.map((entry) => [entry.name, entry.status, entry.node ?? null]),
      [
        ['test', 'succeeded', 'buildbox'],
        ['build/ios', 'running', 'buildbox'],
        ['approve', 'awaiting_approval', null],
      ],
    )
    assert.deepEqual(
      run.history.map((entry) => entry.number),
      [7, 6],
    )
    assert.deepEqual(
      run.history[0]!.stages.map((entry) => entry.name),
      ['test', 'build/ios', 'approve'],
    )
    assert.deepEqual(
      run.steps.map((entry) => [
        entry.stage,
        entry.id,
        entry.title,
        entry.logStart,
        entry.logEnd,
      ]),
      [
        ['test', 1, 'npm ci', 0, 6],
        ['test', 2, 'npm test', 6, null],
      ],
    )
    assert.deepEqual(
      run.artifacts.map((artifact) => ({ ...artifact })),
      [{ stage: 'test', name: 'junit', kind: 'data', size: 2000 }],
    )
    assert.deepEqual(
      [run.number, run.trigger, run.requestedBy, run.description, run.params],
      [7, 'push', 'dana', '1.0 (7)', { seat: '1' }],
    )
    assert.equal(run.project.repository, 'git@github.com:example/phones.git')
    assert.equal(run.buildNumber, null)
    // With the build number it reserved.
    const numbered = runData(db, 'r1', () => graph, {
      nodeName: () => 'buildbox',
      buildNumber: (id) => (id === 'r1' ? '26110201' : undefined),
    })!
    assert.equal(numbered.buildNumber, '26110201')
    // A node with no name is left out, never shown by its fingerprint.
    db.prepare(
      "UPDATE job_stages SET worker='mldsa65:0123456789abcdef' WHERE job_id='r1' AND name='test'",
    ).run()
    const unnamed = runData(db, 'r1', () => graph, {
      nodeName: (fingerprint) =>
        fingerprint === 'abc123' ? 'buildbox' : undefined,
    })!
    assert.deepEqual(
      unnamed.stages.map((entry) => entry.node ?? null),
      [null, 'buildbox', null],
    )
    assert.doesNotMatch(JSON.stringify(unnamed), /mldsa65/)
    // A key's requester is shown by the start of its id at most, or as the master names it.
    db.prepare("UPDATE jobs SET actor=? WHERE id='r1'").run(
      'key:830f19b00cf214361f85ac579fa12497',
    )
    const keyed = runData(db, 'r1', () => graph)!
    assert.equal(keyed.actor, 'key:830f19b00cf214361f85ac579fa12497')
    assert.equal(keyed.requestedBy, 'key 830f19')
    assert.equal(
      runData(db, 'r1', () => graph, {
        requester: (label) => `Paul Puey · key "CI" (${label.slice(4, 10)})`,
      })!.requestedBy,
      'Paul Puey · key "CI" (830f19)',
    )
    // The host's cache holds it as the master named it.
    db.exec(
      "ALTER TABLE jobs ADD COLUMN requested_by TEXT; UPDATE jobs SET requested_by='Dana Doe' WHERE id='r1'",
    )
    assert.equal(runData(db, 'r1', () => graph)!.requestedBy, 'Dana Doe')
    // So is the build number the run reserved.
    db.exec(
      "ALTER TABLE jobs ADD COLUMN build_number TEXT; UPDATE jobs SET build_number='26110202' WHERE id='r1'",
    )
    assert.equal(runData(db, 'r1', () => graph)!.buildNumber, '26110202')
    assert.equal(runData(db, 'r0', () => graph)!.buildNumber, null)
  })
})
