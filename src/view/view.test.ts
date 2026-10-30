import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from '../master/database.js'
import {
  action,
  field,
  masonfileView,
  nodesView,
  projectRunsView,
  projectTabs,
  projectView,
  secretsView,
  settingsView,
} from './admin.js'
import { artifactsView } from './artifacts.js'
import {
  bytes,
  dashboardData,
  dashboardView,
  platformChip,
} from './dashboard.js'
import { ago, duration, escape, time } from './html.js'
import { icon, icons } from './icons.js'
import {
  approvalNotifications,
  approvalRolesFromGraph,
  notificationsFor,
} from './notifications.js'
import { search } from './search.js'
import {
  atLeast,
  page,
  railItems,
  shell,
  type Viewer,
  type ViewerRole,
} from './shell.js'
import { stylesheet } from './stylesheet.js'
import {
  colors,
  contrast,
  cssVariables,
  luminance,
  textPairs,
} from './tokens.js'

const NOW = Date.UTC(2026, 9, 21, 12)
const HOUR = 3_600_000
const SECRET = 'whsec-fixture-secret'
const CHANNEL_KEY = 'channel-key-fixture'
const TOKEN = 'stage-token-fixture'

const viewer = (
  role: ViewerRole,
  node: 'master' | 'host' = 'master',
): Viewer => ({
  name: `${role} person`,
  role,
  node,
  signOut:
    '<form method="post" action="/auth/logout"><button>Sign out</button></form>',
})

/** Two projects with app IDs on three platforms, runs on several branches, builds and artifacts. */
function fixture(): DatabaseSync {
  const db = new MasterDatabase(new DatabaseSync(':memory:'), () => NOW).db
  const project = db.prepare(
    "INSERT INTO projects(id,slug,name,repository,format,timeout_seconds,position,default_branch,webhook_secret,created_at) VALUES(?,?,?,?,'pipeline',3600,?,?,?,?)",
  )
  project.run(
    1,
    'phones',
    'Phones',
    'git@github.com:example/phones.git',
    0,
    'main',
    SECRET,
    NOW,
  )
  project.run(
    2,
    'desk',
    'Desk tools',
    'git@github.com:example/desk.git',
    1,
    'master',
    null,
    NOW,
  )
  const app = db.prepare(
    'INSERT INTO apps(id,slug,name,position,enabled) VALUES(?,?,?,?,1)',
  )
  app.run(1, 'app.example.phone', 'Phone', 0)
  app.run(2, 'app.example.watch', 'Watch', 1)
  app.run(3, 'app.example.desk', 'Desk', 2)
  const channel = db.prepare(
    "INSERT INTO channels(id,app_id,platform,channel_key,formats,enabled) VALUES(?,?,?,?,'[]',1)",
  )
  channel.run(1, 1, 'ios', CHANNEL_KEY)
  channel.run(2, 1, 'android', CHANNEL_KEY + '2')
  channel.run(3, 2, 'ios', CHANNEL_KEY + '3')
  channel.run(4, 3, 'macos', CHANNEL_KEY + '4')
  const owns = db.prepare(
    'INSERT INTO project_apps(app_id,project_id) VALUES(?,?)',
  )
  owns.run(1, 1)
  owns.run(2, 1)
  owns.run(3, 2)
  const job = db.prepare(
    "INSERT INTO jobs(id,project_id,workflow,number,branch,commit_sha,trigger,status,created,started,finished,request,token,description) VALUES(?,?,'build',?,?,?,'request',?,?,?,?,'{}',?,?)",
  )
  job.run(
    'run-1',
    1,
    1,
    'main',
    'a'.repeat(40),
    'succeeded',
    NOW - 30 * HOUR,
    NOW - 30 * HOUR,
    NOW - 29 * HOUR,
    `${TOKEN}-1`,
    'Version 1.0 (11)',
  )
  job.run(
    'run-2',
    1,
    2,
    'main',
    'b'.repeat(40),
    'failed',
    NOW - 5 * HOUR,
    NOW - 5 * HOUR,
    NOW - 4 * HOUR,
    `${TOKEN}-2`,
    null,
  )
  job.run(
    'run-3',
    1,
    3,
    'feature/login',
    'c'.repeat(40),
    'running',
    NOW - HOUR,
    NOW - HOUR,
    null,
    `${TOKEN}-3`,
    null,
  )
  job.run(
    'run-4',
    2,
    1,
    'master',
    'd'.repeat(40),
    'awaiting_approval',
    NOW - 2 * HOUR,
    NOW - 2 * HOUR,
    null,
    `${TOKEN}-4`,
    null,
  )
  const stage = db.prepare(
    'INSERT INTO job_stages(job_id,name,position,kind,status,started,finished,token) VALUES(?,?,?,?,?,?,?,?)',
  )
  stage.run(
    'run-1',
    'build',
    0,
    'stage',
    'succeeded',
    NOW - 30 * HOUR,
    NOW - 30 * HOUR + 600_000,
    null,
  )
  stage.run(
    'run-3',
    '@setup',
    0,
    'setup',
    'succeeded',
    NOW - HOUR,
    NOW - HOUR,
    null,
  )
  stage.run(
    'run-3',
    'build',
    1,
    'stage',
    'running',
    NOW - HOUR + 60_000,
    null,
    `${TOKEN}-stage`,
  )
  stage.run('run-3', 'publish', 2, 'stage', 'queued', null, null, null)
  stage.run(
    'run-4',
    'approve',
    0,
    'approval',
    'awaiting_approval',
    NOW - 2 * HOUR,
    null,
    null,
  )
  const build = db.prepare(
    "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields) VALUES(?,?,?,?,?,?,'1.0',?,?,?,?,?,?,?,?,'ready','','pipeline','{}')",
  )
  build.run(
    1,
    1,
    1,
    'ios',
    'main',
    'a'.repeat(40),
    '26102011',
    'app.example.phone',
    'ipa',
    'd1',
    2_000_000,
    'f1',
    NOW - 29 * HOUR,
    NOW + 1000 * HOUR,
  )
  build.run(
    2,
    1,
    2,
    'android',
    'main',
    'a'.repeat(40),
    '26102011',
    'app.example.phone',
    'apk',
    'd2',
    3_000_000,
    'f2',
    NOW - 29 * HOUR,
    NOW + 1000 * HOUR,
  )
  build.run(
    3,
    3,
    4,
    'macos',
    'master',
    'd'.repeat(40),
    '7',
    'app.example.desk',
    'dmg',
    'd3',
    5_000_000,
    'f3',
    NOW - 50 * HOUR,
    NOW + 1000 * HOUR,
  )
  db.prepare(
    "INSERT INTO run_artifacts(job_id,stage,name,kind,size,digest,storage_key,created_at,entry) VALUES('run-1','build','report','report',1000000,'x','storage-key-fixture',?, 'index.html'),('run-1','build','phone-dsyms','file',500000,'y','storage-key-2',?,NULL)",
  ).run(NOW, NOW)
  db.prepare(
    'INSERT INTO run_tests(job_id,stage,attempt,summary) VALUES(\'run-1\',\'build\',1,\'{"passed":12,"failed":1,"skipped":2,"failures":[]}\')',
  ).run()
  return db
}

