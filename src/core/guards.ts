import picomatch from 'picomatch'

const matcher = (globs: string[]) => picomatch(globs, { dot: true })

/** Changed files that match a protected glob. '.rumba/**' is always protected. */
export function protectedViolations(changed: string[], protectedGlobs: string[]): string[] {
  const isProtected = matcher(['.rumba/**', ...protectedGlobs])
  return changed.filter((f) => isProtected(f))
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
