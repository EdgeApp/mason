import { readFileSync } from 'node:fs'

/** Mason's version, from the package it runs from. */
export const version: string = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version
