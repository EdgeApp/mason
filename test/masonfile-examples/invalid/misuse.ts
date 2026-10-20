// Each @ts-expect-error marks misuse the types must reject. An unused
// directive is itself an error, so every line here must stay invalid.
import type { Setup, Stage } from '@mason/types'

export async function work(_ctx: Stage) {}

export function setup(m: Setup) {
  // @ts-expect-error run must be a function
  m.stage('a', { on: 'linux', run: 'work' })

  // @ts-expect-error unknown node selector field
  m.stage('b', { on: { os: 'linux', cpu: 4 }, run: work })

  // @ts-expect-error setup has no secrets
  m.secret('TOKEN')

  // @ts-expect-error publishes holds app IDs
  m.stage('c', { on: 'linux', publishes: [42], run: work })

  // @ts-expect-error branch globs are strings
  m.stage('d', { on: 'linux', when: { branch: [7] }, run: work })

  // @ts-expect-error an approval runs nothing
  m.approval('e', { run: work })

  // @ts-expect-error an unknown OS
  m.stage('f', { on: { os: 'beos' }, run: work })

  // @ts-expect-error only API version 1 exists
  m.apiVersion(2)

  // @ts-expect-error a duration needs a unit
  m.stage('g', { on: 'linux', timeout: '90', run: work })

  // @ts-expect-error an unknown trigger
  m.workflow('h', { triggers: [{ cron: '* * * * *' }] }, () => {})
}

export async function stage(ctx: Stage) {
  // @ts-expect-error getBuildNumber returns a string
  const n: number = ctx.getBuildNumber('app')
  // @ts-expect-error unknown test format
  await ctx.tests('nunit', 'x.xml')
  // @ts-expect-error publish needs a platform
  await ctx.publish({ app: 'a', path: 'x.ipa' })
  return n
}
