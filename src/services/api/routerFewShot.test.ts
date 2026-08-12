import { describe, expect, test } from 'bun:test'
import {
  buildRouterFewShotMessages,
  insertRouterFewShotMessages,
  shouldApplyRouterFewShot,
} from './routerFewShot.js'

describe('shouldApplyRouterFewShot', () => {
  test('true only when tools are present, the base URL is local, and the model is not tool-call-recovery-listed', () => {
    expect(shouldApplyRouterFewShot('http://localhost:11434/v1', false, true)).toBe(true)
    expect(shouldApplyRouterFewShot('http://127.0.0.1:11434/v1', false, true)).toBe(true)
  })

  test('false when no tools are offered this turn — even on a local URL with a non-recovery model', () => {
    expect(shouldApplyRouterFewShot('http://localhost:11434/v1', false, false)).toBe(false)
  })

  test('false for a remote/cloud base URL, even with tools present', () => {
    expect(shouldApplyRouterFewShot('https://api.openai.com/v1', false, true)).toBe(false)
  })

  test('false when baseUrl is undefined', () => {
    expect(shouldApplyRouterFewShot(undefined, false, true)).toBe(false)
  })

  test('false for a tool-call-recovery-listed model (e.g. VibeThinker) even on a local URL with tools present', () => {
    expect(shouldApplyRouterFewShot('http://localhost:11434/v1', true, true)).toBe(false)
  })
})

describe('buildRouterFewShotMessages', () => {
  const messages = buildRouterFewShotMessages()

  test('produces exactly 3 example turns (6 messages: 3 user, 3 assistant)', () => {
    expect(messages).toHaveLength(6)
    expect(messages.filter(m => m.role === 'user')).toHaveLength(3)
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(3)
  })

  test('every user message is immediately followed by an assistant message', () => {
    for (let i = 0; i < messages.length; i += 2) {
      expect(messages[i]?.role).toBe('user')
      expect(messages[i + 1]?.role).toBe('assistant')
    }
  })

  test('example 1 is a table question routed to DataAnalyze with a valid operation:"question" payload', () => {
    const assistantMsg = messages[1]
    expect(assistantMsg?.tool_calls).toHaveLength(1)
    const call = assistantMsg?.tool_calls?.[0]
    expect(call?.function.name).toBe('DataAnalyze')
    const args = JSON.parse(call?.function.arguments ?? '{}')
    expect(args.operation).toBe('question')
    expect(args.table.columns).toEqual(['Name', 'Score'])
    expect(args.table.rows).toHaveLength(3)
    expect(typeof args.question).toBe('string')
  })

  test('example 2 is multi-digit math routed to AskMathModel', () => {
    const assistantMsg = messages[3]
    const call = assistantMsg?.tool_calls?.[0]
    expect(call?.function.name).toBe('AskMathModel')
    const args = JSON.parse(call?.function.arguments ?? '{}')
    expect(typeof args.problem).toBe('string')
    expect(args.problem.length).toBeGreaterThan(0)
  })

  test('example 3 (last, closest to the real conversation) is trivial arithmetic with NO tool call — targets the over-delegation failure mode directly', () => {
    const userMsg = messages[4]
    const assistantMsg = messages[5]
    expect(userMsg?.content).toBe('What is 12 * 7?')
    expect(assistantMsg?.tool_calls).toBeUndefined()
    expect(typeof assistantMsg?.content).toBe('string')
    expect((assistantMsg?.content as string).length).toBeGreaterThan(0)
  })

  test('every tool_calls id is unique and every JSON arguments string parses cleanly', () => {
    const ids = new Set<string>()
    for (const m of messages) {
      for (const call of m.tool_calls ?? []) {
        expect(ids.has(call.id)).toBe(false)
        ids.add(call.id)
        expect(() => JSON.parse(call.function.arguments)).not.toThrow()
      }
    }
  })
})

describe('insertRouterFewShotMessages', () => {
  test('splices the few-shot examples right after a leading system message', () => {
    const input = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'real question' },
    ]
    const result = insertRouterFewShotMessages(input)

    expect(result[0]?.role).toBe('system')
    expect(result[1]?.role).toBe('user') // first few-shot example
    expect(result.at(-1)).toEqual(input[1]) // the real conversation is preserved, at the end
    expect(result).toHaveLength(input.length + buildRouterFewShotMessages().length)
  })

  test('inserts at the start when there is no leading system message', () => {
    const input = [{ role: 'user' as const, content: 'real question, no system message' }]
    const result = insertRouterFewShotMessages(input)

    expect(result[0]?.role).toBe('user')
    expect(result[0]).toEqual(buildRouterFewShotMessages()[0])
    expect(result.at(-1)).toEqual(input[0])
  })

  test('does not mutate the input array', () => {
    const input = [{ role: 'user' as const, content: 'hi' }]
    const originalLength = input.length
    insertRouterFewShotMessages(input)
    expect(input).toHaveLength(originalLength)
  })

  test('handles an empty input array without throwing', () => {
    const result = insertRouterFewShotMessages([])
    expect(result).toHaveLength(buildRouterFewShotMessages().length)
  })
})
