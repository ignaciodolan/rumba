import picomatch from 'picomatch'

const matcher = (globs: string[]) => picomatch(globs, { dot: true })

/**
 * Always protected: Rumba's own folder, the repository's GitHub config (workflows run with
 * repository secrets), and any `.env`, which docker compose reads when the environment starts.
 */
const ALWAYS_PROTECTED = ['.rumba/**', '.github/**', '.env']

/** Changed files that match a protected glob, or one of ALWAYS_PROTECTED. */
export function protectedViolations(changed: string[], protectedGlobs: string[]): string[] {
  // A glob without a slash matches by file name at any depth; one with a slash matches the full path.
  const matchers = [...ALWAYS_PROTECTED, ...protectedGlobs].map((g) =>
    picomatch(g, { dot: true, nocase: true, basename: !g.includes('/') }))
  return changed.filter((f) => matchers.some((m) => m(f)))
}

/** Check files whose hash differs from the recorded one, or that are gone. */
export function changedChecks(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(before).filter((file) => after[file] !== before[file])
}

/** Changed files outside the rumba's paths, ignoring check files. Empty when no paths are set. */
export function outsideScope(changed: string[], paths: string[], checkFiles: string[]): string[] {
  if (paths.length === 0) return []
  const inScope = matcher(paths)
  const checks = new Set(checkFiles)
  return changed.filter((f) => !inScope(f) && !checks.has(f))
}
