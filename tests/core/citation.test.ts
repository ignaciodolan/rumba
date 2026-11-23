import { describe, expect, it } from 'vitest'
import { asksAbout, namesCheck } from '../../src/core/citation.js'

describe('namesCheck', () => {
  const files = ['tests/orders/fulfil.test.ts']
  const criterion = 'An order ships the day it is paid'

  it.each([
    ['the base name of a check file', 'The check in fulfil.test.ts is too strict.'],
    ['the base name without its last extension', 'fulfil.test expects the wrong date'],
    ['the base name in another case', 'FULFIL.TEST.TS is wrong'],
    ['three consecutive words of the criterion', 'I do not think it ships the day we say.'],
    ['three consecutive criterion words in another case and spacing', 'An  ORDER\nships late on weekends'],
    ['more than three consecutive criterion words', 'Why must it ship? "the day it is paid" is wrong.'],
    ['the path of a check file with a line number', 'see tests/orders/fulfil.test.ts:12'],
    ['the stem in backticks', 'The assertion in `fulfil.test` is wrong.'],
  ])('is true for an item that names %s', (_what, text) => {
    expect(namesCheck(text, files, criterion)).toBe(true)
  })

  it.each([
    ['nothing of the check', 'Please rename total to subtotal.'],
    ['only two consecutive criterion words', 'An order is fine, it ships fast.'],
    ['three criterion words that are not consecutive in the criterion', 'order day paid'],
    ['criterion words joined into another word', 'shipsthe day it'],
    ['the folder of the check file only', 'tests/orders is a mess'],
    ['another file with the same stem but a different name', 'fulfil.spec.ts'],
  ])('is false for an item that names %s', (_what, text) => {
    expect(namesCheck(text, files, criterion)).toBe(false)
  })

  it('needs a boundary on both sides of a file name: not a letter, a digit or an underscore', () => {
    expect(namesCheck('Please reorder the imports', ['spec/order.rb'], '')).toBe(false)
    expect(namesCheck('the order check is wrong', ['spec/order.rb'], '')).toBe(true)
    expect(namesCheck('order.rb: wrong date', ['spec/order.rb'], '')).toBe(true)
    expect(namesCheck('order_rb and orders and order2', ['spec/order.rb'], '')).toBe(false)
    expect(namesCheck('Please rename total to subtotal, it is wrong.', ['test/a.ts'], '')).toBe(false)
    expect(namesCheck('the a check', ['test/a.ts'], '')).toBe(true)
    expect(namesCheck('myfulfil.test.ts and fulfil.tests', files, '')).toBe(false)
  })

  it('needs all the words, in order, of a criterion shorter than three words', () => {
    expect(namesCheck('the c1 check is wrong', [], 'C1')).toBe(true)
    expect(namesCheck('the c12 check is wrong', [], 'C1')).toBe(false)
    expect(namesCheck('orders ship', [], 'Orders ship')).toBe(true)
    expect(namesCheck('ship orders', [], 'Orders ship')).toBe(false)
  })

  it('takes words as runs of letters and digits, in any script', () => {
    expect(namesCheck('le café ouvre à 8h', [], 'Le café ouvre')).toBe(true)
    expect(namesCheck('an-order-ships today', [], criterion)).toBe(true)
  })

  it('matches nothing for a criterion without words and no files', () => {
    expect(namesCheck('anything at all', [], '—')).toBe(false)
  })
})

describe('asksAbout', () => {
  const files = ['tests/orders/fulfil.test.ts']
  const criterion = 'An order ships the day it is paid'

  it('takes a line comment on one of the check files as naming the check, whatever its text', () => {
    expect(asksAbout({ kind: 'line', text: 'this assertion is wrong', path: 'tests/orders/fulfil.test.ts' }, files, criterion)).toBe(true)
    expect(asksAbout({ kind: 'line', text: 'this assertion is wrong', path: 'src/orders/fulfil.ts' }, files, criterion)).toBe(false)
  })

  it('reads only the text of a review or a comment', () => {
    expect(asksAbout({ kind: 'review', text: 'this assertion is wrong' }, files, criterion)).toBe(false)
    expect(asksAbout({ kind: 'comment', text: 'fulfil.test.ts is wrong' }, files, criterion)).toBe(true)
  })
})
