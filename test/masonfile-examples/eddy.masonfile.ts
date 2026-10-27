import type { Setup, Stage } from '@mason/types'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('app.edge.eddy', { format: 'YYMMDDCC', check: 'apple' })
  m.stage('test', { on: 'linux', tools: { node: '24' }, run: unitTests })
  m.stage('mac', {
    on: 'mac-xcode',
    publishes: ['app.edge.eddy'],
    run: buildMac,
  })
}

export async function unitTests(ctx: Stage) {
  await ctx.sh('npm ci && npm test')
}

export async function buildMac(ctx: Stage) {
  const build = ctx.getBuildNumber('app.edge.eddy')
  await ctx.sh(`scripts/make-dmg.sh ${build}`)
  await ctx.publish({
    app: 'app.edge.eddy',
    platform: 'macos',
    path: `build/Eddy-${build}.dmg`,
    version: '0.3.3',
    buildNumber: build,
  })
}
