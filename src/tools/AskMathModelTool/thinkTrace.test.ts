import { describe, expect, test } from 'bun:test'
import { stripThinkTrace } from './thinkTrace.js'

describe('stripThinkTrace', () => {
  test('extracts the final answer after a cleanly-closed think trace', () => {
    const result = stripThinkTrace('<think>working it out...</think>\nThe answer is 42.')
    expect(result).toEqual({ answer: 'The answer is 42.', truncated: false })
  })

  test('handles text with no think tag at all', () => {
    const result = stripThinkTrace('The answer is 42.')
    expect(result).toEqual({ answer: 'The answer is 42.', truncated: true })
  })

  test('flags a never-closed think tag as truncated and returns the raw text', () => {
    const result = stripThinkTrace('<think>still reasoning and ran out of budget')
    expect(result.truncated).toBe(true)
    expect(result.answer).toContain('still reasoning')
  })

  test('flags a cleanly-closed but empty-after trace as truncated', () => {
    const result = stripThinkTrace('<think>reasoning...</think>')
    expect(result.truncated).toBe(true)
  })

  test('handles empty input without throwing', () => {
    const result = stripThinkTrace('')
    expect(result).toEqual({ answer: '', truncated: false })
  })

  test('trims surrounding whitespace from the extracted answer', () => {
    const result = stripThinkTrace('<think>x</think>   \n  42  \n  ')
    expect(result.answer).toBe('42')
  })
})
