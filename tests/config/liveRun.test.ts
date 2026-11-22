import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadRumba } from '../../src/config/load.js'

const base = (extra = '', env = '') => `
paths: ["**"]
tracker: { kind: github }
agent: { kind: claude-code }
environment: { kind: docker, up: "docker compose up -d --wait", exec: "docker compose exec -T app", down: "docker compose down -v"${env} }
${extra}
`

let root: string
async function rumbaYml(text: string): Promise<void> {
  await mkdir(path.join(root, '.rumba/shop'), { recursive: true })
  await writeFile(path.join(root, '.rumba/shop/rumba.yml'), text)
}

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'rumba-config-live-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('sandbox.node', () => {
  it('defaults to Node 22', async () => {
    await rumbaYml(base())
    expect((await loadRumba(root, 'shop')).sandbox).toEqual({ nodeVersion: '22' })
  })
  it('takes a major version as a number or a string', async () => {
    await rumbaYml(base('sandbox: { node: 24 }'))
    expect((await loadRumba(root, 'shop')).sandbox).toEqual({ nodeVersion: '24' })
    await rumbaYml(base('sandbox: { node: "26" }'))
    expect((await loadRumba(root, 'shop')).sandbox).toEqual({ nodeVersion: '26' })
  })
  it.each(['latest', '24.1', '24-alpine', '18', '"22; rm -rf /"', '7'])('refuses %s, naming the key', async (value) => {
    await rumbaYml(base(`sandbox: { node: ${value} }`))
    await expect(loadRumba(root, 'shop')).rejects.toThrow(/shop: sandbox\.node/)
  })
})

describe('environment.command_timeout_minutes', () => {
  it('defaults to 10 minutes for docker', async () => {
    await rumbaYml(base())
    expect((await loadRumba(root, 'shop')).environment).toMatchObject({ kind: 'docker', commandTimeoutMinutes: 10 })
  })
  it('can be set per rumba', async () => {
    await rumbaYml(base('', ', command_timeout_minutes: 20'))
    expect((await loadRumba(root, 'shop')).environment).toMatchObject({ commandTimeoutMinutes: 20 })
  })
  it('must be a positive whole number of minutes', async () => {
    await rumbaYml(base('', ', command_timeout_minutes: 0'))
    await expect(loadRumba(root, 'shop')).rejects.toThrow(/shop: environment\.command_timeout_minutes/)
  })
})
