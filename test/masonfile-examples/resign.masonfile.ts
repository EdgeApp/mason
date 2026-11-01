import type { Setup, Stage } from '@mason/types'

const APP = 'com.example.app'

// Build once without signing material, then sign the same build for the App
// Store on a signing Mac: the archive never needs a certificate, and only the
// signing stage holds one.
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber(APP, { check: 'apple' })

  m.stage('ios', {
    on: 'mac-xcode',
    tools: { node: '24', xcode: '>=26' },
    buildNumbers: [APP],
    run: buildIos,
  })

  m.stage('sign', {
    on: { type: 'mac-xcode', labels: ['apple-signing'] },
    checkout: false,
    apple: { distribution: 'appStore', app: APP },
    publishes: [APP],
    run: signIos,
  })
}

export async function buildIos(ctx: Stage) {
  await ctx.sh('npm ci && cd ios && pod install')
  await ctx.exec('xcodebuild', [
    'archive',
    '-workspace',
    'ios/App.xcworkspace',
    '-scheme',
    'App',
    '-destination',
    'generic/platform=iOS',
    '-archivePath',
    'build/App.xcarchive',
    `CURRENT_PROJECT_VERSION=${ctx.getBuildNumber(APP)}`,
    'CODE_SIGNING_ALLOWED=NO',
  ])
  await ctx.stash('ios-build', 'build/App.xcarchive/**')
}

export async function signIos(ctx: Stage) {
  await ctx.unstash('ios-build')
  const { ipa, bundles } = await ctx.apple.resign({
    path: 'build/App.xcarchive',
  })
  ctx.log.info(`Signed ${bundles.length} bundles`)
  await ctx.apple.testflight({ path: ipa, groups: ['Internal'] })
  return await ctx.publish({ app: APP, platform: 'ios', path: ipa })
}
