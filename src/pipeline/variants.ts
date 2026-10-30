// What a secret variant is and which one a stage gets, shared by the
// master, the pipeline graph checks and the Secrets tab's script. Pure: it
// imports nothing, so the setup and stage runners and the browser bundle
// can load it.

/** The largest secret value: an environment variable. */
export const MAX_VALUE = 64 * 1024
/** The largest secret file, decoded. */
export const MAX_FILE = 5 * 1024 * 1024
/** Build configs a stage may list, and a variant may hold. */
export const MAX_CONFIGS = 20

/** A build config: letters, digits, dashes and underscores. */
export function isConfig(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]+$/.test(token)
}

/** What a file over `MAX_FILE` is told. */
export const tooLarge = (what: string): string =>
  `${what} is over ${MAX_FILE / 1024 / 1024} MiB`

/**
 * A variant's configs, from a comma-separated field or a list: deduplicated
 * and sorted, blanks ignored; empty means all, the default variant.
 */
export function asConfigs(value: unknown): string[] {
  const list =
    value == null
      ? []
      : typeof value === 'string'
        ? value.split(',')
        : Array.isArray(value)
          ? value.map((item) => {
              if (typeof item !== 'string')
                throw new Error('Build configs are text')
              return item
            })
          : undefined
  if (list == null)
    throw new Error('Build configs are a comma-separated list or an array')
  const tokens = list.map((item) => item.trim()).filter((item) => item !== '')
  for (const token of tokens)
    if (!isConfig(token))
      throw new Error(
        `${token} is not a build config: use letters, digits, dashes and underscores`,
      )
  const out = [...new Set(tokens)].sort()
  if (out.length > MAX_CONFIGS)
    throw new Error(`At most ${MAX_CONFIGS} build configs`)
  return out
}

/**
 * The variant of one secret a stage gets: the variant holding the latest of
 * the stage's configs, else the default variant, else none.
 */
export function resolveSecret<T extends { configs: string[] }>(
  variants: T[],
  configs: readonly string[],
): T | undefined {
  for (let index = configs.length - 1; index >= 0; index--) {
    const found = variants.find((variant) =>
      variant.configs.includes(configs[index]!),
    )
    if (found != null) return found
  }
  return variants.find((variant) => variant.configs.length === 0)
}

/** Every declared name a stage gets, by name, with the variant it resolves to. */
export function resolveSecrets<T extends { name: string; configs: string[] }>(
  variants: T[],
  names: readonly string[],
  configs: readonly string[],
): Map<string, T> {
  const out = new Map<string, T>()
  for (const name of names) {
    const found = resolveSecret(
      variants.filter((variant) => variant.name === name),
      configs,
    )
    if (found != null) out.set(name, found)
  }
  return out
}

/**
 * Why a stage cannot declare a secret, or undefined when it can: the
 * project has no such name, or no variant for the stage's configs and no
 * default.
 */
export function unresolvedSecret(
  stage: string,
  name: string,
  variants: Array<{ name: string; configs: string[] }>,
  configs: readonly string[],
): string | undefined {
  const named = variants.filter((variant) => variant.name === name)
  if (named.length === 0)
    return `Stage ${stage} declares secret ${name}, which the project does not have`
  if (resolveSecret(named, configs) == null)
    return `Stage ${stage} declares secret ${name}, which has no variant for configs ${configs.length === 0 ? '(none)' : configs.join(', ')} and no default`
  return undefined
}

/** Whether the build environment sets this name; a secret by that name is not put in commands' environment. */
export function isReservedName(name: string): boolean {
  return /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|PWD|OLDPWD|LANG|LC_[A-Z]+|TERM|CI|HOSTNAME|(GIT|SSH|NPM_CONFIG|DYLD|LD)_[A-Z0-9_]*)$/.test(
    name,
  )
}
