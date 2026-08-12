import { describe, expect, test } from 'bun:test'
import { inferPredictTask } from './predictTask.js'

describe('inferPredictTask', () => {
  test('any string label is unambiguous classification', () => {
    expect(inferPredictTask(['spam', 'not_spam', 'spam'])).toBe('classify')
  })

  test('binary 0/1 flags read as classification', () => {
    const labels = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0 : 1))
    expect(inferPredictTask(labels)).toBe('classify')
  })

  test('small set of integer class IDs across many samples reads as classification', () => {
    const labels = Array.from({ length: 60 }, (_, i) => i % 3) // classes 0,1,2
    expect(inferPredictTask(labels)).toBe('classify')
  })

  test('near-unique integer values (e.g. whole-dollar prices) read as regression', () => {
    const labels = [150000, 210000, 305000, 98000, 415000, 260000, 175000, 330000]
    expect(inferPredictTask(labels)).toBe('regress')
  })

  test('fractional numeric labels read as regression', () => {
    const labels = [12.5, 88.3, 45.1, 99.9, 10.2]
    expect(inferPredictTask(labels)).toBe('regress')
  })

  test('empty labels default to classify without throwing', () => {
    expect(inferPredictTask([])).toBe('classify')
  })
})