describe('Design system and views', () => {
  it('U17.1 bundles its fonts with their licences and the assets the pages name', () => {
    for (const file of [
      'fonts/geist-variable.woff2',
      'fonts/jetbrains-mono-variable.woff2',
      'fonts/material-symbols-outlined-subset.woff2',
      'fonts/LICENSE-geist.txt',
      'fonts/LICENSE-jetbrains-mono.txt',
      'fonts/LICENSE-material-symbols.txt',
      'logo/mason-logo-64.png',
      'logo/mason-logo-180.png',
      'logo/favicon.ico',
    ])
      assert(
        readFileSync(new URL(`../../assets/${file}`, import.meta.url)).length >
          0,
        file,
      )
    assert.match(
      readFileSync(
        new URL('../../assets/fonts/LICENSE-geist.txt', import.meta.url),
        'utf8',
      ),
      /SIL Open Font License/,
    )
    // Every resource the stylesheet names is one of Mason's.
    for (const url of stylesheet.match(/url\(([^)]+)\)/g) ?? [])
      assert.match(url, /^url\(\/assets\/fonts\/[a-z-]+\.woff2\)$/)
    assert.doesNotMatch(stylesheet, /https?:|@import/)
    // Icon codepoints are unique and in the private use area.
    const codes = Object.values(icons)
    assert.equal(new Set(codes).size, codes.length)
    assert(codes.every((code) => code >= 0xe000 && code <= 0xf8ff))
    assert.equal(
      icon('search'),
      '<span class="icon" aria-hidden="true">&#xe8b6;</span>',
    )
    assert.equal(
      icon('warning', 'Careful "now"'),
      '<span class="icon" role="img" aria-label="Careful now">&#xf083;</span>'.replace(
        'f083',
        icons.warning.toString(16),
      ),
    )
  })

  it('U17.2 every text and background pair the stylesheet uses meets WCAG AA', () => {
    for (const [text, background, large] of textPairs) {
      const ratio = contrast(colors[text], colors[background])
      assert(
        ratio >= (large === true ? 3 : 4.5),
        `${text} on ${background}: ${ratio.toFixed(2)}`,
      )
    }
    // The design notes' primary would fail as button text; the adjusted one passes.
    assert(contrast('#FFFFFF', '#E05338') < 4.5)
    assert(contrast('#FFFFFF', colors.primary) >= 4.5)
    assert.equal(luminance('#FFFFFF'), 1)
    assert.throws(() => luminance('white'), /#RRGGBB/)
    assert.match(cssVariables(), /--color-primary:#C43D26/)
    for (const token of stylesheet.match(/var\(--color-[a-z-]+\)/g) ?? [])
      assert.match(cssVariables(), new RegExp(token.slice(4, -1) + ':'), token)
  })

  it('U17.3 the rail offers administration only on the master, to the roles that hold it', () => {
    const keys = (who: Viewer): string[] =>
      railItems(who).map((item) => item.key)
    assert.deepEqual(keys(viewer('admin', 'host')), [
      'dashboard',
      'catalog',
      'artifacts',
      'devices',
    ])
    assert.deepEqual(keys(viewer('tester', 'host')), ['catalog', 'devices'])
    assert.deepEqual(keys(viewer('admin')), [
      'dashboard',
      'artifacts',
      'nodes',
      'cloud',
      'people',
      'settings',
      'backups',
    ])
    assert.deepEqual(keys(viewer('developer')), ['dashboard', 'artifacts'])
    assert(atLeast(viewer('manager'), 'developer'))
    assert(!atLeast(viewer('developer'), 'manager'))
    const host = shell({
      title: 'X',
      body: '<p>x</p>',
      viewer: viewer('admin', 'host'),
      active: 'artifacts',
    })
    assert.doesNotMatch(
      host,
      /\/backups|\/cloud|\/people|\/settings|data-mason="/,
    )
    assert.match(host, /<a href="\/artifacts" aria-current="page"/)
    // Testers' pages are phone-first, without the rail.
    const tester = shell({
      title: 'Apps',
      body: '',
      viewer: viewer('tester', 'host'),
    })
    assert.match(tester, /<body class="phone">/)
    assert.doesNotMatch(tester, /class="rail"/)
    const legacy = page(
      'Sign in',
      '<p>hi</p>',
      '<a href="/devices">Devices</a>',
      true,
    )
    assert.match(legacy, /<h1>Sign in<\/h1><p>hi<\/p>/)
    assert.match(legacy, /<nav><a href="\/devices">Devices<\/a><\/nav>/)
    assert.match(legacy, /src="\/assets\/catalog\.js"/)
    assert.doesNotMatch(legacy, /search-dialog|shell\.js/)
    const master = shell({
      title: 'M',
      body: '',
      viewer: viewer('admin'),
      status: { idle: 2, total: 3, healthy: false },
      notifications: [
        { icon: 'warning', text: 'Look <here>', href: '/backups' },
      ],
    })
    assert.match(master, /2 \/ 3 workers idle/)
    assert.match(master, /Cluster degraded/)
    assert.match(master, /<span class="count">1<\/span>/)
    assert.match(master, /<a href="\/backups">Look &lt;here&gt;<\/a>/)
    assert.match(
      shell({ title: 'N', body: '', viewer: viewer('developer') }),
      /Nothing needs you\./,
    )
  })

  it('U17.4 the dashboard: tiles, platform filters, project cards and the side column', () => {
    const db = fixture()
    const all = (): boolean => true
    const data = dashboardData({
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: all,
      nodes: [{ name: 'buildbox', status: 'busy', detail: 'mac' }],
      repositories: new Map([
        [1, { repository: 'git@github.com:example/phones.git', webhook: true }],
      ]),
    })
    assert.deepEqual(
      {
        projects: data.tiles.projects,
        apps: data.tiles.apps,
        rate: data.tiles.successRate,
        finished: data.tiles.finished,
        storage: data.tiles.storage,
      },
      { projects: 2, apps: 3, rate: 0.5, finished: 2, storage: 11_500_000 },
    )
    assert.deepEqual(data.counts, {
      all: 3,
      ios: 2,
      android: 1,
      macos: 1,
      windows: 0,
    })
    const phones = data.projects[0]!
    assert.deepEqual(
      phones.runs.map((run) => [run.branch, run.number, run.status]),
      [
        ['feature/login', 3, 'running'],
        ['main', 2, 'failed'],
      ],
    )
    assert.equal(phones.latest?.commit, 'c'.repeat(40))
    assert.deepEqual(phones.apps[0]!.platforms, ['android', 'ios'])
    assert.deepEqual(phones.apps[0]!.builds, [
      { branch: 'main', buildNumber: '26102011', at: NOW - 29 * HOUR },
    ])
    // A newer variant never displaces its build as the branch's latest.
    db.prepare("UPDATE builds SET run='run-1' WHERE id=2").run()
    db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields,variant,run) VALUES(43,1,2,'android','main',?,'1.0','26102012','app.example.phone','apk','d43',1000,'f43',?,?,'ready','','pipeline','{}','arm64-v8a','run-1')",
    ).run('a'.repeat(40), NOW - HOUR, NOW + HOUR)
    const withVariant = dashboardData({
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: all,
      nodes: [],
      repositories: new Map(),
    })
    assert.deepEqual(withVariant.projects[0]!.apps[0]!.builds, [
      { branch: 'main', buildNumber: '26102011', at: NOW - 29 * HOUR },
    ])
    assert(!withVariant.builds.some((build) => build.id === 43))
    // A run that published only named variants shows as its first by name,
    // as the branch page heads it, not as the one published first.
    db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields,variant,run) VALUES(?,1,2,'android','main',?,'1.0',?,'app.example.phone','apk',?,1000,?,?,?,'ready','','pipeline','{}',?,'run-2')",
    ).run(
      44,
      'b'.repeat(40),
      '26102013',
      'd44',
      'f44',
      NOW - 30 * 60_000,
      NOW + HOUR,
      'macos-arm64',
    )
    db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields,variant,run) VALUES(?,1,2,'android','main',?,'1.0',?,'app.example.phone','apk',?,1000,?,?,?,'ready','','pipeline','{}',?,'run-2')",
    ).run(
      45,
      'b'.repeat(40),
      '26102014',
      'd45',
      'f45',
      NOW - 30 * 60_000,
      NOW + HOUR,
      'linux-x64',
    )
    const onlyVariants = dashboardData({
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: all,
      nodes: [],
      repositories: new Map(),
    })
    assert.deepEqual(onlyVariants.projects[0]!.apps[0]!.builds, [
      { branch: 'main', buildNumber: '26102014', at: NOW - 30 * 60_000 },
    ])
    assert.deepEqual(
      onlyVariants.builds
        .filter((build) => build.id === 44 || build.id === 45)
        .map((build) => build.id),
      [45],
    )
    // Byte order, not locale order: `Zed` leads `arm`, as on the branch page.
    db.prepare('DELETE FROM builds WHERE id IN (44,45)').run()
    const variantRow = db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields,variant,run) VALUES(?,1,2,'android','main',?,'1.0',?,'app.example.phone','apk',?,1000,?,?,?,'ready','','pipeline','{}',?,'run-3')",
    )
    variantRow.run(
      46,
      'c'.repeat(40),
      '26102015',
      'd46',
      'f46',
      NOW - 20 * 60_000,
      NOW + HOUR,
      'arm',
    )
    variantRow.run(
      47,
      'c'.repeat(40),
      '26102016',
      'd47',
      'f47',
      NOW - 20 * 60_000,
      NOW + HOUR,
      'Zed',
    )
    const mixedCase = dashboardData({
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: all,
      nodes: [],
      repositories: new Map(),
    })
    assert.deepEqual(mixedCase.projects[0]!.apps[0]!.builds, [
      { branch: 'main', buildNumber: '26102016', at: NOW - 20 * 60_000 },
    ])
    db.prepare('DELETE FROM builds WHERE id IN (46,47)').run()
    // The running stage shows its progress against its usual duration; setup and approvals are not queue entries.
    assert.deepEqual(
      data.queue.map((entry) => [
        entry.stage,
        entry.status,
        entry.progress != null,
      ]),
      [
        ['build', 'running', true],
        ['publish', 'queued', false],
      ],
    )
    assert.equal(data.builds[0]!.app, 'Phone')
    const html = dashboardView(data, viewer('developer'), NOW)
    assert.match(html, /Projects &amp; apps/)
    assert.match(html, /50\.0%/)
    assert.match(html, /11\.5 MB/)
    assert.match(
      html,
      /<a class="chip" href="\/" aria-current="true">All \(3\)<\/a>/,
    )
    assert.match(html, /href="\/\?platform=macos">macOS \(1\)/)
    assert.doesNotMatch(html, /Windows \(/)
    assert.match(html, /Webhook active/)
    assert.match(html, /buildbox/)
    assert.match(html, /role="progressbar"/)
    // The card opens the project; only its run chips lead elsewhere, to their runs.
    assert.match(
      html,
      /<h2><a class="card-link" href="\/projects\/phones">Phones<\/a><\/h2>/,
    )
    assert.doesNotMatch(html, /meta-link|\/masonfile"|\?project=/)
    assert.match(html, /<a class="run-chip" href="\/runs\/run-\d+"/)
    // A platform filter keeps the projects with an app on it.
    const mac = dashboardData(
      { db, viewer: viewer('developer'), now: NOW, appVisible: all },
      { platform: 'macos' },
    )
    assert.deepEqual(
      mac.projects.map((card) => card.slug),
      ['desk'],
    )
    assert.equal(mac.nodes, undefined)
    assert.doesNotMatch(
      dashboardView(mac, viewer('developer', 'host'), NOW),
      /Worker nodes/,
    )
    const one = dashboardData(
      { db, viewer: viewer('developer'), now: NOW, appVisible: all },
      { project: 'desk', platform: 'ios' },
    )
    assert.deepEqual(one.projects, [])
    assert.match(
      dashboardView(one, viewer('developer'), NOW),
      /No projects match/,
    )
    // A tester sees only the apps and builds shared with them.
    const tester = dashboardData({
      db,
      viewer: viewer('tester'),
      now: NOW,
      appVisible: (id) => id === 3,
    })
    assert.equal(tester.tiles.apps, 1)
    assert.deepEqual(
      tester.builds.map((build) => build.app),
      ['Desk'],
    )
    assert.deepEqual(
      tester.projects.find((card) => card.slug === 'phones')!.apps,
      [],
    )
    const empty = dashboardData({
      db: new MasterDatabase(new DatabaseSync(':memory:'), () => NOW).db,
      viewer: viewer('admin'),
      now: NOW,
      appVisible: all,
    })
    const emptyHtml = dashboardView(empty, viewer('admin'), NOW)
    assert.match(emptyHtml, /No finished runs in 30 days/)
    assert.match(emptyHtml, /Nothing is running\./)
    assert.match(emptyHtml, /No builds yet\./)
    assert.equal(bytes(999), '999 B')
    assert.equal(bytes(2_500_000_000_000_000), '2500.0 TB')
    assert.match(platformChip('linux'), />linux</)
  })

  it('U17.5 search finds projects, app IDs, runs, commits and branches the viewer may see', () => {
    const db = fixture()
    const developer = {
      db,
      viewer: viewer('developer'),
      appVisible: (): boolean => true,
    }
    const find = (query: string): string[] =>
      search(developer, query).map((result) => `${result.kind}:${result.label}`)
    assert.deepEqual(find('phone'), ['project:Phones', 'app:app.example.phone'])
    assert.deepEqual(find('#2'), ['run:phones build #2'])
    // Newest first.
    assert.deepEqual(find('1'), ['run:desk build #1', 'run:phones build #1'])
    assert.deepEqual(find('cccc'), ['commit:cccccccccccc'])
    assert.deepEqual(find('login'), ['branch:feature/login'])
    assert.deepEqual(find('   '), [])
    // LIKE wildcards are matched literally.
    assert.deepEqual(find('%'), [])
    assert.equal(search(developer, 'phone')[0]!.href, '/projects/phones')
    assert.equal(search(developer, 'phone')[1]!.href, '/projects/phones')
    assert.equal(search(developer, '#2')[0]!.href, '/runs/run-2')
    assert.equal(
      search({ ...developer, viewer: viewer('developer', 'host') }, 'watch')[0]!
        .href,
      '/apps/2',
    )
    // A tester finds the app IDs shared with them and their projects, nothing else.
    const tester = {
      db,
      viewer: viewer('tester', 'host'),
      appVisible: (id: number): boolean => id === 3,
    }
    assert.deepEqual(
      search(tester, 'desk').map((result) => [result.kind, result.href]),
      [
        ['project', '/projects/desk'],
        ['app', '/apps/3'],
      ],
    )
    assert.deepEqual(search(tester, 'phone'), [])
    assert.deepEqual(search(tester, '#1'), [])
    assert.deepEqual(search(tester, 'dddd'), [])
    assert.deepEqual(search(tester, 'master'), [])
  })

  it('U17.6 secrets never render, and notifications are only for the viewer’s role', () => {
    const db = fixture()
    const html = [
      dashboardView(
        dashboardData({
          db,
          viewer: viewer('admin'),
          now: NOW,
          appVisible: () => true,
        }),
        viewer('admin'),
        NOW,
      ),
      artifactsView(
        {
          db,
          viewer: viewer('admin'),
          now: NOW,
          appVisible: () => true,
          artifactBase: 'https://builds.example.test',
        },
        {},
      ),
      artifactsView(
        {
          db,
          viewer: viewer('admin'),
          now: NOW,
          appVisible: () => true,
          artifactBase: '',
        },
        { run: 'run-1' },
      ),
      JSON.stringify(
        search({ db, viewer: viewer('admin'), appVisible: () => true }, 'a'),
      ),
    ].join('')
    for (const secret of [SECRET, CHANNEL_KEY, TOKEN, 'storage-key'])
      assert(!html.includes(secret), secret)
    const approvals = (who: Viewer, roles?: ViewerRole[]): string[] =>
      approvalNotifications(db, who, () => roles).map((item) => item.text)
    assert.deepEqual(approvals(viewer('manager')), [
      'desk build #1 (master) waits for your approval at approve',
    ])
    assert.deepEqual(approvals(viewer('developer')), [])
    assert.deepEqual(approvals(viewer('developer'), ['developer']).length, 1)
    // Administrators may decide any approval.
    assert.deepEqual(approvals(viewer('admin'), ['tester']).length, 1)
    const notices = ['This master is not backed up']
    assert.deepEqual(
      notificationsFor(viewer('manager'), [], notices).map((item) => item.text),
      notices,
    )
    assert.deepEqual(notificationsFor(viewer('developer'), [], notices), [])
    assert.deepEqual(notificationsFor(viewer('admin', 'host'), [], notices), [])
    const graph = JSON.stringify({
      workflows: [
        {
          name: 'build',
          stages: [{ name: 'approve', approval: { roles: ['developer'] } }],
        },
      ],
    })
    assert.deepEqual(approvalRolesFromGraph(graph, 'build', 'approve'), [
      'developer',
    ])
    assert.equal(approvalRolesFromGraph(graph, 'build', 'other'), undefined)
    assert.equal(approvalRolesFromGraph(null, 'build', 'approve'), undefined)
    assert.equal(approvalRolesFromGraph('{', 'build', 'approve'), undefined)
  })

  it('shows artifacts by run, with tests, published builds and links to the report viewer', () => {
    const db = fixture()
    const source = {
      db,
      viewer: viewer('developer', 'host'),
      now: NOW,
      appVisible: (): boolean => true,
      artifactBase: '',
    }
    // A variant this run published, and a build another run made of the same commit.
    const variant = db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields,variant,run) VALUES(?,1,2,'android','main',?,'1.0',?,'app.example.phone','apk',?,1000,?,?,?,'ready','','pipeline','{}',?,?)",
    )
    variant.run(
      41,
      'a'.repeat(40),
      '26102013',
      'd41',
      'f41',
      NOW,
      NOW + HOUR,
      'arm64-v8a',
      'run-1',
    )
    variant.run(
      42,
      'a'.repeat(40),
      '26102014',
      'd42',
      'f42',
      NOW,
      NOW + HOUR,
      '',
      'run-other',
    )
    const run = artifactsView(source, { run: 'run-1' })
    assert.match(run, /Phone 1\.0 \(26102013\) arm64-v8a</)
    assert.doesNotMatch(run, /26102014/)
    assert.match(run, /<h1>build #1<\/h1>/)
    assert.match(run, /Version 1\.0 \(11\)/)
    assert.match(run, /12 passed/)
    assert.match(run, /href="\/runs\/run-1\/artifacts\/report\/view"/)
    assert.match(run, /href="\/runs\/run-1\/artifacts\/phone-dsyms"/)
    assert.match(run, /Phone 1\.0 \(26102011\)/)
    assert.match(run, /href="\/apps\/1">Install/)
    const running = artifactsView(source, { run: 'run-3' })
    assert.match(running, /This run saved no artifacts/)
    assert.match(running, /<li>None\.<\/li>/)
    assert.match(artifactsView(source, { run: 'none' }), /Run unavailable/)
    const list = artifactsView(source, { project: 'phones', branch: 'main' })
    assert.match(list, /phones · main/)
    assert.match(list, /2 · 1\.5 MB/)
    assert.match(list, /<td class="mono">26102011, 26102013 · 3 files<\/td>/)
    assert.doesNotMatch(list, /feature\/login/)
    assert.match(artifactsView(source, { project: 'nothing' }), /No runs yet/)
    const master = artifactsView(
      {
        ...source,
        viewer: viewer('developer'),
        artifactBase: 'https://builds.example.test',
      },
      { run: 'run-1' },
    )
    assert.match(
      master,
      /href="https:\/\/builds\.example\.test\/runs\/run-1\/artifacts\/report\/view"/,
    )
    assert.doesNotMatch(master, /Install/)
  })

  it('formats times, durations and text', () => {
    assert.equal(
      escape(`<a href="x">'&`),
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;',
    )
    assert.match(time(NOW), /2026-10-21 12:00 UTC/)
    assert.deepEqual(
      [
        duration(-5),
        duration(59_000),
        duration(125_000),
        duration(2 * HOUR + 60_000),
      ],
      ['0s', '59s', '2m 5s', '2h 1m'],
    )
    assert.deepEqual(
      [
        ago(NOW, NOW),
        ago(NOW - 300_000, NOW),
        ago(NOW - 3 * HOUR, NOW),
        ago(NOW - 50 * HOUR, NOW),
      ],
      ['now', '5m ago', '3h ago', '2d ago'],
    )
  })
})

