import type { Setup, Stage } from '@mason/types'

const APP = 'app.teamstation.app'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber(APP, { check: 'apple' })

  m.stage('test', {
    on: 'linux',
    tools: { node: '24' },
    cache: [{ key: 'npm', paths: ['~/.npm'] }],
    run: test,
  })

  m.parallel('build', {
    ios: {
      on: { type: 'mac-xcode', labels: ['apple-signing'] },
      tools: { node: '24', xcode: '>=26' },
      apple: { distribution: 'adHoc', app: APP },
      publishes: [APP],
      run: buildIos,
    },
    android: {
      on: 'linux',
      tools: {
        node: '24',
        java: '21',
        android: ['platforms;android-35', 'build-tools;35.0.0'],
      },
      publishes: [APP],
      secrets: ['ANDROID_KEYSTORE'],
      run: buildAndroid,
    },
    web: { on: 'linux', tools: { node: '24' }, run: buildWeb },
  })

  m.stage('e2e', {
    on: 'mac-simulators',
    tools: { node: '24' },
    timeout: '90m',
    retry: { attempts: 2, on: ['failed'] },
    run: e2e,
  })

  m.post({
    failure: { on: 'linux', secrets: ['SLACK_WEBHOOK'], run: notifyFailure },
  })

  m.workflow(
    'release',
    {
      triggers: [{ request: true }],
      params: { external: { type: 'boolean', default: false } },
      concurrency: { group: 'project' },
    },
    (w) => {
      const ship = w.approval('approve', {
        roles: ['admin'],
        message: 'Send this commit to TestFlight?',
      })
      w.stage('testflight', {
        needs: [ship],
        on: 'mac-xcode',
        tools: { node: '24', xcode: '>=26' },
        apple: { distribution: 'appStore', app: APP },
        buildNumbers: [APP],
        run: releaseToTestflight,
      })
    },
  )
}

export async function test(ctx: Stage) {
  await ctx.sh('npm ci')
  await ctx.sh(
    'npm run lint && npm test -- --reporter junit --output reports/unit.xml',
    {
      allowFailure: true,
    },
  )
  await ctx.tests('junit', 'reports/*.xml')
  await ctx.stash('node_modules', ['node_modules/**'])
}

async function archiveIos(ctx: Stage) {
  await ctx.sh('npm ci && npx pod-install ios')
  const build = ctx.getBuildNumber(APP)
  const result = await ctx.apple.archive({
    workspace: 'ios/TeamStation.xcworkspace',
    scheme: 'TeamStation',
    configuration: 'Release',
    version: '1.4.2',
    buildNumber: build,
  })
  if (result.ipa == null) throw new Error('No IPA was exported')
  return { ipa: result.ipa, dsyms: result.dsyms, build }
}

export async function buildIos(ctx: Stage) {
  const { ipa, dsyms, build } = await archiveIos(ctx)
  await ctx.publish({
    app: APP,
    platform: 'ios',
    path: ipa,
    buildNumber: build,
  })
  await ctx.artifacts.save('ios-dsym', dsyms)
}

export async function buildAndroid(ctx: Stage) {
  const build = ctx.getBuildNumber(APP)
  await ctx.sh(`./gradlew assembleRelease -PversionCode=${build}`, {
    cwd: 'android',
    env: { KEYSTORE: ctx.secretFile('ANDROID_KEYSTORE') },
  })
  await ctx.publish({
    app: APP,
    platform: 'android',
    path: 'android/app/build/outputs/apk/release/app-release.apk',
    buildNumber: build,
  })
}

export async function buildWeb(ctx: Stage) {
  await ctx.unstash('node_modules')
  await ctx.sh('npm run build:web')
  await ctx.stash('web', ['dist/web/**'])
}

export async function e2e(ctx: Stage) {
  await ctx.unstash('node_modules')
  await ctx.unstash('web')
  await ctx.artifacts.fetch(
    { workflow: 'build', commit: ctx.run.commit, name: 'ios-dsym' },
    'tmp/dsym',
  )
  await ctx.sh('npm run e2e', { allowFailure: true })
  await ctx.tests('junit', 'reports/e2e/*.xml')
  await ctx.artifacts.save('screenshots', 'reports/e2e/screens/**', {
    kind: 'report',
    entry: 'reports/e2e/screens/index.html',
  })
}

export async function notifyFailure(ctx: Stage) {
  await fetch(ctx.secret('SLACK_WEBHOOK'), {
    method: 'POST',
    body: JSON.stringify({ text: `${ctx.run.url} failed` }),
  })
}

export async function releaseToTestflight(ctx: Stage) {
  const { ipa } = await archiveIos(ctx)
  await ctx.apple.testflight({
    path: ipa,
    whatToTest: ctx.run.changes.map((c) => c.subject).join('\n'),
    groups: ctx.run.params.external ? ['Internal', 'Coaches'] : ['Internal'],
    usesNonExemptEncryption: false,
  })
}
