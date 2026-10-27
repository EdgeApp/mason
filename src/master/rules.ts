/** A branch rule: an exact name or glob, and how matching branches build. */
export interface BranchRule {
  pattern: string
  mode: 'automatic' | 'request'
}

/**
 * A glob as a regular expression: `**` matches across path segments, `*`
 * within one, and everything else literally.
 */
export function globExpression(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**', i)) {
      out += '.*'
      i++
    } else if (pattern[i] === '*') out += '[^/]*'
    else out += pattern[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

export const isGlob = (pattern: string): boolean => pattern.includes('*')

export function matches(pattern: string, branch: string): boolean {
  return globExpression(pattern).test(branch)
}

/** The first rule that matches a branch decides; none means it cannot build. */
export function ruleFor(
  rules: BranchRule[],
  branch: string,
): BranchRule | undefined {
  return rules.find((rule) => matches(rule.pattern, branch))
}

export function asRules(value: unknown): BranchRule[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Expected a list of branch rules')
  return value.map((entry: unknown) => {
    const rule = entry as Partial<BranchRule> | null
    if (
      rule == null ||
      typeof rule.pattern !== 'string' ||
      rule.pattern.length === 0 ||
      rule.pattern.length > 200 ||
      /[\s\u0000-\u001f~^:?[\\]/.test(rule.pattern) ||
      (rule.mode !== 'automatic' && rule.mode !== 'request')
    )
      throw new Error(
        'A branch rule is {pattern, mode: "automatic" | "request"}',
      )
    return { pattern: rule.pattern, mode: rule.mode }
  })
}
