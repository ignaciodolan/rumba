/**
 * Whether a failed command died of the machine rather than of the code: the out-of-memory
 * killer, a full disk, killed test workers, or a timeout. Returns a short reason, or
 * undefined for an ordinary failure. What Docker reported (`dockerOom`) counts first; the
 * exit code next; the output last.
 */
export function classifyInfrastructure(o: { exitCode: number; output: string; dockerOom: boolean }): string | undefined {
  if (o.exitCode === 0) return undefined
  if (o.dockerOom) return 'Docker reported that a container ran out of memory while the command ran'
  if (o.exitCode === 137) return 'the command was killed (exit 137: SIGKILL, usually the out-of-memory killer)'
  if (o.exitCode === 124) return 'the command timed out (if it needs longer, raise environment.command_timeout_minutes)'
  // ENOSPC is also what Node reports when it runs out of file watchers; that is not the disk.
  if (/\bENOSPC\b|no space left on device/i.test(o.output) && !/limit for number of file watchers/i.test(o.output)) return 'the disk is full (no space left on device)'
  if (/Worker (exited|terminated) unexpectedly|ERR_IPC_CHANNEL_CLOSED|Channel closed|signal: '?SIGKILL'?|^\s*Killed\s*$/m.test(o.output)) {
    return 'test workers were killed, usually by the out-of-memory killer'
  }
  return undefined
}