describe('Nodes page', () => {
  const base = {
    nodes: [],
    types: {},
    pools: [],
    budget: { monthly: 200 },
    canChange: true,
  }
  it('gives the copyable install command from the master’s GitHub release, never the host', () => {
    const page = nodesView({
      ...base,
      host: 'https://builds.example.test',
      release: { repository: 'example/mason', version: '1.2.3' },
    })
    // One line installs Mason and starts the role; no separate sudo command.
    assert.match(
      page,
      /It installs Mason 1\.2\.3, the master’s version, from GitHub, and starts it as a worker service under your account; it asks for your password once\.<\/small><div class="command"><pre class="mono">curl -fsSL https:\/\/github\.com\/example\/mason\/releases\/download\/v1\.2\.3\/install\.sh \| bash -s -- --version 1\.2\.3 worker<\/pre>/,
    )
    assert(!page.includes('--from'))
    assert(!page.includes('builds.example.test/install.sh'))
    assert(!page.includes('sudo mason worker --install'))
    assert.match(nodesView(base), /This master runs no GitHub release of Mason/)
    assert(!nodesView({ ...base, canChange: false }).includes('id="add-node"'))
  })

  it('U2.1 explains the host and the node steps: title above command, Copy right, pairing-key note, address and port', () => {
    const html = nodesView({
      ...base,
      release: { repository: 'example/mason', version: '1.2.3' },
      poolAccounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean' },
      ],
    })
    assert.match(
      html,
      /<h2>.*Host<\/h2><p>A Mason host holds the builds created by the Mason cluster and hosts a web interface for downloading iOS, Android, desktop, and other builds\. If it is internet accessible, it is also the proxy to communicate events back to the Mason master, such as GitHub repository change events\.<\/p>/,
    )
    const nodes = html.slice(html.indexOf('id="add-node"'))
    assert.match(
      nodes,
      /<h2>.*Nodes<\/h2><p>Add a node, which Mason can use for building, signing, and testing apps, or any other pipeline tasks\. Run the following commands to start Mason on a Linux or macOS computer \(Windows coming\)\.<\/p><ol class="howto">/,
    )
    // Each step: its title first, then the command box with Copy beside it.
    assert.match(
      nodes,
      /<li><strong>Install and start Mason as a worker<\/strong><small class="hint">On the new computer\.[^<]*<\/small><div class="command"><pre class="mono">[^<]* worker<\/pre><button type="button" class="secondary copy"[\s\S]*?<\/div><small class="hint">It prints the pairing key\.<\/small><\/li>/,
    )
    assert.match(
      nodes,
      /<li><strong>Pair it here<\/strong><form[^>]*data-path="\/api\/v2\/nodes"[\s\S]*<label for="node-address">Mason node address and port<\/label><input id="node-address" name="address" placeholder="192\.168\.1\.20:9310"[\s\S]*Pair node/,
    )
    // The host's two ways: on DigitalOcean, or by hand with the same steps.
    assert.match(
      html,
      /<details class="action add-host" id="add-host-do"><summary class="button">.*Create a host on DigitalOcean<\/summary>/,
    )
    const byHand = html.slice(html.indexOf('id="add-host-command"'))
    assert.match(
      byHand,
      /<summary class="button">.*Install a host yourself<\/summary>/,
    )
    assert.match(
      byHand,
      /<strong>Install and start Mason as the host<\/strong><small class="hint">On a computer the internet can reach\.[^<]*<\/small><div class="command"><pre class="mono">[^<]* host<\/pre>/,
    )
    assert.match(
      byHand,
      /<strong>Pair it here<\/strong><small class="hint">To put the host behind TLS on port 443, see the README’s public-server command\.<\/small><form[^>]*data-path="\/api\/v2\/nodes"[\s\S]*placeholder="builds\.example\.com:9310"[\s\S]*Pair host/,
    )
  })

  it('U2.3 pool fields say what they mean; DigitalOcean defaults are unchanged', () => {
    const html = nodesView({
      ...base,
      poolAccounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean' },
      ],
    })
    const hint = (id: string, title: string, text: string): RegExp =>
      new RegExp(
        `<div class="field"><label for="new-do-${id}">${title}</label><small class="hint">${text.replace(/[.()]/g, '\\$&')}</small><input id="new-do-${id}"`,
      )
    assert.match(html, hint('name', 'Name', 'The pool’s name on this master.'))
    assert.match(
      html,
      hint('type', 'Node type', 'Type of node as specified in the Masonfile.'),
    )
    assert.match(
      html,
      /id="new-do-type" name="type" value="" required[^>]*placeholder="linux-x86"/,
    )
    assert.match(
      html,
      hint(
        'labels',
        'Labels',
        'Extra labels its machines carry, comma-separated, for stages that ask for them.',
      ),
    )
    assert.match(
      html,
      hint(
        'maxNodes',
        'Max machines',
        'Spin up no more than max machines concurrently.',
      ),
    )
    assert.match(
      html,
      hint(
        'slots',
        'Stages per machine',
        'How many stages one machine runs at the same time.',
      ),
    )
    assert.match(
      html,
      hint(
        'ttlMinutes',
        'Retire after idle minutes',
        'A machine with no stage to run for this many minutes is shut down and deleted.',
      ),
    )
    assert.match(
      html,
      hint(
        'maxHoursPerNode',
        'Retire after hours up',
        'A machine is replaced after this many hours in total, even if it keeps getting work, so none runs forever. Its current stage finishes first.',
      ),
    )
    assert.match(html, /id="new-do-maxHoursPerNode"[^>]*value="24"/)
    assert.match(html, /id="new-do-ttlMinutes"[^>]*value="60"/)
    assert.doesNotMatch(html, /Machines at most|Node type its machines serve/)
  })

  it('U3.6 the Nodes card creates a permanent node on DigitalOcean and lists cloud nodes, also to read-only viewers', () => {
    const cloudNode = {
      name: 'linux-node',
      state: 'ready',
      account: 'do',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      address: '203.0.113.20',
      origin: null,
      error: null,
      version: '1.2.3',
      nodeType: 'linux-x86',
      labels: ['e2e'],
    }
    const html = nodesView({
      ...base,
      poolAccounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean' },
        { id: 'mac', name: 'NoMac', provider: 'nomac' },
      ],
      cloudNodes: [cloudNode],
    })
    const form = html.slice(html.indexOf('id="add-node-do"'))
    assert.match(
      form,
      /<summary class="button">.*Create a node on DigitalOcean<\/summary>/,
    )
    assert.match(form, /only this master reaches it, on its link port/)
    assert.match(
      form,
      /data-path="\/api\/v2\/cloud\/nodes" data-fields="account,name,type,labels,region,size,image"/,
    )
    for (const id of ['name', 'type', 'labels', 'region', 'size', 'image'])
      assert.match(form, new RegExp(`id="node-do-${id}"`))
    assert.doesNotMatch(
      form.slice(0, form.indexOf('</details>')),
      /dns\.|space\./,
    )
    assert.doesNotMatch(html, /id="add-node-mac"/)
    assert.match(
      html,
      /id="cloud-node-linux-node" data-state="ready"[\s\S]*linux-x86 · e2e · sfo3/,
    )
    assert.match(
      html,
      /data-path="\/api\/v2\/cloud\/nodes\/linux-node" data-method="DELETE" data-fields="confirm"/,
    )
    const viewer = nodesView({
      ...base,
      canChange: false,
      cloudNodes: [cloudNode],
    })
    assert.match(viewer, /<h2>.*Cloud nodes<\/h2>.*id="cloud-node-linux-node"/)
    assert.doesNotMatch(viewer, /Remove node|Reconcile/)
  })

  it('U3.3 node and host cards keep Reconcile and a red Remove on one line', () => {
    const html = nodesView({
      ...base,
      host: 'https://builds.example.test',
      cloudNodes: [
        {
          name: 'linux-node',
          state: 'ready',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          address: '203.0.113.20',
          origin: null,
          error: null,
          nodeType: 'linux-x86',
          labels: [],
        },
      ],
      cloudHosts: [
        {
          name: 'h',
          state: 'ready',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          address: '203.0.113.30',
          origin: 'https://builds.example.test',
          error: null,
          space: { bucket: 'mason-h', region: 'sfo3' },
        },
      ],
    })
    for (const [kind, name] of [
      ['nodes', 'linux-node'],
      ['hosts', 'h'],
    ] as const) {
      const row = new RegExp(
        `<div class="actions"><form data-mason="api" data-path="/api/v2/cloud/${kind}/${name}/reconcile"[\\s\\S]*?Reconcile</button>[\\s\\S]*?</form><details class="action"><summary class="button danger-fill">[^<]*<span[^>]*>[^<]*</span> Remove</summary>[\\s\\S]*?<button class="danger-fill">[\\s\\S]*?</details></div>`,
      )
      assert.match(html, row, kind)
    }
    assert.match(html, /Keep the Space and its builds as a storage location/)
  })

  it('U3.1 the Storage card lists every location: where new builds go, files and size, and Delete or Forget for the others', () => {
    const html = nodesView({
      ...base,
      host: 'https://builds.example.test',
      storage: {
        driver: 's3',
        bucket: 'mason-active',
        endpoint: 'https://sfo3.digitaloceanspaces.com',
        locations: [
          {
            id: 'disk',
            kind: 'disk',
            active: false,
            usage: { files: 3, bytes: 2048 },
          },
          {
            id: 'space-mason-active-sfo3',
            kind: 'space',
            active: true,
            bucket: 'mason-active',
            region: 'sfo3',
            origin: 'made',
            bucketOwned: true,
            usage: { files: 7, bytes: 5 * 1024 * 1024 },
          },
          {
            id: 'space-mason-old-nyc3',
            kind: 'space',
            active: false,
            bucket: 'mason-old',
            region: 'nyc3',
            origin: 'host',
            host: 'h1',
            bucketOwned: true,
          },
          {
            id: 'space-theirs-ams3',
            kind: 'space',
            active: false,
            bucket: 'theirs',
            region: 'ams3',
            origin: 'added',
            bucketOwned: false,
            usage: { files: 2, bytes: 10 },
          },
        ],
      },
    })
    const card = html.slice(html.indexOf('id="storage"'))
    const row = (id: string): string => {
      const start = card.indexOf(`<tr data-location="${id}">`)
      return card.slice(start, card.indexOf('</tr>', start))
    }
    assert.match(
      row('disk'),
      /Host’s disk[\s\S]*data-path="\/api\/v2\/storage\/disk"[\s\S]*Use for new builds<\/button>[\s\S]*<td>3<\/td><td>2\.0 KB<\/td><td><\/td>/,
    )
    const active = row('space-mason-active-sfo3')
    assert.match(active, /mason-active<\/span> · sfo3 · made by Mason/)
    assert.match(active, /New builds go here/)
    assert.doesNotMatch(active, /Delete|Forget/)
    const old = row('space-mason-old-nyc3')
    assert.match(old, /made for host h1/)
    assert.match(
      old,
      /data-path="\/api\/v2\/storage\/locations\/space-mason-old-nyc3\/use"/,
    )
    assert.match(old, /<td>—<\/td><td>—<\/td>/)
    assert.match(
      old,
      /Deletes the Space mason-old from DigitalOcean with its key/,
    )
    assert.match(
      old,
      /data-path="\/api\/v2\/storage\/locations\/space-mason-old-nyc3" data-method="DELETE" data-fields="confirm"/,
    )
    assert.match(old, /Type mason-old to delete it/)
    const theirs = row('space-theirs-ams3')
    assert.match(theirs, / Forget<\/summary>/)
    assert.match(
      theirs,
      /the Space and its files stay in DigitalOcean, and its 2 builds and artifacts leave Mason/,
    )
    assert.match(theirs, /Type theirs to forget it/)
  })

  it('U2.2 every disclosure on the page is a button: red to add or use, secondary for Edit, filled red for Remove', () => {
    const html = nodesView({
      ...base,
      host: 'https://builds.example.test',
      storage: { driver: 'disk' },
      poolAccounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean' },
      ],
      pools: [
        {
          name: 'linux-cloud',
          type: 'linux-x86',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          image: 'ubuntu-24-04-x64',
          labels: [],
          maxNodes: 2,
          slots: 1,
          ttlMinutes: 60,
          maxHoursPerNode: 24,
          machines: [],
        },
      ],
      cloudHosts: [
        {
          name: 'h',
          state: 'ready',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          address: '203.0.113.9',
          origin: null,
          error: null,
        },
      ],
    })
    const summaries = [
      ...html.matchAll(
        /<details([^>]*)><summary([^>]*)>([\s\S]*?)<\/summary>/g,
      ),
    ]
    assert(summaries.length >= 5, String(summaries.length))
    for (const [, details, summary, label] of summaries) {
      assert.match(details!, /class="action/)
      if (/Remove/.test(label!))
        assert.equal(summary, ' class="button danger-fill"')
      else if (/Edit/.test(label!))
        assert.equal(summary, ' class="button secondary"')
      else assert.equal(summary, ' class="button"')
    }
    for (const label of [
      'Store builds in a new DigitalOcean Space',
      'Remove',
      'Add an existing Space',
      'Edit',
      'Add a pool on DigitalOcean',
    ])
      assert(
        summaries.some(([, , , text]) => text!.includes(label)),
        label,
      )
  })
})

