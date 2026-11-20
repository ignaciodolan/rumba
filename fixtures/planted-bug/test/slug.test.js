import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.js'

test('joins words with hyphens', () => {
  assert.equal(slugify('a b c'), 'a-b-c')
})

test('trims and collapses whitespace', () => {
  assert.equal(slugify('  many   spaces  '), 'many-spaces')
})
