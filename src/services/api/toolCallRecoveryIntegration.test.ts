import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createOpenAIShimClient } from './openaiShim.ts'

type FetchType = typeof globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
}
const originalFetch = globalThis.fetch

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<{ content?: Array<Record<string, unknown>>; stop_reason?: string }>
    }
  }
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
  globalThis.fetch = originalFetch
})

test('mocked: recovers a tool call VibeThinker wrapped in the wrong tag, and forces non-streaming even when the caller asked for streaming', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    // This is the actual failure mode we reproduced live: valid JSON,
    // wrong wrapper tag, no native tool_calls in the response at all.
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                '<think>I should call get_stock_price.</think><advice>\n  {"name": "get_stock_price", "arguments": {"symbol": "AAPL"}}\n</advice>',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages.create({
    model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
    system: 'test system',
    messages: [{ role: 'user', content: 'What is the AAPL stock price?' }],
    tools: [{ name: 'get_stock_price', description: 'Get a stock price' }],
    max_tokens: 512,
    stream: true, // caller asks for streaming — recovery must force it off anyway
  })

  // The forced-non-streaming behavior, verified on the actual outgoing request:
  expect(requestBody?.stream).toBe(false)

  // The recovered tool call, in the same shape a native one would have:
  const toolUse = result.content?.find(c => c.type === 'tool_use')
  expect(toolUse).toMatchObject({
    type: 'tool_use',
    name: 'get_stock_price',
    input: { symbol: 'AAPL' },
  })
  expect(typeof toolUse?.id).toBe('string')
  expect(result.stop_reason).toBe('tool_use')
})

test('mocked: does not attempt recovery for models outside the known-unreliable list', async () => {
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true) // NOT forced off for an unrelated model
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen3:1.7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '{"name": "get_stock_price", "arguments": {"symbol": "AAPL"}}',
            },
            finish_reason: 'stop',
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  // qwen3:1.7b has reliable native tool-calling — this module must stay
  // out of its way entirely, even if its raw text happens to contain
  // something that looks like a tool call.
  const result = await client.beta.messages.create({
    model: 'qwen3:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_stock_price', description: 'Get a stock price' }],
    max_tokens: 64,
    stream: true,
  })

  expect(result).toBeDefined()
})

test('mocked: does not override a real native tool_calls response', async () => {
  globalThis.fetch = (async (_input, _init) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'thinking...',
              tool_calls: [
                {
                  id: 'call_native',
                  function: {
                    name: 'get_stock_price',
                    arguments: '{"symbol":"MSFT"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages.create({
    model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
    system: 'test system',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_stock_price', description: 'Get a stock price' }],
    max_tokens: 64,
    stream: false,
  })

  const toolUseBlocks = result.content?.filter(c => c.type === 'tool_use')
  expect(toolUseBlocks).toHaveLength(1)
  expect(toolUseBlocks?.[0]).toMatchObject({ id: 'call_native', name: 'get_stock_price' })
})

// The live, real-model variant of this test (self-documented nondeterministic
// output, ~90s-300s+ runtime) lives in
// toolCallRecoveryIntegration.live.test.ts — not run as part of the
// deterministic test:provider gate. See that file for why.
