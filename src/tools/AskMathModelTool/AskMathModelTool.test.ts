import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { AskMathModelTool } from './AskMathModelTool.js'

type FetchType = typeof globalThis.fetch

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Minimal fake context — AskMathModelTool.call only reads abortController.
function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

test('mocked: sends the problem to the configured math model endpoint and strips the think trace', async () => {
  let requestBody: Record<string, unknown> | undefined
  let requestUrl: string | undefined

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '<think>working through the algebra...</think>\nx = 4',
            },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const result = await AskMathModelTool.call(
    { problem: 'Solve for x: 2x + 3 = 11' },
    fakeContext(),
    )

  expect(requestUrl).toContain('/chat/completions')
  expect(requestBody?.stream).toBe(false)
  expect((requestBody?.messages as Array<{ content: string }>)[0]?.content).toBe(
    'Solve for x: 2x + 3 = 11',
  )
  expect(result.data.answer).toBe('x = 4')
  expect(result.data.truncated).toBe(false)
})

test('mocked: flags a never-closed think trace as truncated', async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '<think>still going, ran out of budget' } }],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const result = await AskMathModelTool.call(
    { problem: 'A hard problem' },
    fakeContext(),
    )

  expect(result.data.truncated).toBe(true)
})

test('mocked: mapToolResultToToolResultBlockParam prefixes a warning when truncated', () => {
  const block = AskMathModelTool.mapToolResultToToolResultBlockParam(
    { answer: 'partial reasoning...', truncated: true, durationMs: 1000 },
    'tool_1',
  )
  expect(block.content).toContain('may be incomplete')
  expect(block.content).toContain('partial reasoning...')
})

test('mocked: mapToolResultToToolResultBlockParam returns the answer plainly when not truncated', () => {
  const block = AskMathModelTool.mapToolResultToToolResultBlockParam(
    { answer: 'x = 4', truncated: false, durationMs: 1000 },
    'tool_1',
  )
  expect(block.content).toBe('x = 4')
})

test('mocked: propagates an error when the HTTP response is not ok', async () => {
  globalThis.fetch = (async () => new Response('server error', { status: 500 })) as unknown as FetchType

  await expect(
    AskMathModelTool.call({ problem: 'x' }, fakeContext()),
  ).rejects.toThrow(/500/)
})