describe('Form helpers', () => {
  it('action() is a details whose summary is a full button; field() puts the description between title and control', () => {
    assert.equal(
      action('Add', '<p>form</p>', { id: 'a' }),
      '<details class="action" id="a"><summary class="button">Add</summary><div class="action-body"><p>form</p></div></details>',
    )
    assert.match(
      action('Edit', '', { kind: 'secondary', open: true, className: 'x' }),
      /^<details class="action x" open><summary class="button secondary">Edit<\/summary>/,
    )
    assert.equal(
      field('f', 'Max <machines>', '<input id="f">', 'At most & no more'),
      '<div class="field"><label for="f">Max &lt;machines&gt;</label><small class="hint">At most &amp; no more</small><input id="f"></div>',
    )
    assert.equal(
      field('g', 'Name', '<input id="g">'),
      '<div class="field"><label for="g">Name</label><input id="g"></div>',
    )
    // The Apple panel's reveal keeps hiding its button once open.
    assert.match(stylesheet, /details\.reveal\[open\]>summary\{display:none\}/)
    assert.match(stylesheet, /details\.action>summary\{list-style:none\}/)
    // A step keeps its number and stacks: its title above its command, not beside it as other panel list items are.
    assert.match(
      stylesheet,
      /\.panel ol\.howto>li,ol\.howto>li\{display:list-item;/,
    )
  })
})

describe('Settings page', () => {
  const base = {
    apple: { signedIn: false, needsCode: false },
    keys: [],
    canChange: true,
    canCreate: true,
    canRevoke: true,
  }
  it('U5.1 API keys: what they are for, a create form, and each key by its prefix and creation day', () => {
    const created = new Date(2026, 9, 3, 23, 30).getTime()
    const html = settingsView({
      ...base,
      keys: [
        {
          id: 'abcdef0123456789abcdef0123456789',
          name: 'ci',
          role: 'developer',
          createdAt: created,
          revoked: false,
          format: 'v1',
        },
        {
          id: 'b1',
          name: 'old builder',
          role: 'developer',
          createdAt: created,
          revoked: true,
          format: 'builder',
        },
      ],
    })
    const card = html.slice(html.indexOf('id="keys"'))
    assert.match(
      card,
      /<h2>.*API keys<\/h2><p>Create API keys to access Mason from other apps and agents\.<\/p>/,
    )
    assert.match(card, /<summary class="button">.*Create API key<\/summary>/)
    for (const role of ['developer', 'tester', 'manager', 'admin'])
      assert.match(card, new RegExp(`<option value="${role}">`))
    // Keys publish nothing: the upload role and its app scopes are gone.
    assert.doesNotMatch(card, /value="upload"|name="app"/)
    assert.match(card, /data-then="token"/)
    // Done loads the page again (a new query, not only a hash), so the new key is listed.
    assert.match(card, /<a href="\/settings\?key=created#keys">Done<\/a>/)
    assert.match(
      card,
      /cannot show it again\. If it is lost, revoke it and create a new one/,
    )
    assert.match(
      card,
      /<table class="list compact"><thead><tr><th>Name<\/th><th>Role<\/th><th>Created<\/th><th>State<\/th><th>Key<\/th>/,
    )
    assert.match(
      card,
      /<td>2026-10-03<\/td><td>active<\/td><td><button type="button" class="secondary copy icon-only" data-copy="mason_v1_abcde…"/,
    )
    assert.match(card, /<span class="mono">mason_v1_abcde…<\/span>/)
    assert.match(
      card,
      /<td>revoked<\/td><td><small>builder key<\/small><\/td><td><\/td>/,
    )
    assert.doesNotMatch(card, /ago</)
    // Without the right to create keys, no form.
    assert.doesNotMatch(
      settingsView({ ...base, canCreate: false }),
      /Create API key<\/summary>/,
    )
  })

  it('U6.1 GitHub: one form per way in, each with its kind and only its fields; secrets never shown', () => {
    const html = settingsView({
      ...base,
      github: { kind: 'ssh', publicKey: 'ssh-ed25519 AAAA mason-master' },
    })
    const card = html.slice(
      html.indexOf('id="github"'),
      html.indexOf('id="host"'),
    )
    assert.match(card, /Now: an SSH deploy key\./)
    assert.match(
      card,
      /<details class="action" id="github-token-form"><summary class="button">.*Personal access token/,
    )
    assert.match(
      card,
      /data-fields="kind,token"[^>]*>.*<input type="hidden" name="kind" value="token">.*name="token" type="password" data-kind="secret"[^>]* required/,
    )
    assert.match(card, /data-fields="kind,appId,installationId,privateKey"/)
    assert.match(
      card,
      /name="appId" value="" required type="number" min="1" data-kind="number"/,
    )
    assert.match(card, /<details class="action" id="github-ssh-form" open>/)
    assert.match(card, /data-copy="ssh-ed25519 AAAA mason-master"/)
    assert.match(
      card,
      /data-fields="kind,privateKey"[^>]*><input type="hidden" name="kind" value="ssh"><input type="hidden" name="privateKey" data-kind="secret" value="">/,
    )
    assert.match(
      card,
      /Make a new deploy key<\/summary>.*data-fields="kind"[^>]*><input type="hidden" name="kind" value="ssh">/,
    )
    // A stored token is never in the page; its field keeps it when left empty.
    const token = settingsView({ ...base, github: { kind: 'token' } })
    assert.match(
      token,
      /name="token" type="password" data-kind="secret" autocomplete="off" placeholder="Leave empty to keep the stored token"/,
    )
  })

  it('U6.3/U6.4/U6.5 sign-in methods, host, storage and budget as cards; no JSON or build numbers; errors inside the card', () => {
    const html = settingsView({
      ...base,
      host: { origin: 'https://builds.example.test', offlineGraceHours: 72 },
      storage: { driver: 'disk' },
      storageAccounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean' },
      ],
      monthlyBudget: 120,
      signIn: [
        {
          id: 'google',
          type: 'oidc',
          name: 'Google',
          issuer: 'https://accounts.google.com',
          clientId: 'gid',
          enabled: true,
          signingAlgorithm: 'RS256',
        },
        {
          id: 'gh',
          type: 'oauth2',
          name: 'GitHub',
          issuer: 'https://github.com',
          clientId: 'hid',
          enabled: false,
          authorizationEndpoint: 'https://github.com/a',
          tokenEndpoint: 'https://github.com/t',
          userinfoEndpoint: 'https://api.github.com/user',
          scopes: ['read:user'],
          claims: { subject: 'id' },
        },
      ],
    })
    assert.doesNotMatch(
      html,
      /<textarea id="setting-|data-json|buildNumbers|cloudAccounts/,
    )
    const host = html.slice(html.indexOf('id="host"'))
    assert.match(
      host,
      /data-path="\/api\/v2\/settings\/host" data-method="PUT" data-fields="origin,workerOrigin,offlineGraceHours"/,
    )
    assert.match(host, /name="workerOrigin" value="" data-optional/)
    assert.match(
      host,
      /name="offlineGraceHours" value="72" required type="number" min="1" max="720" data-kind="number"/,
    )
    assert.match(
      host,
      /How long the host keeps serving installs while it cannot reach the master\./,
    )
    assert.match(
      html,
      /<section class="panel" id="storage"><h2>.*Storage<\/h2>.*Make a new Space/,
    )
    const signIn = html.slice(
      html.indexOf('id="signIn"'),
      html.indexOf('id="cloud"'),
    )
    assert.match(
      signIn,
      /data-path="\/api\/v2\/settings\/signIn\/methods\/google" data-method="PUT" data-fields="type,enabled,name,issuer,clientId,clientSecret,authentication,signingAlgorithm"/,
    )
    assert.match(
      signIn,
      /data-path="\/api\/v2\/settings\/signIn\/methods\/gh" data-method="PUT" data-fields="type,enabled,name,issuer,clientId,clientSecret,authentication,authorizationEndpoint,tokenEndpoint,userinfoEndpoint,scopes,claims.subject,claims.name,claims.email,claims.emailVerified"/,
    )
    assert.match(signIn, /name="scopes" value="read:user" data-kind="list"/)
    assert.match(
      signIn,
      /id="signin-edit-gh-enabled" name="enabled" type="checkbox" data-kind="checkbox">/,
    )
    assert.match(
      signIn,
      /data-path="\/api\/v2\/settings\/signIn\/methods\/google" data-method="DELETE"/,
    )
    assert.match(
      signIn,
      /<summary class="button">.*Add an OpenID Connect method<\/summary>.*data-path="\/api\/v2\/settings\/signIn\/methods\/\{id\}" data-method="PUT" data-fields="id,create,type,/,
    )
    assert.match(signIn, /Add an OAuth 2 method/)
    assert.doesNotMatch(signIn, /name="clientSecret"[^>]*value="/)
    const cloud = html.slice(html.indexOf('id="cloud"'))
    assert.match(
      cloud,
      /data-path="\/api\/v2\/settings\/cloud\/budget" data-method="PUT" data-fields="monthlyBudget"/,
    )
    assert.match(cloud, /name="monthlyBudget" value="120"/)
    assert.match(cloud, /href="\/nodes".*href="\/cloud"/)
    // Each card's form has the status line a refused save is shown in, before its Save.
    for (const id of ['github', 'host', 'signIn', 'cloud']) {
      const section = html.slice(html.indexOf(`id="${id}"`))
      assert.match(
        section,
        /<button>.*(Save|Add)<\/button><p class="notice" role="status" data-field="status" hidden><\/p><\/form>/,
        id,
      )
    }
    // Without the right to change settings, no cards.
    assert.doesNotMatch(
      settingsView({ ...base, canChange: false }),
      /id="github"/,
    )
  })

  it('U7.1/U7.3 one card per node type with typed fields and what each means; no JSON anywhere on Settings', () => {
    const type = {
      software: {
        xcode: ['26.1', '16.4'],
        xcodeDefault: '26.1',
        allowBeta: false,
        simulators: ['iOS 26.1'],
        commandLineTools: true,
        rosetta: false,
        brew: { formulae: ['jq'], casks: [] },
        apt: [],
        dnf: [],
        docker: false,
        node: '24',
        android: ['platform-tools'],
      },
      settings: {
        noSleep: true,
        devToolsSecurity: false,
        automationMode: false,
      },
      diskThresholdGb: 40,
      androidLicensesAccepted: { by: 'paul', at: Date.UTC(2026, 9, 1) },
    }
    const html = settingsView({ ...base, nodeTypes: { 'macos-arm64': type } })
    const card = html.slice(html.indexOf('id="node-type-macos-arm64"'))
    assert.match(
      card,
      /data-path="\/api\/v2\/settings\/nodeTypes\/macos-arm64" data-method="PUT" data-fields="software\.xcode,software\.xcodeDefault,software\.allowBeta,/,
    )
    assert.match(
      card,
      /name="software\.xcode" value="26\.1, 16\.4" data-kind="list"/,
    )
    assert.match(
      card,
      /name="software\.xcodeDefault" value="26\.1" data-optional/,
    )
    assert.match(
      card,
      /name="software\.commandLineTools" type="checkbox" data-kind="checkbox" checked>/,
    )
    assert.match(card, /name="software\.node" value="24" data-optional/)
    assert.match(card, /name="software\.java" value="" data-optional/)
    assert.match(
      card,
      /name="settings\.noSleep" type="checkbox" data-kind="checkbox" checked>/,
    )
    assert.match(
      card,
      /name="diskThresholdGb" value="40" required type="number" min="0" data-kind="number"/,
    )
    assert.match(
      card,
      /Unused Xcodes and runtimes are removed when free disk falls below this\./,
    )
    assert.match(card, /Android SDK licences accepted by paul on 2026-10-01\./)
    assert.match(
      card,
      /data-path="\/api\/v2\/settings\/nodeTypes\/macos-arm64" data-method="DELETE"/,
    )
    assert.match(
      html,
      /<summary class="button">.*Add a node type<\/summary>.*data-path="\/api\/v2\/settings\/nodeTypes\/\{name\}" data-method="PUT" data-fields="name,create,software\.xcode/,
    )
    assert.doesNotMatch(html, /<textarea id="setting-|data-json/)
    // A type named like the Add form's prefix or id collides with neither.
    const tricky = settingsView({
      ...base,
      nodeTypes: { new: type, add: type },
    })
    const ids = [...tricky.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(
      ids.filter((id, i) => ids.indexOf(id) !== i),
      [],
    )
    assert.match(tricky, /id="type-edit-new-software-node"/)
    assert.match(tricky, /id="add-node-type"/)
  })

  it('U7.1b the Nodes page sums up each node type instead of showing its JSON', () => {
    const html = nodesView({
      nodes: [],
      types: {
        'macos-arm64': {
          software: {
            xcode: ['26.1'],
            node: '24',
            brew: { formulae: ['jq'], casks: [] },
            android: [],
          },
        },
        empty: {},
      },
      pools: [],
      budget: { monthly: 0 },
      canChange: true,
    })
    assert.match(
      html,
      /<span class="mono">macos-arm64<\/span> <small>Xcode 26\.1 · Node 24 · 1 Homebrew package<\/small>/,
    )
    assert.match(
      html,
      /<span class="mono">empty<\/span> <small>Nothing managed yet<\/small>/,
    )
    assert.doesNotMatch(html, /&quot;software&quot;/)
  })
})

describe('Project tabs and the Secrets tab', () => {
  const variants = [
    {
      id: 1,
      name: 'API_TOKEN',
      kind: 'value' as const,
      configs: [],
      text: true,
      masked: true,
      bytes: 9,
    },
    {
      id: 2,
      name: 'API_TOKEN',
      kind: 'value' as const,
      configs: ['develop', 'maestro'],
      text: true,
      masked: false,
      bytes: 9,
    },
    {
      id: 3,
      name: 'config.json',
      kind: 'file' as const,
      configs: [],
      text: true,
      masked: true,
      bytes: 20,
      pathEnv: 'CONFIG_FILE',
      destination: 'config/app.json',
    },
    {
      id: 4,
      name: 'release.jks',
      kind: 'file' as const,
      configs: ['beta'],
      text: false,
      masked: true,
      bytes: 2048,
    },
  ]
  const row = (html: string, id: number): string =>
    html.split(`data-secret-id="${id}"`)[1]!.split('</tr>')[0]!

  it('U18.13 the project pages share four tabs, the current one marked', () => {
    const tabs = projectTabs('my app', 'secrets')
    assert.deepEqual(
      [
        ...tabs.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)</g),
      ].map((match) => [match[1], match[2] != null, match[3]]),
      [
        ['/projects/my%20app', false, 'Overview'],
        ['/projects/my%20app/runs', false, 'Runs and builds'],
        ['/projects/my%20app/masonfile', false, 'Masonfile'],
        ['/projects/my%20app/secrets', true, 'Secrets'],
      ],
    )
    const overview = projectView({
      slug: 'app',
      name: 'App',
      repository: 'https://github.com/a/app',
      defaultBranch: 'master',
      format: 'pipeline',
      apps: [],
      rules: [],
      webhook: false,
      buildNumbers: [],
      canSeed: false,
    })
    assert.match(
      overview,
      /href="\/projects\/app" aria-current="page">Overview/,
    )
    assert.doesNotMatch(overview, /data-secrets|Save secrets/)
    assert.match(
      masonfileView({ slug: 'app', name: 'App', commits: [] }),
      /href="\/projects\/app\/masonfile" aria-current="page">Masonfile/,
    )
    const runs = projectRunsView(
      { slug: 'app', name: 'App' },
      '<table class="list"></table>',
    )
    assert.match(
      runs,
      /href="\/projects\/app\/runs" aria-current="page">Runs and builds/,
    )
    assert.match(
      runs,
      /<section class="panel"><table class="list"><\/table><\/section>/,
    )
    assert.doesNotMatch(runs, /Every branch/)
    assert.match(
      projectRunsView({ slug: 'app', name: 'App', branch: 'beta' }, ''),
      /The latest runs on beta[^]*href="\/projects\/app\/runs"><span[^>]*>[^<]*<\/span> Every branch/,
    )
  })

  it('U18.13 a manager sees the add buttons, Edit or Replace then Delete per row, the editor and the audit', () => {
    const html = secretsView({
      slug: 'app',
      name: 'App',
      format: 'pipeline',
      secrets: variants,
      canChange: true,
      backups: true,
      audit: [
        {
          name: 'API_TOKEN',
          configs: ['develop'],
          action: 'configs changed',
          who: 'Mia Manager',
          address: '10.0.0.5',
          at: Date.UTC(2026, 9, 29, 12),
          detail: 'all → develop',
        },
      ],
    })
    assert.match(
      html,
      /data-secret-add="value"><span[^>]*>[^<]*<\/span>Add secret value/,
    )
    assert.match(
      html,
      /data-secret-add="file"><span[^>]*>[^<]*<\/span>Add secret file/,
    )
    assert.match(html, /ctx\.secret\(name\)/)
    assert.match(html, /await ctx\.writeSecretFile\(name, directory\)/)
    assert.match(html, /data-secrets="\/api\/v2\/projects\/app\/secrets"/)
    // A value: Edit before Delete; in edit, Save before Cancel.
    const value = row(html, 1)
    assert(
      value.indexOf('data-secret-edit') < value.indexOf('data-secret-delete'),
    )
    assert(
      value.indexOf('data-secret-save') < value.indexOf('data-secret-cancel'),
    )
    assert.match(value, /data-secret-value hidden/)
    assert.match(
      value,
      /<button type="button" class="pill" data-secret-pill[^>]*>all</,
    )
    assert.match(row(html, 2), />develop<\/button><button[^>]*>maestro</)
    assert.match(row(html, 2), /not masked/)
    // A text file edits in the editor; a binary file is only replaced.
    assert.match(row(html, 3), /data-kind="file"[^]*data-secret-edit>/)
    assert.match(row(html, 3), /→ \$CONFIG_FILE/)
    assert.match(row(html, 3), /at config\/app\.json/)
    assert.doesNotMatch(row(html, 4), /data-secret-edit>/)
    assert.match(row(html, 4), /data-secret-replace/)
    assert.match(html, /data-secret-editor hidden role="dialog"/)
    assert.match(html, /<input type="file" data-secret-file hidden>/)
    assert.match(html, /data-secret-add-form="value" hidden/)
    assert.match(
      html,
      /<input type="checkbox" data-secret-show> Show the value/,
    )
    assert.match(row(html, 4), /2\.0 KB/)
    assert.match(row(html, 3), /20 B · text/)
    assert.match(html, /data-secret-add-form="file" hidden/)
    assert.match(html, /data-secret-drop/)
    assert.doesNotMatch(html, /name="masked"|name="pathEnv"/)
    assert.match(html, /<td>Mia Manager<\/td>/)
    assert.match(html, /configs changed <small class="hint">all → develop/)
    assert.match(html, /data-at="1793275200000">2026-10-29 12:00:00 UTC</)
    // Script projects add values unmasked and files with a path variable.
    const script = secretsView({
      slug: 's',
      name: 'S',
      format: 'script',
      secrets: [],
      canChange: true,
      backups: true,
      audit: [],
    })
    assert.match(script, /name="masked" checked/)
    assert.match(script, /name="pathEnv"/)
    // A script project's tab: its own help, a path for the name, no configs anywhere.
    assert.match(script, /This is a script project/)
    assert.match(script, /Path in the checkout/)
    assert.doesNotMatch(script, /name="configs"|data-secret-configs-input/)
    assert.match(script, /No secrets yet/)
    assert.match(script, /Nothing yet/)
    // A script project's variant: plain "all", no configs control, and still Edit and Delete.
    const scripted = secretsView({
      slug: 's',
      name: 'S',
      format: 'script',
      secrets: [variants[0]!],
      canChange: true,
      backups: true,
      audit: [],
    })
    const scriptRow = row(scripted, 1)
    assert.match(scriptRow, /<span class="pill">all<\/span>/)
    assert.doesNotMatch(
      scriptRow,
      /data-secret-pill(?!s)|data-secret-configs-input/,
    )
    assert.match(scriptRow, /data-secret-edit/)
    assert.match(scriptRow, /data-secret-delete/)
  })

  it('U18.13 without backups a manager is told to configure them, may not add, and may still view and edit', () => {
    const html = secretsView({
      slug: 'app',
      name: 'App',
      format: 'pipeline',
      secrets: variants,
      canChange: true,
      backups: false,
      audit: [],
    })
    assert.match(html, /Configure backups before changing secrets/)
    assert.match(html, /data-secret-add="value" disabled/)
    assert.doesNotMatch(html, /data-secret-add-form/)
    assert.match(row(html, 1), /data-secret-edit/)
  })

  it('U18.13 a developer sees names and configs only', () => {
    const html = secretsView({
      slug: 'app',
      name: 'App',
      format: 'pipeline',
      secrets: variants,
      canChange: false,
      backups: true,
    })
    assert.match(html, /API_TOKEN/)
    assert.match(html, /<span class="pill">maestro<\/span>/)
    for (const control of [
      'data-secrets',
      'data-secret-add',
      'data-secret-edit',
      'data-secret-replace',
      'data-secret-delete',
      'data-secret-editor',
      'data-secret-value',
      'data-secret-pill ',
      'Audit',
    ])
      assert(!html.includes(control), control)
  })
})
