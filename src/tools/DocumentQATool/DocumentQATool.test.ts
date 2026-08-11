import { afterEach, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { DocumentQATool } from './DocumentQATool.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}
test('mocked: sends question/context to the bridge and returns the parsed answer', async () => {
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ answer: 'blue', score: 0.99 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const result = await DocumentQATool.call(
    { question: 'What color is the sky?', context: 'The sky is blue.' },
    fakeContext(),
    )

  expect(requestBody).toEqual({ question: 'What color is the sky?', context: 'The sky is blue.' })
  expect(result.data).toEqual({ answer: 'blue', score: 0.99 })
})

test('mocked: raises a clear error when the bridge is unreachable', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as FetchType

  await expect(
    DocumentQATool.call(
      { question: 'x', context: 'y' },
      fakeContext(),
      ),
  ).rejects.toThrow(/Could not reach the local model bridge/)
})

test('mocked: mapToolResultToToolResultBlockParam flags low-confidence answers', () => {
  const block = DocumentQATool.mapToolResultToToolResultBlockParam(
    { answer: 'nonsense', score: 0.02 },
    'tool_1',
  )
  expect(block.content).toContain('low confidence')
})

test('mocked: mapToolResultToToolResultBlockParam reports confidence normally otherwise', () => {
  const block = DocumentQATool.mapToolResultToToolResultBlockParam(
    { answer: 'blue', score: 0.95 },
    'tool_1',
  )
  expect(block.content).toBe('blue (confidence: 0.95)')
})
