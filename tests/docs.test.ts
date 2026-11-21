import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The repository is public. Its text names no person, no customer, and not the nickname of the
// assistant that wrote the design.

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
  .filter((f) => /\.(md|ts|yml|yaml|json)$/.test(f) && f !== 'package-lock.json' && f !== 'tests/docs.test.ts')

describe('public wording', () => {
  it.each([[/\bbiggie\b/i, 'the assistant nickname'], [/customers can use it without paying/i, 'the reason given for open source']])('no tracked file contains %s (%s)', (pattern) => {
    const hits = tracked.filter((f) => pattern.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })
})
