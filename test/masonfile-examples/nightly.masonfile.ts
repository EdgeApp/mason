import type { Setup, Stage } from '@mason/types'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('nightly', {
    format: 'YYYY.MM.DD.CCC',
    scope: 'branch',
    timeZone: 'America/Los_Angeles',
  })

  const test = m.stage('test', {
    on: 'linux',
    tools: { node: '24' },
    run: unitTests,
  })
  m.parallel(
    'build',
    {
      ios: [
        { name: 'compile', on: 'mac-xcode', run: compileIos },
        {
          name: 'sign',
          on: { type: 'mac-xcode', labels: ['apple-signing'] },
          secrets: ['MATCH_PASSWORD'],
          run: signIos,
        },
      ],
      web: { on: { os: 'linux', arch: 'x64' }, run: buildWeb },
    },
    { needs: [test] },
  )

  m.workflow(
    'nightly',
    {
      triggers: [{ schedule: '0 3 * * *', branches: ['master'] }],
      keep: { runs: 14, artifactDays: 30 },
    },
    (w) => {
      w.stage('soak', {
        on: 'mac-simulators',
        timeout: '4h',
        activityTimeout: '20m',
        buildNumbers: ['nightly'],
        workspace: { path: 'soak', mode: 'reuse' },
        run: soakTests,
      })
      w.post({
        always: { on: 'linux', run: collectReports },
        failure: {
          on: 'linux',
          secrets: ['SLACK_WEBHOOK'],
          run: notifyFailure,
        },
      })
    },
  )
}

export async function unitTests(ctx: Stage) {
  await ctx.sh('npm ci && npm test', { env: { CI: '1' } })
  const summary = await ctx.tests('junit', 'reports/*.xml')
  return { failed: summary.failed }
}
export async function compileIos(ctx: Stage) {
  await ctx.log.section('Compile', async () => {
    await ctx.exec('xcodebuild', ['-scheme', 'App', 'build'])
  })
  await ctx.stash('build', ['build/**'])
}
export async function signIos(ctx: Stage) {
  await ctx.unstash('build')
  await ctx.sh('scripts/sign.sh', {
    env: { MATCH_PASSWORD: ctx.secret('MATCH_PASSWORD') },
  })
}
export async function buildWeb(ctx: Stage) {
  await ctx.sh('npm run build:web')
}
export async function soakTests(ctx: Stage) {
  const label = ctx.getBuildNumber('nightly')
  ctx.describe(`Soak ${label}`)
  await ctx.retry(3, () => ctx.sh('npm run soak'))
}
export async function collectReports(ctx: Stage) {
  await ctx.artifacts.save('reports', 'reports/**', {
    kind: 'report',
    entry: 'reports/index.html',
  })
}
export async function notifyFailure(ctx: Stage) {
  await fetch(ctx.secret('SLACK_WEBHOOK'), {
    method: 'POST',
    body: JSON.stringify({ text: `${ctx.run.url} failed` }),
  })
}
