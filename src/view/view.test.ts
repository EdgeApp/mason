import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from '../master/database.js'
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

describe('Account link and trails', () => {
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
  })
})
