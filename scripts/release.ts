import { releaseMain } from '../lib/release/build.js'
process.exitCode = await releaseMain(
  process.argv.slice(2),
  new URL('..', import.meta.url).pathname,
)
