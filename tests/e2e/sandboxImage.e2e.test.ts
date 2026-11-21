import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandbox } from '../../src/adapters/sandbox/docker.js'
import { SANDBOX_DIR } from '../../src/wiring.js'

// Builds Rumba's sandbox image for Node 24 and runs it the way Rumba runs an agent: as the
// calling user's uid, with every capability dropped. The package-manager steps need network
// access to the npm registry, as the agent's own installs do.

function dockerUp(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}
const dockerAvailable = dockerUp()

describe(dockerAvailable ? 'sandbox image' : 'sandbox image (skipped: Docker is not available)', () => {
  let work: string
  const sandbox = new DockerSandbox({ dockerfileDir: SANDBOX_DIR, nodeVersion: '24' })
  const sh = (script: string) => sandbox.run({ workdir: work, command: ['sh', '-c', script], env: {}, timeoutMs: 30 * 60_000 })

  beforeAll(async () => {
    work = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-sandbox-e2e-')))
    await writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true, packageManager: 'pnpm@9.15.9' }))
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  it.skipIf(!dockerAvailable)('runs the Node version the rumba chose', async () => {
    const r = await sh('node --version')
    expect(r).toMatchObject({ exitCode: 0 })
    expect(r.output.trim()).toMatch(/^v24\./)
  }, 40 * 60_000)

  it.skipIf(!dockerAvailable)('lets the agent use npm and npx as a non-root user', async () => {
    const r = await sh('id -u && npm cache verify >/dev/null && npx --yes semver@7.6.3 1.2.3')
    expect(r.output).not.toMatch(/EACCES|chown/)
    expect(r.exitCode).toBe(0)
    expect(r.output.trim().split('\n').at(-1)).toBe('1.2.3')
  }, 10 * 60_000)

  it.skipIf(!dockerAvailable)('has pnpm through corepack, at the version the project pins', async () => {
    const r = await sh('pnpm --version')
    expect(r.output).not.toMatch(/EACCES/)
    expect(r.exitCode).toBe(0)
    expect(r.output.trim().split('\n').at(-1)).toBe('9.15.9')
  }, 10 * 60_000)

  it.skipIf(!dockerAvailable)('keeps the pnpm store out of the working copy, so it is never committed', async () => {
    const r = await sh('pnpm add is-odd@3.0.1 >/dev/null 2>&1; echo "exit=$?"; ls -A')
    expect(r.output).toContain('exit=0')
    expect(r.output).toContain('node_modules')
    expect(r.output).not.toContain('.pnpm-store')
  }, 10 * 60_000)

  it.skipIf(!dockerAvailable)('keeps the store of a current pnpm out of the working copy too', async () => {
    const r = await sh([
      'mkdir -p current && cd current',
      `printf '%s' '${JSON.stringify({ name: 'probe12', version: '1.0.0', private: true, packageManager: 'pnpm@12.4.1' })}' > package.json`,
      'pnpm add is-odd@3.0.1 >/dev/null 2>&1; echo "exit=$?"; find /work -maxdepth 4 -name .pnpm-store | wc -l',
    ].join(' && '))
    const lines = r.output.trim().split('\n')
    expect(lines).toContain('exit=0')
    expect(lines.at(-1)?.trim()).toBe('0')
  }, 10 * 60_000)
})
