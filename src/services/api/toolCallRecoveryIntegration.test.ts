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

// Note on timing: VibeThinker's visible <think> reasoning before it commits
// to a tool call is long and variable (observed 195s-300s+ for this exact
// prompt across runs). Earlier attempts hit Bun's hardcoded 300s fetch
// timeout mid-generation; createCombinedAbortSignal(..., {timeoutMs:
// TOOL_CALL_RECOVERY_TIMEOUT_MS}) in openaiShim.ts's create() removes that
// ceiling (confirmed: a run that previously died at exactly ~300s completed
// successfully once this was wired in). Also note the model sometimes fills
// an argument with the JSON-schema shape instead of a concrete value (e.g.
// {"symbol": {"type": "string"}} instead of {"symbol": "AAPL"}) — this test
// only asserts the structural guarantee (a correctly-named, correctly-keyed
// tool call was recovered), not that the argument value is semantically
// correct, since that's a model-quality issue orthogonal to recovery.
test('real Ollama + VibeThinker-3B: end-to-end tool call recovery against the live model', async () => {
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1'
  process.env.OPENAI_API_KEY = 'ollama'

  const result = await client.beta.messages.create({
    model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
    messages: [
      {
        role: 'user',
        content:
          'Call get_stock_price for AAPL now. Respond with only the tool call, no explanation.',
      },
    ],
    tools: [
      {
        name: 'get_stock_price',
        description: 'Get the current live stock price for a given ticker symbol',
        input_schema: {
          type: 'object',
          properties: { symbol: { type: 'string' } },
          required: ['symbol'],
        },
      },
    ],
    max_tokens: 1024,
    stream: true, // deliberately request streaming — recovery must still force non-streaming under the hood
  })

  const toolUse = result.content?.find(c => c.type === 'tool_use')
  // This is a real model call. Assert on the structural guarantee (a
  // recovered tool call was found and correctly shaped), not on the model
  // picking exactly "AAPL" as the argument every single run.
  expect(toolUse).toBeDefined()
  expect(toolUse?.name).toBe('get_stock_price')
  expect(toolUse?.input).toHaveProperty('symbol')
  expect(result.stop_reason).toBe('tool_use')
}, 400000)
