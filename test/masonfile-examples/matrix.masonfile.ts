import type { Setup, Stage } from '@mason/types'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.matrix('platforms', {
    axes: { target: ['ios', 'android', 'cli'], config: ['debug', 'release'] },
    exclude: [{ target: 'cli', config: 'debug' }],
    on: ({ target }) => (target === 'ios' ? 'mac-xcode' : 'linux'),
    run: buildTarget,
  })
  const shards = Array.from(
    { length: Number(m.params.shards ?? 4) },
    (_, i) => i + 1,
  )
  m.matrix('tests', { axes: { shard: shards }, on: 'linux', run: testShard })
  m.matrix('xcode-compat', {
    axes: { xcode: ['26.0.1', '26.1'] },
    on: 'mac-xcode',
    tools: ({ xcode }) => ({ xcode }),
    when: {
      branch: ['master', 'release/**'],
      notBranch: ['wip/**'],
      changed: ['ios/**'],
    },
    run: unitTestsIos,
  })
}

export async function buildTarget(ctx: Stage) {
  const { target, config } = ctx.stage.matrix
  await ctx.sh(`npm run build:${String(target)} -- --${String(config)}`)
}
export async function testShard(ctx: Stage) {
  await ctx.sh(`npm test -- --shard ${String(ctx.stage.matrix.shard)}`)
}
export async function unitTestsIos(ctx: Stage) {
  ctx.log.info(`Xcode ${ctx.node.xcode?.version ?? 'unknown'}`)
  await ctx.sh('xcodebuild test -scheme App')
}
