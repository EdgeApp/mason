import type { Setup, Stage } from '@mason/types'

const APP = 'com.example.app'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber(APP, { check: 'apple' })
  m.workflow(
    'release',
    {
      triggers: [{ request: true }],
      params: {
        track: {
          type: 'choice',
          choices: ['testflight', 'store'],
          default: 'testflight',
        },
        notes: { type: 'text' },
        tag: { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$' },
      },
      concurrency: { group: 'project', cancelPrevious: false },
      timeout: '6h',
    },
    (w) => {
      const e2e = w.stage('e2e', {
        on: 'mac-simulators',
        retry: { attempts: 2, on: ['failed'] },
        run: endToEnd,
      })
      const ship = w.approval('ship', {
        needs: [e2e],
        roles: ['admin', 'manager'],
        message: 'Upload this build to the store?',
        timeout: '24h',
        params: { notes: { type: 'text' } },
      })
      w.stage('upload', {
        needs: [ship],
        on: 'mac-xcode',
        apple: { distribution: 'appStore', app: APP },
        buildNumbers: [APP],
        lock: 'ios-signing',
        run: uploadToStore,
      })
    },
  )
}

export async function endToEnd(ctx: Stage) {
  await ctx.sh('npm run e2e', { allowFailure: true })
  // What a stage returns is its output: results of Mason's calls are JSON.
  return await ctx.tests('junit', 'reports/e2e/*.xml', { failOn: 'failure' })
}

export async function uploadToStore(ctx: Stage) {
  const approval = await ctx.output<{ notes: string }>('ship')
  const build = ctx.getBuildNumber(APP)
  const archived = await ctx.apple.archive({
    workspace: 'ios/App.xcworkspace',
    scheme: 'App',
    version: '1.4.2',
    buildNumber: build,
  })
  const ipa = archived.ipa
  if (ipa == null) throw new Error('No IPA was exported')
  const testflight = await ctx.apple.testflight({
    path: ipa,
    whatToTest: approval.notes,
    groups: ['Internal'],
  })
  await ctx.git.tag(`v1.4.2-${build}`, { push: true })
  return { archived, testflight }
}
