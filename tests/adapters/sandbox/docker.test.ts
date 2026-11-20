import { describe, expect, it } from 'vitest'
import { DockerSandbox, type DockerRunner, SANDBOX_IMAGE, dockerArgs, dockerRunner } from '../../../src/adapters/sandbox/docker.js'

type RunnerCall = { args: string[]; env: Record<string, string> }

function recordingRunner(calls: RunnerCall[], respond: (args: string[]) => Promise<{ exitCode: number; output: string }>): DockerRunner {
  return (args, o) => {
    calls.push({ args, env: o.env })
    return respond(args)
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('dockerArgs', () => {
  it('builds docker arguments with only the names of the given env', () => {
    expect(dockerArgs({ workdir: '/w', command: ['echo', 'hi'], env: { A: '1' }, image: 'img' }))
      .toEqual(['run', '--rm', '-v', '/w:/work', '-w', '/work', '-e', 'A', 'img', 'echo', 'hi'])
  })

  it('never puts an env value in the arguments', () => {
    const args = dockerArgs({ workdir: '/w', command: ['true'], env: { ANTHROPIC_API_KEY: 'sk-secret-value', B: 'other-secret' }, image: 'img' })
    for (const arg of args) {
      expect(arg).not.toContain('sk-secret-value'); expect(arg).not.toContain('other-secret')
    }
  })

  it('adds the user and the container name when given', () => {
    expect(dockerArgs({ workdir: '/w', command: ['true'], env: {}, image: 'img', user: '501:20', name: 'rumba-1' }))
      .toEqual(['run', '--rm', '--user', '501:20', '--name', 'rumba-1', '-v', '/w:/work', '-w', '/work', 'img', 'true'])
  })

  it('adds the hardening flags when asked', () => {
    expect(dockerArgs({ workdir: '/w', command: ['true'], env: {}, image: 'img', harden: true }))
      .toEqual(['run', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-v', '/w:/work', '-w', '/work', 'img', 'true'])
  })

  it('names the local sandbox image', () => {
    expect(SANDBOX_IMAGE).toBe('rumba-sandbox:local')
  })
})

describe('DockerSandbox', () => {
  it('gives env values to the docker client through its environment, not its arguments', async () => {
    const calls: RunnerCall[] = []
    const sandbox = new DockerSandbox({ image: 'img', runner: recordingRunner(calls, async () => ({ exitCode: 0, output: 'ok' })) })
    const result = await sandbox.run({ workdir: '/w', command: ['true'], env: { ANTHROPIC_API_KEY: 'sk-secret' }, timeoutMs: 1000 })
    expect(result).toEqual({ exitCode: 0, output: 'ok' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.env).toEqual({ ANTHROPIC_API_KEY: 'sk-secret' })
    expect(calls[0]!.args.join(' ')).not.toContain('sk-secret')
    expect(calls[0]!.args).toContain('ANTHROPIC_API_KEY')
    expect(calls[0]!.args).toContain('--cap-drop=ALL'); expect(calls[0]!.args).toContain('--security-opt=no-new-privileges')
  })

  it('kills the named container on timeout and returns 124 with the output so far', async () => {
    const calls: RunnerCall[] = []
    let finishRun: (r: { exitCode: number; output: string }) => void = () => {}
    const runner = recordingRunner(calls, async (args) => {
      if (args[0] === 'run') return new Promise((resolve) => { finishRun = resolve })
      finishRun({ exitCode: 137, output: 'started' })
      return { exitCode: 0, output: '' }
    })
    const result = await new DockerSandbox({ image: 'img', runner }).run({ workdir: '/w', command: ['sleep', '60'], env: {}, timeoutMs: 20 })
    expect(result).toEqual({ exitCode: 124, output: 'started' })
    const name = valueAfter(calls[0]!.args, '--name')
    expect(name).toMatch(/^rumba-/)
    expect(calls[1]!.args).toEqual(['kill', name])
  })

  it('still reports the timeout when the kill fails', async () => {
    const calls: RunnerCall[] = []
    const runner = recordingRunner(calls, async (args) => {
      if (args[0] === 'run') return new Promise(() => {})
      throw new Error('kill failed')
    })
    const sandbox = new DockerSandbox({ image: 'img', runner, killGraceMs: 20 })
    const result = await sandbox.run({ workdir: '/w', command: ['sleep', '60'], env: {}, timeoutMs: 20 })
    expect(result.exitCode).toBe(124)
    expect(calls[1]!.args[0]).toBe('kill')
  })
})

describe('DockerSandbox image', () => {
  const run = { workdir: '/w', command: ['true'], env: {}, timeoutMs: 1000 }
  const ok = { exitCode: 0, output: '' }

  it('checks the image once, before the first run, and not again', async () => {
    const calls: RunnerCall[] = []
    const sandbox = new DockerSandbox({ image: 'img', dockerfileDir: '/pkg/sandbox', runner: recordingRunner(calls, async () => ok) })
    await sandbox.run(run); await sandbox.run(run)
    expect(calls.map((c) => c.args[0])).toEqual(['image', 'run', 'run'])
    expect(calls[0]!.args).toEqual(['image', 'inspect', 'img'])
  })

  it('checks nothing when the sandbox is never used', () => {
    const calls: RunnerCall[] = []
    new DockerSandbox({ image: 'img', dockerfileDir: '/pkg/sandbox', runner: recordingRunner(calls, async () => ok) })
    expect(calls).toEqual([])
  })

  it('builds a missing image from the folder before the first run', async () => {
    const calls: RunnerCall[] = []
    const runner = recordingRunner(calls, async (args) => (args[0] === 'image' ? { exitCode: 1, output: 'No such image' } : ok))
    await new DockerSandbox({ image: 'img', dockerfileDir: '/pkg/sandbox', runner }).run(run)
    expect(calls.map((c) => c.args)).toEqual([['image', 'inspect', 'img'], ['build', '-t', 'img', '/pkg/sandbox'], expect.arrayContaining(['run', 'img'])])
  })

  it('throws on a failed build, and tries again on the next run', async () => {
    const calls: RunnerCall[] = []
    let builds = 0
    const runner = recordingRunner(calls, async (args) => {
      if (args[0] === 'image') return { exitCode: 1, output: '' }
      if (args[0] === 'build') return ++builds === 1 ? { exitCode: 1, output: 'no space left on device' } : ok
      return ok
    })
    const sandbox = new DockerSandbox({ image: 'img', dockerfileDir: '/pkg/sandbox', runner })
    await expect(sandbox.run(run)).rejects.toThrow(/docker build -t img failed:\nno space left on device/)
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false)
    await expect(sandbox.run(run)).resolves.toEqual(ok)
    expect(calls.map((c) => c.args[0])).toEqual(['image', 'build', 'image', 'build', 'run'])
  })

  it('checks no image without a dockerfileDir', async () => {
    const calls: RunnerCall[] = []
    await new DockerSandbox({ image: 'img', runner: recordingRunner(calls, async () => ok) }).run(run)
    expect(calls.map((c) => c.args[0])).toEqual(['run'])
  })
})

describe('dockerRunner', () => {
  it('returns the start failure message when the docker binary cannot start', async () => {
    const result = await dockerRunner('rumba-no-such-docker-binary')(['version'], { env: {} })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('ENOENT')
  })

  it('passes env values to the client process', async () => {
    const result = await dockerRunner('sh')(['-c', 'printf %s "$RUMBA_TEST_VALUE"'], { env: { RUMBA_TEST_VALUE: 'from-env' } })
    expect(result).toEqual({ exitCode: 0, output: 'from-env' })
  })
})
