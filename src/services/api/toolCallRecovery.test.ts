import { describe, expect, test } from 'bun:test'
import { recoverToolCallFromText } from './toolCallRecovery.js'

describe('recoverToolCallFromText', () => {
  test('extracts a call wrapped in a self-invented tag (the actual VibeThinker failure mode)', () => {
    const text =
      '<think>I should call the tool.</think><advice>\n  {"name": "get_stock_price", "arguments": {"symbol": "AAPL"}}\n</advice>'
    const result = recoverToolCallFromText(text, ['get_stock_price'])
    expect(result).toEqual({ name: 'get_stock_price', arguments: { symbol: 'AAPL' } })
  })

  test('extracts a call with no wrapping tag at all', () => {
    const text = 'Sure, calling it now: {"name": "search", "arguments": {"query": "weather"}}'
    const result = recoverToolCallFromText(text, ['search'])
    expect(result).toEqual({ name: 'search', arguments: { query: 'weather' } })
  })

  test('extracts the correctly-tagged form too (not tag-specific, format-generic)', () => {
    const text = '<tool_call>{"name": "search", "arguments": {"query": "x"}}</tool_call>'
    const result = recoverToolCallFromText(text, ['search'])
    expect(result).toEqual({ name: 'search', arguments: { query: 'x' } })
  })

  test('returns null when there is no JSON at all', () => {
    expect(recoverToolCallFromText('Here is my answer in plain prose.', ['search'])).toBeNull()
  })

  test('returns null when JSON is present but name is not an available tool (avoids false positives on unrelated JSON)', () => {
    const text = 'Example config: {"name": "totally_unrelated_thing", "arguments": {}}'
    expect(recoverToolCallFromText(text, ['search', 'get_stock_price'])).toBeNull()
  })

  test('returns null when JSON has "name" but no "arguments" key', () => {
    const text = '{"name": "search"}'
    expect(recoverToolCallFromText(text, ['search'])).toBeNull()
  })

  test('returns null for empty text', () => {
    expect(recoverToolCallFromText('', ['search'])).toBeNull()
  })

  test('returns null when no tools are available (nothing to validate against)', () => {
    const text = '{"name": "search", "arguments": {}}'
    expect(recoverToolCallFromText(text, [])).toBeNull()
  })

  test('does not get confused by braces nested inside a string argument value', () => {
    const text =
      '{"name": "run_code", "arguments": {"code": "if (x) { return {a: 1} }"}}'
    const result = recoverToolCallFromText(text, ['run_code'])
    expect(result).toEqual({
      name: 'run_code',
      arguments: { code: 'if (x) { return {a: 1} }' },
    })
  })

  test('does not get confused by escaped quotes inside a string argument value', () => {
    const text = String.raw`{"name": "say", "arguments": {"text": "she said \"hi\""}}`
    const result = recoverToolCallFromText(text, ['say'])
    expect(result).toEqual({ name: 'say', arguments: { text: 'she said "hi"' } })
  })

  test('picks the LAST valid match when the model second-guesses itself in visible reasoning', () => {
    const text = `
      Maybe I should call search: {"name": "search", "arguments": {"query": "first idea"}}
      Actually, get_stock_price is better: {"name": "get_stock_price", "arguments": {"symbol": "AAPL"}}
    `
    const result = recoverToolCallFromText(text, ['search', 'get_stock_price'])
    expect(result).toEqual({ name: 'get_stock_price', arguments: { symbol: 'AAPL' } })
  })

  test('ignores an earlier match with an invalid tool name and still finds a later valid one', () => {
    const text = `
      {"name": "made_up_tool", "arguments": {}}
      {"name": "search", "arguments": {"query": "real"}}
    `
    const result = recoverToolCallFromText(text, ['search'])
    expect(result).toEqual({ name: 'search', arguments: { query: 'real' } })
  })

  test('handles malformed JSON gracefully (unterminated object) without throwing', () => {
    const text = '{"name": "search", "arguments": {'
    expect(() => recoverToolCallFromText(text, ['search'])).not.toThrow()
    expect(recoverToolCallFromText(text, ['search'])).toBeNull()
  })

  test('arguments can be any JSON value type, not just an object', () => {
    const text = '{"name": "noop", "arguments": null}'
    const result = recoverToolCallFromText(text, ['noop'])
    expect(result).toEqual({ name: 'noop', arguments: null })
  })
})
