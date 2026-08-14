import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  test('produces exactly 5 example turns (10 messages: 5 user, 5 assistant)', () => {
    expect(messages).toHaveLength(10)
    expect(messages.filter(m => m.role === 'user')).toHaveLength(5)
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(5)
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

  test('example 3 is a file-read routed to Read with a file_path arg — targets the Grep-mis-route / hallucinated-file-contents failure (session 29)', () => {
    const userMsg = messages[4]
    const assistantMsg = messages[5]
    expect(typeof userMsg?.content).toBe('string')
    expect((userMsg?.content as string).toLowerCase()).toContain('read the file')
    const call = assistantMsg?.tool_calls?.[0]
    expect(call?.function.name).toBe('Read')
    const args = JSON.parse(call?.function.arguments ?? '{}')
    expect(typeof args.file_path).toBe('string')
    expect(args.file_path.length).toBeGreaterThan(0)
    // The demonstrated call carries ONLY file_path — no stray Grep-style
    // args (pattern/-A/-B/-i), which is the exact malformation being corrected.
    expect(Object.keys(args)).toEqual(['file_path'])
  })

  test('example 4 is trivial arithmetic with NO tool call — targets the over-delegation failure mode directly', () => {
    const userMsg = messages[6]
    const assistantMsg = messages[7]
    expect(userMsg?.content).toBe('What is 12 * 7?')
    expect(assistantMsg?.tool_calls).toBeUndefined()
    expect(typeof assistantMsg?.content).toBe('string')
    expect((assistantMsg?.content as string).length).toBeGreaterThan(0)
  })

  test('example 5 (last, closest to the real conversation) is a bare greeting with NO tool call — targets the session-opener Skill-hallucination failure (session 29)', () => {
    const userMsg = messages[8]
    const assistantMsg = messages[9]
    expect(userMsg?.content).toBe('hi')
    expect(assistantMsg?.tool_calls).toBeUndefined()
    expect(typeof assistantMsg?.content).toBe('string')
    expect((assistantMsg?.content as string).length).toBeGreaterThan(0)
  })

  test('no few-shot example reuses a HOLDOUT routing-eval case prompt verbatim (context-leak guard — tuning-split overlap is allowed, e.g. example 3 deliberately mirrors routing-distractor-1)', () => {
    // Read routingCases.ts as raw text rather than importing it as a module:
    // scripts/eval/ sits outside tsconfig.json's "rootDir": "./src", so a
    // real `import` here breaks the typecheck baseline (TS6059) even though
    // it works fine at runtime under bun. A plain substring check against
    // the file's own HOLDOUT SPLIT section marker (routingCases.ts's own
    // header comment) needs no module resolution at all, and is exactly as
    // effective for this guard's actual job — did any few-shot example's
    // literal text leak into the holdout section — as parsing every case's
    // `prompt` field individually would be.
    const routingCasesSource = readFileSync(
      resolve(import.meta.dir, '../../../scripts/eval/routingCases.ts'),
      'utf8',
    )
    const holdoutMarker = '// HOLDOUT SPLIT'
    const holdoutStart = routingCasesSource.indexOf(holdoutMarker)
    expect(holdoutStart).toBeGreaterThan(-1) // fails loudly if routingCases.ts's own structure ever changes
    const holdoutSection = routingCasesSource.slice(holdoutStart)
    // Exact-match against each case's actual `prompt:` string value, not a
    // blunt substring search over the whole section — a plain .includes()
    // false-positived on the short greeting example ("hi" is a substring of
    // countless unrelated words in 30 cases' worth of prose). All prompt
    // values in this file are single-quoted with no embedded quotes
    // (verified before writing this regex, not assumed).
    const holdoutPrompts = new Set(
      [...holdoutSection.matchAll(/prompt:\s*\n?\s*'([^']*)'/g)].map(m => m[1]),
    )
    expect(holdoutPrompts.size).toBeGreaterThan(0) // fails loudly if the regex stops matching

    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        expect(holdoutPrompts.has(m.content)).toBe(false)
      }
    }
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
