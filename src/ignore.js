import picomatch from 'picomatch'

/**
 * Paths left out of every walk unless the caller says otherwise.
 *
 * `.fim` is the metadata directory of the `fim` tool, which the first version
 * of this command had hard-coded. `.git` was not excluded at all, so listing a
 * working copy pulled in the whole object database.
 */
export const DEFAULT_IGNORES = ['.git', '.fim', 'node_modules']

/**
 * Expands one user pattern into the globs that implement it.
 *
 * A pattern without a separator matches at any depth, the way .gitignore
 * behaves, so `--ignore node_modules` also covers `packages/x/node_modules`. A
 * pattern with a separator stays anchored at the scanned root. Both forms also
 * match everything below a directory they hit.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandPattern (pattern) {
  const clean = pattern
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')

  if (!clean) {
    return []
  }

  const bases = clean.includes('/') ? [clean] : [clean, `**/${clean}`]

  return bases.flatMap((base) => [base, `${base}/**`])
}

/**
 * Builds the predicate used to skip paths while walking.
 *
 * @param {string[]} [patterns] Extra patterns supplied by the caller.
 * @param {{ useDefaults?: boolean }} [options]
 * @returns {((relativePath: string) => boolean) & { patterns: string[] }}
 */
export function createIgnoreMatcher (patterns = [], { useDefaults = true } = {}) {
  const requested = [
    ...(useDefaults ? DEFAULT_IGNORES : []),
    ...patterns
  ]

  const globs = requested.flatMap(expandPattern)

  if (globs.length === 0) {
    const never = () => false
    never.patterns = []
    return never
  }

  const isMatch = picomatch(globs, { dot: true })

  /**
   * @param {string} relativePath POSIX path relative to the scanned root.
   * @returns {boolean}
   */
  const matcher = (relativePath) => isMatch(relativePath)

  matcher.patterns = requested

  return matcher
}
