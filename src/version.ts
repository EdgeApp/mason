import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string; repository?: { url?: string } | string }

/** Mason's version, from the package it runs from. */
export const version: string = pkg.version

/**
 * The GitHub repository releases are published to and fetched from
 * (`owner/name`), from the package's `repository` field.
 */
export const repository: string | undefined = repositoryName(pkg.repository)

/** `owner/name` from a package.json `repository` field, when it names GitHub. */
export function repositoryName(
  value: { url?: string } | string | undefined,
): string | undefined {
  const url = typeof value === 'string' ? value : value?.url
  return /(?:github\.com[/:]|^github:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
    url ?? '',
  )?.[1]
}
