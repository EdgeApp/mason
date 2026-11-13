import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from '../master/database.js'
import {
  action,
  cloudView,
  field,
  groupsView,
  groupView,
  nodesView,
  accountView,
  peopleView,
  settingsView,
} from './admin.js'
import {
  artifactRunData,
  artifactsListData,
  projectRunsData,
} from './artifacts.js'
import { bytes, dashboardData } from './dashboard.js'
import {
  ago,
  breadcrumbs,
  duration,
  escape,
  localTime,
  since,
  stamp,
  time,
} from './html.js'
import { crumbTrail } from '../test/crumbs.js'
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
  node: 'master' | 'host' | 'standalone' = 'master',
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
      'catalog',
      'dashboard',
      'artifacts',
      'devices',
    ])
    assert.deepEqual(keys(viewer('tester', 'host')), ['catalog', 'devices'])
    assert.deepEqual(keys(viewer('tester')), ['catalog', 'devices'])
    assert.deepEqual(keys(viewer('developer', 'host')), [
      'catalog',
      'dashboard',
      'artifacts',
      'devices',
    ])
    assert.deepEqual(keys(viewer('admin')), [
      'catalog',
      'dashboard',
      'artifacts',
      'devices',
      'nodes',
      'cloud',
      'people',
      'groups',
      'settings',
      'backups',
    ])
    // The standalone server: Install apps and Devices, and People for its administrators.
    assert.deepEqual(keys(viewer('tester', 'standalone')), [
      'catalog',
      'devices',
    ])
    assert.deepEqual(keys(viewer('admin', 'standalone')), [
      'catalog',
      'devices',
      'people',
    ])
    assert.deepEqual(
      railItems(viewer('admin'))
        .filter((item) => ['catalog', 'dashboard'].includes(item.key))
        .map((item) => [item.href, item.label]),
      [
        ['/apps', 'Install apps'],
        ['/projects', 'Projects & apps'],
      ],
    )
    assert.deepEqual(
      railItems(viewer('manager'))
        .filter((item) => ['people', 'groups'].includes(item.key))
        .map((item) => [item.href, item.icon]),
      [
        ['/people', 'person'],
        ['/groups', 'group'],
      ],
    )
    assert.deepEqual(keys(viewer('developer')), [
      'catalog',
      'dashboard',
      'artifacts',
      'devices',
    ])
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
      /\/backups|\/cloud|\/people|\/groups|\/settings|data-mason="/,
    )
    assert.match(host, /<a href="\/artifacts" aria-current="page"/)
    assert.match(host, /<div class="section">Host<\/div>/)
    // Testers keep the side menu too, with only Install apps and Devices.
    const tester = shell({
      title: 'Apps',
      body: '',
      viewer: viewer('tester', 'host'),
      active: 'catalog',
    })
    assert.match(tester, /<body class="with-rail">/)
    assert.match(tester, /<a href="\/apps" aria-current="page"/)
    assert.deepEqual(
      [...tester.matchAll(/<nav class="rail".*?<\/nav>/g)].map((nav) =>
        [...nav[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
      ),
      [['/apps', '/devices']],
    )
    assert.match(tester, /search-dialog/)
    assert.match(tester, /\/assets\/shell\.js/)
    // The standalone server serves neither search nor notifications.
    const standalone = shell({
      title: 'People',
      body: '',
      viewer: viewer('admin', 'standalone'),
      active: 'people',
      scripts: ['/assets/catalog.js'],
    })
    assert.match(standalone, /<div class="section">Host<\/div>/)
    assert.match(standalone, /<a href="\/people" aria-current="page"/)
    assert.match(standalone, /href="\/account" aria-label="Your account"/)
    assert.match(standalone, /src="\/assets\/catalog\.js"/)
    assert.doesNotMatch(
      standalone,
      /search-dialog|shell\.js|data-search|class="notifications"/,
    )
    // Signed-out pages have no side menu.
    const legacy = page('Sign in', '<p>hi</p>')
    assert.match(legacy, /<body class="phone">/)
    assert.match(legacy, /<h1>Sign in<\/h1><p>hi<\/p>/)
    assert.doesNotMatch(
      legacy,
      /class="rail"|search-dialog|shell\.js|aria-label="Your account"/,
    )
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
      tvos: 0,
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
    // Each build names its run and the run's status.
    assert.deepEqual(withVariant.projects[0]!.apps[0]!.builds, [
      {
        branch: 'main',
        buildNumber: '26102011',
        at: NOW - 29 * HOUR,
        run: 'run-1',
        status: 'succeeded',
      },
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
      {
        branch: 'main',
        buildNumber: '26102014',
        at: NOW - 30 * 60_000,
        run: 'run-2',
        status: 'failed',
      },
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
      {
        branch: 'main',
        buildNumber: '26102016',
        at: NOW - 20 * 60_000,
        run: 'run-3',
        status: 'running',
      },
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
    // The page draws these (src/web/pages/dashboard); the answer carries them.
    assert.equal(data.tiles.successRate, 0.5)
    assert.equal(data.counts.windows, 0)
    assert.deepEqual(data.nodes, [
      { name: 'buildbox', status: 'busy', detail: 'mac' },
    ])
    assert.deepEqual(data.projects[0]!.webhook, true)
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
    assert.deepEqual(mac.filter, { platform: 'macos' })
    const one = dashboardData(
      { db, viewer: viewer('developer'), now: NOW, appVisible: all },
      { project: 'desk', platform: 'ios' },
    )
    assert.deepEqual(one.projects, [])
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
    assert.equal(empty.tiles.finished, 0)
    assert.equal(empty.tiles.successRate, undefined)
    assert.deepEqual([empty.queue, empty.builds, empty.projects], [[], [], []])
    assert.equal(bytes(999), '999 B')
    assert.equal(bytes(2_500_000_000_000_000), '2500.0 TB')
  })

  it('M11 a project card: the header opens the project, each app ID row its page, and each branch’s latest build its run, push branches first, six then +N more', () => {
    const db = fixture()
    // Six more app IDs: Phones has eight.
    for (let n = 1; n <= 6; n++) {
      db.prepare(
        'INSERT INTO apps(id,slug,name,position,enabled) VALUES(?,?,?,?,1)',
      ).run(10 + n, `app.example.extra${n}`, `Extra ${n}`, 10 + n)
      db.prepare('INSERT INTO project_apps(app_id,project_id) VALUES(?,1)').run(
        10 + n,
      )
    }
    // Phone's latest build per branch: nine branches.
    db.prepare("UPDATE builds SET run='run-1' WHERE id=2").run()
    const build = db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields,variant,run) VALUES(?,1,2,'android',?,?,'1.0',?,'app.example.phone','apk',?,1000,?,?,?,'ready','','pipeline','{}','',?)",
    )
    const branches: Array<[string, number, string | null]> = [
      ['feature/login', 1, 'run-3'],
      ['release/2', 2, 'run-2'],
      ['topic/a', 3, 'gone'],
      ['topic/b', 4, 'run-1'],
      ['topic/c', 5, 'run-1'],
      ['topic/d', 6, 'run-1'],
      ['topic/e', 7, 'run-1'],
      ['release/1', 10, null],
    ]
    for (const [index, [branch, hours, run]] of branches.entries())
      build.run(
        60 + index,
        branch,
        'e'.repeat(40),
        `2610${60 + index}`,
        `d${60 + index}`,
        `f${60 + index}`,
        NOW - hours * HOUR,
        NOW + HOUR,
        run,
      )
    const data = dashboardData({
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: () => true,
      pinned: new Map([[1, ['main', 'release/*']]]),
    })
    const phones = data.projects.find((card) => card.slug === 'phones')!
    const phone = phones.apps.find((app) => app.slug === 'app.example.phone')!
    // The push branches first, in the trigger's order, then the newest.
    assert.deepEqual(
      phone.builds.map((entry) => [entry.branch, entry.run, entry.status]),
      [
        ['main', 'run-1', 'succeeded'],
        ['release/2', 'run-2', 'failed'],
        ['release/1', undefined, undefined],
        ['feature/login', 'run-3', 'running'],
        ['topic/a', 'gone', undefined],
        ['topic/b', 'run-1', 'succeeded'],
        ['topic/c', 'run-1', 'succeeded'],
        ['topic/d', 'run-1', 'succeeded'],
        ['topic/e', 'run-1', 'succeeded'],
      ],
    )
    // Without push branches, newest first.
    assert.deepEqual(
      dashboardData({
        db,
        viewer: viewer('developer'),
        now: NOW,
        appVisible: () => true,
      })
        .projects[0]!.apps[0]!.builds.slice(0, 3)
        .map((entry) => entry.branch),
      ['feature/login', 'release/2', 'topic/a'],
    )
    // Each build names its run (when it is known) for its chip to open.
    assert.deepEqual(
      phones.apps.map((app) => app.slug),
      [
        'app.example.phone',
        'app.example.watch',
        ...[1, 2, 3, 4, 5, 6].map((n) => `app.example.extra${n}`),
      ],
    )
    assert.equal(phone.branches, 9)
    assert.deepEqual(
      phones.apps.find((app) => app.slug === 'app.example.watch')!.builds,
      [],
    )
    // An app built on very many branches: the card reads only the newest
    // hundred, and its +N still counts them all (review 1.harness-review.7).
    const many = db.prepare(
      "INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields) VALUES(?,1,2,'android',?,'c','1.0','1','app.example.phone','apk',?,1,?,?,?,'ready','','pipeline','{}')",
    )
    for (let n = 0; n < 110; n++)
      many.run(
        9000 + n,
        `many/${n}`,
        `dm${n}`,
        `fm${n}`,
        NOW - 10_000 + n,
        NOW + 86_400_000,
      )
    const wide = dashboardData({
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: () => true,
    })
    const busy = wide.projects
      .flatMap((project) => project.apps)
      .find((app) => app.slug === 'app.example.phone')!
    assert.equal(busy.builds.length, 100)
    assert.ok(busy.branches > 110)
    // The header's link covers the header only; chips and rows sit above or beside it.
    assert.match(stylesheet, /\.project header\{[^}]*position:relative\}/)
    assert.match(
      stylesheet,
      /\.project \.card-link::after\{content:'';position:absolute;inset:0\}/,
    )
    assert.match(
      stylesheet,
      /\.project a\.run-chip\{position:relative;z-index:1\}/,
    )
    assert.match(
      stylesheet,
      /\.app-grid-row a:not\(\.row-link\)\{position:relative;z-index:1\}/,
    )
    // A project whose app IDs the viewer may not see has none.
    assert.deepEqual(
      dashboardData({
        db: fixture(),
        viewer: viewer('developer'),
        now: NOW,
        appVisible: (id) => id === 3,
      }).projects.find((card) => card.slug === 'phones')!.apps,
      [],
    )
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
    assert.deepEqual(find('#2'), ['run:phones Run 2'])
    assert.deepEqual(find('run 2'), ['run:phones Run 2'])
    // Newest first.
    assert.deepEqual(find('1'), ['run:desk Run 1', 'run:phones Run 1'])
    assert.deepEqual(find('cccc'), ['commit:cccccccccccc'])
    assert.deepEqual(find('login'), ['branch:feature/login'])
    assert.deepEqual(find('   '), [])
    // LIKE wildcards are matched literally.
    assert.deepEqual(find('%'), [])
    assert.equal(search(developer, 'phone')[0]!.href, '/projects/phones')
    // An app ID opens its page in its project, on either node.
    assert.equal(
      search(developer, 'phone')[1]!.href,
      '/projects/phones/apps/app.example.phone',
    )
    assert.equal(search(developer, '#2')[0]!.href, '/runs/run-2')
    assert.equal(
      search({ ...developer, viewer: viewer('developer', 'host') }, 'watch')[0]!
        .href,
      '/projects/phones/apps/app.example.watch',
    )
    // A tester finds the app IDs shared with them, each opening Install
    // apps, and no projects, which have no pages for testers on either node.
    const tester = {
      db,
      viewer: viewer('tester', 'host'),
      appVisible: (id: number): boolean => id === 3,
    }
    assert.deepEqual(
      search(tester, 'desk').map((result) => [result.kind, result.href]),
      [['app', '/apps/3']],
    )
    assert.deepEqual(
      search({ ...tester, viewer: viewer('tester', 'master') }, 'desk').map(
        (result) => [result.kind, result.href],
      ),
      [['app', '/apps/3']],
    )
    assert.deepEqual(search(tester, 'phone'), [])
    assert.deepEqual(search(tester, '#1'), [])
    assert.deepEqual(search(tester, 'dddd'), [])
    assert.deepEqual(search(tester, 'master'), [])
  })

  it('U17.6 secrets never render, and notifications are only for the viewer’s role', () => {
    const db = fixture()
    // What the dashboard and Artifacts answer, as the pages read it.
    const source = {
      db,
      viewer: viewer('admin'),
      now: NOW,
      appVisible: (): boolean => true,
    }
    const html = [
      JSON.stringify(dashboardData(source)),
      JSON.stringify(
        artifactsListData(
          { ...source, artifactBase: 'https://builds.example.test' },
          {},
        ),
      ),
      JSON.stringify(artifactRunData({ ...source, artifactBase: '' }, 'run-1')),
      JSON.stringify(
        search({ db, viewer: viewer('admin'), appVisible: () => true }, 'a'),
      ),
    ].join('')
    for (const secret of [SECRET, CHANNEL_KEY, TOKEN, 'storage-key'])
      assert(!html.includes(secret), secret)
    const approvals = (who: Viewer, roles?: ViewerRole[]): string[] =>
      approvalNotifications(db, who, () => roles).map((item) => item.text)
    assert.deepEqual(approvals(viewer('manager')), [
      'desk Run 1 (master) waits for your approval at approve',
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
    const run = artifactRunData(source, 'run-1')!
    // This run's variant, and the build of its commit made before builds named their run.
    const published = run.builds.map(
      (build) => `${build.buildNumber} ${build.variant}`,
    )
    assert(published.includes('26102013 arm64-v8a'))
    assert(published.includes('26102011 '))
    assert(!published.some((build) => build.startsWith('26102014')))
    assert.equal(run.builds[0]!.appId, 1)
    assert.deepEqual(run.run.project, { slug: 'phones', name: 'Phones' })
    assert.equal(run.run.number, 1)
    assert.deepEqual(
      run.tests.map((entry) => entry.passed),
      [12],
    )
    // Saved artifacts on the host's own origin, a report with its viewer.
    const report = run.artifacts.find((entry) => entry.kind === 'report')!
    assert.equal(report.viewUrl, '/runs/run-1/artifacts/report/view')
    assert(
      run.artifacts.some(
        (entry) => entry.url === '/runs/run-1/artifacts/phone-dsyms',
      ),
    )
    const running = artifactRunData(source, 'run-3')!
    assert.deepEqual([running.artifacts, running.builds], [[], []])
    assert.equal(artifactRunData(source, 'none'), undefined)
    const list = artifactsListData(source, {
      project: 'phones',
      branch: 'main',
    })
    assert.deepEqual(list.project, { slug: 'phones', name: 'Phones' })
    assert.equal(list.branch, 'main')
    // The filters' options: every project, and the project's branches, newest run first.
    assert.deepEqual(
      list.projects.map((project) => project.slug),
      ['phones', 'desk'],
    )
    assert.equal(list.branches[0], 'feature/login')
    assert(list.branches.includes('main'))
    assert.deepEqual(artifactsListData(source, {}).branches, [])
    // A project it does not know keeps its slug and has no runs.
    const nothing = artifactsListData(source, { project: 'nothing' })
    assert.deepEqual(nothing.project, { slug: 'nothing', name: 'nothing' })
    assert.deepEqual(nothing.runs, [])
    // A branch alone narrows every project.
    assert(
      artifactsListData(source, { branch: 'feature/login' }).runs.every(
        (entry) => entry.branch === 'feature/login',
      ),
    )
    const main = list.runs.find((entry) => entry.builds === 3)!
    assert.deepEqual(main.artifacts, { count: 2, size: 1_500_000 })
    assert.deepEqual(main.buildNumbers, ['26102011', '26102013'])
    assert(list.runs.every((entry) => entry.branch === 'main'))
    const master = artifactRunData(
      { ...source, artifactBase: 'https://builds.example.test' },
      'run-1',
    )!
    assert.equal(master.artifactOrigin, 'https://builds.example.test')
    assert.equal(
      master.artifacts.find((entry) => entry.kind === 'report')!.viewUrl,
      'https://builds.example.test/runs/run-1/artifacts/report/view',
    )
  })

  it('M2 lists the Runs and builds tab’s branches, push trigger’s first, and the selected one’s runs with version, build number and start', () => {
    const db = fixture()
    db.prepare(
      "INSERT INTO jobs(id,project_id,workflow,number,branch,commit_sha,trigger,status,created,request,token) VALUES('run-5',1,'nightly',1,'old/branch',NULL,'schedule','queued',?,'{}','t5')",
    ).run(NOW - 40 * HOUR)
    db.prepare(
      "INSERT INTO jobs(id,project_id,workflow,number,branch,commit_sha,trigger,status,created,request,token) VALUES('run-6',1,'@discover',1,'wizard',NULL,'request','succeeded',?,'{}','t6')",
    ).run(NOW)
    const source = {
      db,
      viewer: viewer('developer'),
      now: NOW,
      appVisible: (): boolean => true,
      artifactBase: '',
      reserved: (run: string): string | undefined =>
        run === 'run-2' ? '26110201' : undefined,
    }
    const pinned = ['develop', 'main', 'feature/*', 'release/*']
    const all = projectRunsData(source, 'phones', { pinned })
    assert.deepEqual(
      all.branches.map((entry) => [entry.branch, entry.pinned, entry.at]),
      [
        ['develop', true, undefined],
        ['main', true, NOW - 5 * HOUR],
        ['feature/login', true, NOW - HOUR],
        ['old/branch', false, NOW - 40 * HOUR],
      ],
    )
    assert.deepEqual(
      all.runs.map((run) => [run.id, run.version, run.buildNumber, run.at]),
      [
        ['run-3', '', '', NOW - HOUR],
        ['run-2', '', '26110201', NOW - 5 * HOUR],
        ['run-1', '1.0', '26102011', NOW - 30 * HOUR],
        ['run-5', '', '', NOW - 40 * HOUR],
      ],
    )
    // Fifty runs by default; a limit answers the newest that many and
    // whether older runs are left.
    assert.equal(all.more, false)
    const two = projectRunsData(source, 'phones', { pinned, limit: 2 })
    assert.deepEqual(
      two.runs.map((run) => run.id),
      ['run-3', 'run-2'],
    )
    assert.equal(two.more, true)
    const four = projectRunsData(source, 'phones', { pinned, limit: 4 })
    assert.equal(four.runs.length, 4)
    assert.equal(four.more, false)
    // A run's workflow and branch come with it, for its row.
    assert.deepEqual(
      all.runs
        .filter((run) => run.id === 'run-5')
        .map((run) => [run.number, run.workflow, run.branch, run.status]),
      [[1, 'nightly', 'old/branch', 'queued']],
    )
    const main = projectRunsData(source, 'phones', {
      branch: 'main',
      pinned: [],
    })
    assert.deepEqual(
      main.branches.map((entry) => entry.branch),
      ['feature/login', 'main', 'old/branch'],
    )
    // With no pinned branches there is no pinned group.
    assert(main.branches.every((entry) => !entry.pinned))
    assert.deepEqual(
      main.runs.map((run) => run.id),
      ['run-2', 'run-1'],
    )
    assert.equal(main.more, false)
  })

  it('M2 writes times as hours and minutes ago within a day, else the date, 24-hour time and zone', () => {
    const at = NOW - (2 * HOUR + 31 * 60_000)
    assert.equal(since(at, NOW), '2:31 ago')
    assert.equal(since(NOW + 60_000, NOW), '0:00 ago')
    assert.equal(since(NOW - 23 * HOUR - 59 * 60_000, NOW), '23:59 ago')
    assert.equal(
      since(NOW - 24 * HOUR, NOW, 'America/Los_Angeles'),
      '2026-10-20 0500 PT',
    )
    assert.equal(stamp(NOW, 'America/Los_Angeles'), '2026-10-21 0500 PT')
    assert.equal(
      stamp(Date.UTC(2026, 11, 1, 23, 7), 'America/New_York'),
      '2026-12-01 1807 ET',
    )
    assert.equal(stamp(NOW, 'UTC'), '2026-10-21 1200 UTC')
    assert.equal(stamp(NOW, 'Europe/Berlin'), '2026-10-21 1400 GMT+2')
    assert.match(stamp(NOW), /^2026-10-2\d \d{4} \S+$/)
    assert.equal(
      localTime(NOW, NOW, 'date'),
      `<time datetime="2026-10-21T12:00:00.000Z" title="2026-10-21T12:00:00.000Z" data-at="${NOW}" data-format="date">2026-10-21 1200 UTC</time>`,
    )
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
    canChangeHosts: true,
  }
  it('M2.12 a manager sees the host and may give it a Space, but only an administrator makes, pairs, reconciles or removes it', () => {
    const cloudHost = {
      name: 'h',
      state: 'ready',
      account: 'do',
      region: 'sfo3',
      size: 's',
      address: '203.0.113.9',
      origin: 'https://builds.example.test',
      error: null,
      version: '1.2.3',
    }
    const manager = nodesView({
      ...base,
      canChangeHosts: false,
      cloudHosts: [cloudHost],
    })
    assert.match(manager, /Store builds in a new DigitalOcean Space/)
    assert.deepEqual(crumbTrail(manager), ['Mason Master /', 'Nodes /nodes *'])
    assert.doesNotMatch(manager, /cloud\/hosts\/h\/reconcile|Remove host/)
    const empty = nodesView({
      ...base,
      canChangeHosts: false,
      poolAccounts: [{ id: 'do', name: 'DO', provider: 'digitalocean' }],
    })
    assert.match(empty, /Only an administrator adds or removes the host/)
    assert.doesNotMatch(empty, /Create a host on|Pair host/)
    assert.match(empty, /Pair node/, 'workers stay a manager’s')
    const owner = nodesView({ ...base, cloudHosts: [cloudHost] })
    assert.match(owner, /cloud\/hosts\/h\/reconcile/)
    assert.match(owner, /Remove host/)
  })
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

  it('edits a node’s name, type, labels and slots, and pairs a worker with its type and labels', () => {
    const node = {
      name: 'mac-1',
      fingerprint: 'mldsa65:abc/def+ghi',
      type: 'mac-xcode',
      labels: ['setup', 'apple-signing'],
      slots: 2,
      status: 'idle' as const,
      checklist: [],
    }
    const html = nodesView({
      ...base,
      nodes: [
        { ...node, role: 'worker' },
        { ...node, name: 'builds', fingerprint: 'mldsa65:host', role: 'host' },
      ],
    })
    // A worker's form sets all four; the route names the node by fingerprint.
    assert.match(
      html,
      /<form data-mason="api" data-path="\/api\/v2\/nodes\/mldsa65%3Aabc%2Fdef%2Bghi" data-method="PUT" data-fields="name,type,labels,slots" data-then="reload">/,
    )
    assert.match(
      html,
      /name="labels" data-kind="list" value="setup, apple-signing">/,
    )
    assert.match(
      html,
      /name="slots" type="number" data-kind="number" min="1" max="64" value="2">/,
    )
    // A host has only its name to set.
    assert.match(
      html,
      /data-path="\/api\/v2\/nodes\/mldsa65%3Ahost" data-method="PUT" data-fields="name" /,
    )
    // A worker is paired with optional type and labels, setup by default.
    assert.match(
      html,
      /data-path="\/api\/v2\/nodes" data-fields="address,key,type,labels"/,
    )
    assert.match(
      html,
      /id="node-labels" name="labels" data-kind="list" value="setup">/,
    )
    assert.match(
      html,
      /data-path="\/api\/v2\/nodes" data-fields="address,key" /,
    )
    const viewer = nodesView({
      ...base,
      canChange: false,
      nodes: [{ ...node, role: 'worker' }],
    })
    assert(!viewer.includes('data-method="PUT"'))
    // A browser ignores a pattern it cannot compile with the v flag.
    const patterns = [...html.matchAll(/pattern="([^"]*)"/g)].map(
      (match) => match[1]!,
    )
    assert(patterns.length >= 2)
    for (const pattern of patterns)
      assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, 'v'), pattern)
  })

  it('writes every form pattern so a browser can compile it with the v flag', () => {
    const files = ['../../src/view/admin.ts', '../../src/master/pages.ts']
    const patterns = files.flatMap((file) =>
      [
        ...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(
          /pattern="([^"$]*)"/g,
        ),
      ].map((match) => match[1]!.replaceAll('\\\\', '\\')),
    )
    assert(patterns.length > 10)
    for (const pattern of patterns)
      assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, 'v'), pattern)
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
        'Labels its machines carry, comma-separated, for stages that ask for them. Machines labelled setup run setup.',
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
    assert.deepEqual(crumbTrail(html), [
      'Mason Master /',
      'Settings /settings *',
    ])
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
    // A listed key shows only its prefix, with nothing to copy: the whole
    // key is copyable once, in the box that opens when it is created.
    assert.match(
      card,
      /<td>2026-10-03<\/td><td>active<\/td><td><span class="mono">mason_v1_abcde…<\/span><\/td>/,
    )
    assert.doesNotMatch(card, /data-copy="mason_v1_/)
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
      canChangeSignIn: true,
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
      /data-path="\/api\/v2\/settings\/signIn\/methods\/google" data-method="PUT" data-fields="type,enabled,admitTesters,name,issuer,clientId,clientSecret,authentication,signingAlgorithm"/,
    )
    assert.match(
      signIn,
      /data-path="\/api\/v2\/settings\/signIn\/methods\/gh" data-method="PUT" data-fields="type,enabled,admitTesters,name,issuer,clientId,clientSecret,authentication,authorizationEndpoint,tokenEndpoint,userinfoEndpoint,scopes,claims.subject,claims.name,claims.email,claims.emailVerified"/,
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

describe('People and groups pages', () => {
  const people: Array<{
    id: number
    name: string
    role: string
    emails: Array<{ email: string; confirmed: boolean }>
    username?: string
  }> = [
    {
      id: 1,
      name: 'Ada <Admin>',
      role: 'admin',
      emails: [{ email: 'ada@example.com', confirmed: true }],
      username: 'ada',
    },
    {
      id: 2,
      name: 'Tess',
      role: 'tester',
      emails: [{ email: 'tess@gmail.example', confirmed: true }],
    },
  ]
  const groupPeople = people.map((person) => ({
    id: person.id,
    name: person.name,
    emails: person.emails.map((entry) => entry.email),
  }))
  const apps = [
    { id: 7, name: 'Wallet', slug: 'app.example.wallet', enabled: true },
    { id: 3, name: 'Maps & more', slug: 'app.example.maps', enabled: true },
    { id: 9, name: 'Old', slug: 'app.example.old', enabled: false },
  ]
  const group = { id: 5, name: 'Beta "crew"', apps: [3, 7], members: [2] }

  it('U20.1 People lists one compact row per person in seven columns, editable as the viewer may', () => {
    const withMore = [
      {
        ...people[0]!,
        emails: [
          { email: 'ada@example.com', confirmed: true },
          { email: 'ada@claimed.example', confirmed: false },
        ],
        password: true,
        invitation: { expiresAt: Date.UTC(2026, 10, 15) },
      },
      people[1]!,
    ]
    const admin = peopleView({
      people: withMore,
      canChange: true,
      now: Date.UTC(2026, 10, 8),
    })
    assert.match(admin, /<h1>People<\/h1>/)
    // People is top-level, as the side menu has it, not under Settings.
    assert.deepEqual(crumbTrail(admin), ['Mason Master /', 'People /people *'])
    assert.deepEqual(
      [...admin.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1]),
      [
        'Full name',
        'Username',
        'Email addresses',
        'Role',
        'Invite',
        'Password',
      ],
    )
    assert.match(admin, /<span class="sr-only">Remove or save<\/span>/)
    // Names and usernames are buttons that turn into fields; labels escaped.
    assert.match(
      admin,
      /<button type="button" class="cell-edit" data-edit="name" aria-label="Edit full name">Ada &lt;Admin&gt;<\/button><input class="cell-input" data-input="name" value="Ada &lt;Admin&gt;"/,
    )
    assert.match(
      admin,
      /data-edit="username"[^>]*><span class="muted">—<\/span><\/button>/,
    )
    // One line per email, each with a red ×; Add under the last; unconfirmed tagged.
    const emails = admin.slice(
      admin.indexOf('<ul class="email-lines"'),
      admin.indexOf('</td>', admin.indexOf('<ul class="email-lines"')),
    )
    assert.equal(emails.match(/data-remove-email/g)!.length, 2)
    assert.match(
      emails,
      /<\/ul><button type="button" class="pill" data-add-email>Add<\/button>$/,
    )
    assert.match(
      emails,
      /<li data-email="ada@claimed\.example" data-unconfirmed><span class="email">ada@claimed\.example<\/span><small class="tag">unconfirmed<\/small><button type="button" class="pill" data-confirm-email>Confirm<\/button>/,
    )
    assert.match(
      admin,
      /<select data-role aria-label="Role"><option selected>admin<\/option>/,
    )
    assert.doesNotMatch(admin, /Set role/)
    // Invite and Password are pills opening modals; Remove is last.
    assert.match(
      admin,
      /<button type="button" class="pill" data-open="invite-1">Invite again<\/button><dialog class="modal" id="invite-1"/,
    )
    assert.match(admin, /Expires/)
    assert.match(
      admin,
      /<button type="button" class="pill" data-open="password-1">Change password<\/button>/,
    )
    assert.match(
      admin,
      /<button type="button" class="pill" data-open="password-2">Set password<\/button>/,
    )
    assert.match(
      admin,
      /<td class="row-action"><button type="button" data-row-action class="danger">Remove<\/button><\/td><\/tr>/,
    )
    assert.match(
      admin,
      /data-original="\{&quot;name&quot;:&quot;Ada &lt;Admin&gt;&quot;/,
    )
    assert.match(admin, /<dialog class="modal" data-email-dialog/)
    assert.match(admin, /<dialog class="modal" data-confirm-dialog/)
    assert.match(
      admin,
      /<div class="email-fields" data-email-fields><input id="person-email" name="email" type="email" aria-label="Email address"><\/div><button type="button" class="pill" data-add-email-field>Add<\/button>/,
    )
    assert.doesNotMatch(admin, /\/api\/v2\/groups|Tester groups/)
    // A manager reads everyone, edits only their own name and emails.
    const manager = peopleView({ people, canChange: false, viewerId: 2 })
    assert.doesNotMatch(manager, /data-mason="person-add"|data-open=|data-role/)
    assert.match(manager, /<td>tester<\/td>/)
    const own = manager.slice(manager.indexOf('<tr data-person="2"'))
    assert.match(own, /data-edit="self"/)
    assert.match(own, /data-edit="name"/)
    assert.doesNotMatch(own, /data-edit="username"/)
    assert.match(own, /data-add-email/)
    assert.match(
      own,
      /<button type="button" data-row-action hidden>Save<\/button>/,
    )
    const other = manager.slice(
      manager.indexOf('<tr data-person="1"'),
      manager.indexOf('</tr>', manager.indexOf('<tr data-person="1"')),
    )
    assert.match(other, /data-edit="none"/)
    assert.doesNotMatch(
      other,
      /data-edit="name"|data-remove-email|data-row-action/,
    )
    assert.match(peopleView({ people: [], canChange: false }), /Nobody yet\./)
  })

  it('M4.9 Your account shows the person’s own record, editable but for the username and role, with the password and Sign out', () => {
    const person = {
      id: 5,
      name: 'Tess <T>',
      role: 'tester',
      username: 'tess',
      password: true,
      emails: [
        { email: 'tess@example.test', confirmed: true },
        { email: 'tess@claim.test', confirmed: false },
      ],
    }
    const html = accountView({
      viewer: viewer('tester', 'host'),
      person,
      signOut: '<form data-mason="sign-out"><button>Sign out</button></form>',
      editable: true,
    })
    assert.match(html, /<h1>Your account<\/h1>/)
    assert.deepEqual(crumbTrail(html), [
      'Mason Host /',
      'Your account /account *',
    ])
    assert.match(
      html,
      /<section class="panel account" data-person="5" data-edit="self"/,
    )
    assert.match(
      html,
      /data-edit="name" aria-label="Edit full name">Tess &lt;T&gt;</,
    )
    assert.doesNotMatch(
      html,
      /data-edit="username"|data-role|data-confirm-email/,
    )
    assert.match(
      html,
      /<dd class="person-username"><span class="mono">tess<\/span>/,
    )
    assert.match(html, /<dd>tester<\/dd>/)
    assert.equal(html.match(/data-remove-email/g)!.length, 2)
    assert.match(html, /data-add-email/)
    assert.match(html, /data-open="password-own">Change password</)
    assert.match(
      html,
      /data-path="\/api\/v2\/people\/5" data-return="\/account"/,
    )
    assert.match(
      html,
      /<button type="button" data-row-action hidden>Save<\/button><form data-mason="sign-out">/,
    )
    assert.match(html, /data-confirm-dialog/)
    const offline = accountView({
      viewer: viewer('tester'),
      person: { ...person, password: false },
      signOut: '',
      editable: false,
    })
    assert.match(offline, /cannot reach the master/)
    assert.deepEqual(crumbTrail(offline)[0], 'Mason Master /')
    assert.match(offline, /data-edit="none"/)
    assert.doesNotMatch(offline, /data-row-action|data-add-email|data-open=/)
  })

  it('M4.10 the top-right account icon is a link to Your account', () => {
    const html = shell({
      title: 'x',
      body: '',
      viewer: { name: 'ada', role: 'admin', node: 'master', signOut: '' },
    })
    assert.match(
      html,
      /<a class="account" href="\/account" aria-label="Your account" title="ada · admin · master"><span class="avatar">A<\/span><\/a>/,
    )
    assert.doesNotMatch(html, /<details class="account"/)
  })

  it('M8 draws every trail as pill links from Mason Master or Mason Host, the last one current', () => {
    // The first pill names the node and opens its home; a host and a standalone server are both Mason Host.
    for (const [node, first] of [
      ['master', 'Mason Master'],
      ['host', 'Mason Host'],
      ['standalone', 'Mason Host'],
    ] as const)
      assert.deepEqual(crumbTrail(breadcrumbs({ node }, [])), [`${first} / *`])
    const html = breadcrumbs({ node: 'master' }, [
      { label: 'A <b> & "c"', href: '/x?a=1&b=<2>' },
      { label: 'Last', href: '/y', data: { 'group-title': 'z"' } },
    ])
    assert.equal(
      html,
      '<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a class="crumb" href="/">Mason Master</a></li><li><span class="crumb-sep" aria-hidden="true">›</span><a class="crumb" href="/x?a=1&amp;b=&lt;2&gt;">A &lt;b&gt; &amp; &quot;c&quot;</a></li><li><span class="crumb-sep" aria-hidden="true">›</span><a class="crumb" href="/y" aria-current="page" data-group-title="z&quot;">Last</a></li></ol></nav>',
    )
    assert.equal(html.match(/aria-current/g)!.length, 1)
    // The master's own pages, as the side menu lists them.
    assert.deepEqual(
      crumbTrail(cloudView({ accounts: [], canChange: true, now: NOW })),
      ['Mason Master /', 'Cloud /cloud *'],
    )
  })

  it('U20.2 the Groups list links one row per group and adds a group by name', () => {
    const html = groupsView({
      groups: [
        { id: 4, name: 'Alpha' },
        { id: 12, name: 'Beta <b>' },
      ],
      canChange: true,
    })
    assert.match(html, /<h1>Groups<\/h1>/)
    assert.deepEqual(crumbTrail(html), ['Mason Master /', 'Groups /groups *'])
    assert.deepEqual(
      [
        ...html.matchAll(
          /<a class="list-row" href="([^"]+)"><strong>([^<]*)</g,
        ),
      ].map((match) => [match[1], match[2]]),
      [
        ['/groups/4', 'Alpha'],
        ['/groups/12', 'Beta &lt;b&gt;'],
      ],
    )
    assert.doesNotMatch(html, /No groups\./)
    const form = html.slice(html.indexOf('<form'))
    assert.match(form, /data-path="\/api\/v2\/groups"/)
    assert.match(form, /data-fields="name"/)
    assert.match(form, /data-then="group"/)
    assert.match(
      form,
      /<input id="group-name" name="name" maxlength="120" required>/,
    )
    assert.doesNotMatch(form, /data-method=/)
    const empty = groupsView({ groups: [], canChange: false })
    assert.match(empty, /<p class="empty-state">No groups\.<\/p>/)
    assert.doesNotMatch(empty, /<form|list-row/)
  })

  it('U20.3 a group page: the name row, one row per app and member, and Remove group', () => {
    const html = groupView({
      group,
      apps,
      people: groupPeople,
      canChange: true,
    })
    assert.match(html, /<h1 data-group-title>Beta &quot;crew&quot;<\/h1>/)
    // Groups › the group, its pill renamed with the title.
    assert.deepEqual(crumbTrail(html), [
      'Mason Master /',
      'Groups /groups',
      'Beta &quot;crew&quot; /groups/5 *',
    ])
    assert.match(
      html,
      /<a class="crumb" href="\/groups\/5" aria-current="page" data-group-title="">Beta &quot;crew&quot;<\/a>/,
    )
    assert.match(html, /<div class="group-page" data-group="5">/)
    // The name row comes first, as a button, with its hidden field.
    const page = html.slice(html.indexOf('data-group="5"'))
    assert.match(
      page,
      /^data-group="5"><div class="group-name" data-group-name><button type="button" class="list-row" data-group-rename><span><small>Name<\/small><strong data-group-name-text>Beta &quot;crew&quot;<\/strong>/,
    )
    assert.match(
      page,
      /<input name="name" maxlength="120" value="Beta &quot;crew&quot;" aria-label="Group name" autocomplete="off" data-group-name-input hidden>/,
    )
    // Apps in catalog order, with the slug; members with their email or address.
    const appsSection = page.slice(
      page.indexOf('data-group-section="apps"'),
      page.indexOf('data-group-section="members"'),
    )
    assert.match(appsSection, /<h2>.*Apps<\/h2>/)
    assert.deepEqual(
      [
        ...appsSection.matchAll(
          /<li data-id="(\d+)"><div><strong>([^<]*)<\/strong><small class="mono">([^<]*)</g,
        ),
      ].map((match) => [match[1], match[2], match[3]]),
      [
        ['7', 'Wallet', 'app.example.wallet'],
        ['3', 'Maps &amp; more', 'app.example.maps'],
      ],
    )
    const members = page.slice(page.indexOf('data-group-section="members"'))
    assert.match(members, /<h2>.*Group Members<\/h2>/)
    assert.match(
      members,
      /<ul data-group-rows><li data-id="2"><div><strong>Tess<\/strong><small>tess@gmail\.example<\/small><\/div><\/li><\/ul>/,
    )
    // Remove group is a DELETE that returns to the list.
    const remove = page.slice(page.lastIndexOf('<form'))
    assert.match(
      remove,
      /data-path="\/api\/v2\/groups\/5" data-method="DELETE"/,
    )
    assert.match(remove, /data-then="groups"/)
    assert.match(remove, /Remove group/)
    // Without groups.change: text, and no forms.
    const read = groupView({
      group: { id: 5, name: 'Beta', apps: [], members: [1] },
      apps,
      people: groupPeople,
      canChange: false,
    })
    assert.match(
      read,
      /<div class="group-name"><div class="list-row"><span><small>Name<\/small><strong data-group-name-text>Beta<\/strong><\/span><\/div><\/div>/,
    )
    assert.doesNotMatch(read, /<form|<button|data-group-rename/)
    assert.match(read, /<ul data-group-rows><\/ul>/)
    assert.match(
      read,
      /<strong>Ada &lt;Admin&gt;<\/strong><small>ada@example\.com/,
    )
  })

  it('U20.12 a group page offers Add App and Add member over a catalog in the page', () => {
    const tricky = [
      ...apps,
      { id: 11, name: '</script><b>x', slug: 'app.example.x', enabled: true },
    ]
    const html = groupView({
      group,
      apps: tricky,
      people: groupPeople,
      canChange: true,
    })
    for (const [kind, add, find] of [
      ['apps', 'Add App', 'Find an app'],
      ['members', 'Add member', 'Find a person'],
    ]) {
      const part = html.slice(
        html.indexOf(`data-group-section="${kind}"`),
        html.indexOf(
          '</section>',
          html.indexOf(`data-group-section="${kind}"`),
        ),
      )
      // The picker is hidden, its field has Done after it; the message sits
      // outside it, so it outlasts Done, and Add stays last.
      assert.match(
        part,
        new RegExp(
          `</ul><div class="group-picker" data-group-picker hidden><div class="picker-bar"><input type="search" data-group-query aria-label="${find}" [^>]*><button type="button" class="secondary" data-group-done>Done</button></div><div data-group-choices></div></div><p class="notice" role="alert" data-group-error hidden></p><button type="button" class="secondary" data-group-add>.*${add}</button>$`,
        ),
        kind,
      )
    }
    const source =
      /<script type="application\/json" data-group-catalog>(.*?)<\/script>/.exec(
        html,
      )![1]!
    assert(!source.includes('<'))
    assert.deepEqual(JSON.parse(source), {
      apps: tricky,
      people: groupPeople,
      group: { apps: [3, 7], members: [2] },
    })
    assert.equal(html.match(/<\/script>/g)!.length, 1)
    // Without groups.change: no pickers and no catalog.
    const read = groupView({
      group,
      apps,
      people: groupPeople,
      canChange: false,
    })
    assert.doesNotMatch(read, /data-group-add|data-group-catalog|Add App/)
  })

  it('U20.4 the Settings intro links People and Groups', () => {
    const html = settingsView({
      apple: { signedIn: false, needsCode: false },
      keys: [],
      canChange: true,
      canCreate: true,
      canRevoke: true,
    })
    assert.match(
      html,
      /<p><a href="\/people">People<\/a> · <a href="\/groups">Groups<\/a> · <a href="\/backups">Backups<\/a> · <a href="\/nodes">Nodes<\/a><\/p>/,
    )
  })
})
