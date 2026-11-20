import { describe, expect, it } from 'vitest'
import { SANDBOX_IMAGE, dockerArgs } from '../../../src/adapters/sandbox/docker.js'

describe('dockerArgs', () => {
  it('builds docker arguments with only the given env', () => {
    expect(dockerArgs({ workdir: '/w', command: ['echo', 'hi'], env: { A: '1' }, image: 'img' }))
      .toEqual(['run', '--rm', '-v', '/w:/work', '-w', '/work', '-e', 'A=1', 'img', 'echo', 'hi'])
  })

  it('adds the user and the container name when given', () => {
    expect(dockerArgs({ workdir: '/w', command: ['true'], env: {}, image: 'img', user: '501:20', name: 'rumba-1' }))
      .toEqual(['run', '--rm', '--user', '501:20', '--name', 'rumba-1', '-v', '/w:/work', '-w', '/work', 'img', 'true'])
  })

  it('names the local sandbox image', () => {
    expect(SANDBOX_IMAGE).toBe('rumba-sandbox:local')
  })
})
