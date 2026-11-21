import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerSandbox, type DockerRunner } from '../../../src/adapters/sandbox/docker.js'

// The sandbox image is always built from Rumba's own Dockerfile, never from a repository Rumba
// works on. The rumba chooses only the Node major version, passed as a build argument.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rumba-image-'))
  await writeFile(path.join(dir, 'Dockerfile'), 'ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-bookworm\n')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const run = { workdir: '/w', command: ['true'], env: {}, timeoutMs: 1000 }

function recording(missing = true): { calls: string[][]; runner: DockerRunner } {
  const calls: string[][] = []
  return {
    calls,
    runner: async (args) => {
      calls.push(args)
      return args[0] === 'image' && missing ? { exitCode: 1, output: 'No such image' } : { exitCode: 0, output: '' }
    },
  }
}

describe('the sandbox image for a Node version', () => {
  it('builds with the version as a build argument and runs the image it built', async () => {
    const { calls, runner } = recording()
    await new DockerSandbox({ dockerfileDir: dir, nodeVersion: '24', runner }).run(run)
    const [inspect, build, started] = calls
    const tag = inspect![2]!
    expect(tag).toMatch(/^rumba-sandbox:node24-[0-9a-f]{12}$/)
    expect(build).toEqual(['build', '--build-arg', 'NODE_VERSION=24', '-t', tag, dir])
    expect(started).toContain(tag)
  })
  it('uses Node 22 when no version is given', async () => {
    const { calls, runner } = recording()
    await new DockerSandbox({ dockerfileDir: dir, runner }).run(run)
    expect(calls[0]![2]).toMatch(/^rumba-sandbox:node22-/)
    expect(calls[1]).toContain('NODE_VERSION=22')
  })
  it('names a different image for another version or a changed Dockerfile, so a stale image is never reused', async () => {
    const tagOf = async (version: string) => {
      const { calls, runner } = recording(false)
      await new DockerSandbox({ dockerfileDir: dir, nodeVersion: version, runner }).run(run)
      return calls[0]![2]!
    }
    const first = await tagOf('24')
    expect(await tagOf('24')).toBe(first)
    expect(await tagOf('22')).not.toBe(first)
    await writeFile(path.join(dir, 'Dockerfile'), 'ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-bookworm\nRUN true\n')
    expect(await tagOf('24')).not.toBe(first)
  })
  it('refuses a version that is not a plain major number, before running docker', async () => {
    const { calls, runner } = recording()
    expect(() => new DockerSandbox({ dockerfileDir: dir, nodeVersion: '24 --build-arg X=1', runner })).toThrow(/Node version/)
    expect(calls).toEqual([])
  })
})
