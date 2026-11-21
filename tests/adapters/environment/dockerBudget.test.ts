import { describe, expect, it } from 'vitest'
import { DockerEnvironment } from '../../../src/adapters/environment/docker.js'

// How long each host command may run: the rumba's command limit, and never past the time the
// ticket has left. Taking the environment down always gets the full command limit, so a
// ticket that ran out of time still leaves no containers running.

const cfg = { up: 'up', exec: 'exec', down: 'down' }
const trusted = { trustedCheckout: async () => '/t', verifyTrusted: async () => {}, cleanup: async () => {} }

function recorder() {
  const seen: { command: string; timeoutMs: number }[] = []
  return { seen, run: async (command: string, o: { timeoutMs: number }) => { seen.push({ command: command.split(' ')[0]!, timeoutMs: o.timeoutMs }); return { exitCode: 0, output: '' } } }
}

describe('DockerEnvironment command limits', () => {
  it('gives every command the configured limit when the ticket has more time than that', async () => {
    const { seen, run } = recorder()
    const env = new DockerEnvironment({ ...cfg, trusted, run, timeoutMs: 20 * 60_000 })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after', timeoutMs: 60 * 60_000 }, '/w')
    await env.runCommand(h, 'npm test'); await env.down(h)
    expect(seen).toEqual([
      { command: 'up', timeoutMs: 20 * 60_000 }, { command: 'exec', timeoutMs: 20 * 60_000 }, { command: 'down', timeoutMs: 20 * 60_000 },
    ])
  })
  it('stops up and every check when the ticket runs out of time, but still gives down its full limit', async () => {
    const { seen, run } = recorder()
    const env = new DockerEnvironment({ ...cfg, trusted, run, timeoutMs: 20 * 60_000 })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after', timeoutMs: 5 * 60_000 }, '/w')
    await env.runCommand(h, 'npm test'); await env.down(h)
    const [up, exec, down] = seen
    expect(up!.timeoutMs).toBeLessThanOrEqual(5 * 60_000); expect(up!.timeoutMs).toBeGreaterThan(4 * 60_000)
    expect(exec!.timeoutMs).toBeLessThanOrEqual(5 * 60_000)
    expect(down!.timeoutMs).toBe(20 * 60_000)
  })
  it('never passes a limit of zero, which would mean no limit at all', async () => {
    const { seen, run } = recorder()
    const env = new DockerEnvironment({ ...cfg, trusted, run, timeoutMs: 20 * 60_000 })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after', timeoutMs: 1 }, '/w')
    await new Promise((r) => setTimeout(r, 5))
    await env.runCommand(h, 'npm test')
    for (const s of seen) expect(s.timeoutMs).toBeGreaterThanOrEqual(1000)
  })
})
