import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson

interface PackageJson {
  version: string
  repository?: { url?: string } | string
  masonReleases?: string
}

/** Mason's version, from the package it runs from. */
export const version: string = pkg.version

/**
 * The GitHub repository releases are published to and fetched from
 * (`owner/name`): the package's `masonReleases` field, else its `repository`.
 */
export const repository: string | undefined = releasesRepository(pkg)

/** Where a package's releases live: `masonReleases`, else its source repository. */
export function releasesRepository(value: PackageJson): string | undefined {
  return value.masonReleases ?? repositoryName(value.repository)
}

/** `owner/name` from a package.json `repository` field, when it names GitHub. */
export function repositoryName(
  value: { url?: string } | string | undefined,
): string | undefined {
  const url = typeof value === 'string' ? value : value?.url
  return /(?:github\.com[/:]|^github:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
    url ?? '',
  )?.[1]
}
