import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createOpenAIShimClient } from './openaiShim.ts'

type FetchType = typeof globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION:
    process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION,
}

const originalFetch = globalThis.fetch

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

function makeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  )
}

function makeStreamChunks(chunks: unknown[]): string[] {
  return [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ]
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
  if (originalEnv.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION === undefined) {
    delete process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION
  } else {
    process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION =
      originalEnv.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION
  }
  globalThis.fetch = originalFetch
})

test('preserves usage from final OpenAI stream chunk with empty choices', async () => {
  globalThis.fetch = (async (_input, init) => {
    const url = typeof _input === 'string' ? _input : _input.url
    expect(url).toBe('http://example.test/v1/chat/completions')

    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello world' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
        },
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined

  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBe(123)
  expect(usageEvent?.usage?.output_tokens).toBe(45)
})

test('preserves Gemini tool call extra_content in follow-up requests', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Use Bash' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'pwd' },
            extra_content: {
              google: {
                thought_signature: 'sig-123',
              },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'D:\\repo',
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const assistantWithToolCall = (requestBody?.messages as Array<Record<string, unknown>>).find(
    message => Array.isArray(message.tool_calls),
  ) as { tool_calls?: Array<Record<string, unknown>> } | undefined

  expect(assistantWithToolCall?.tool_calls?.[0]).toMatchObject({
    id: 'call_1',
    type: 'function',
    function: {
      name: 'Bash',
      arguments: JSON.stringify({ command: 'pwd' }),
    },
    extra_content: {
      google: {
        thought_signature: 'sig-123',
      },
    },
  })
})

test('preserves Gemini tool call extra_content from streaming chunks', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  extra_content: {
                    google: {
                      thought_signature: 'sig-stream',
                    },
                  },
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"pwd"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const toolStart = events.find(
    event =>
      event.type === 'content_block_start' &&
      typeof event.content_block === 'object' &&
      event.content_block !== null &&
      (event.content_block as Record<string, unknown>).type === 'tool_use',
  ) as { content_block?: Record<string, unknown> } | undefined

  expect(toolStart?.content_block).toMatchObject({
    type: 'tool_use',
    id: 'function-call-1',
    name: 'Bash',
    extra_content: {
      google: {
        thought_signature: 'sig-stream',
      },
    },
  })
})

test('sanitizes malformed MCP tool schemas before sending them to OpenAI', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              default: true,
              enum: [false, 0, 1, 2, 3],
            },
          },
        },
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const parameters = (
    requestBody?.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>
  )?.[0]?.function?.parameters
  const properties = parameters?.properties as
    | Record<string, { default?: unknown; enum?: unknown[]; type?: string }>
    | undefined

  expect(parameters?.additionalProperties).toBe(false)
  expect(parameters?.required).toEqual(['priority'])
  expect(properties?.priority?.type).toBe('integer')
  expect(properties?.priority?.enum).toEqual([0, 1, 2, 3])
  expect(properties?.priority).not.toHaveProperty('default')
})

function mockSimpleChatCompletion(
  captureBody: (body: Record<string, unknown>) => void,
): FetchType {
  return (async (_input, init) => {
    captureBody(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen3:1.7b',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType
}

// Regression test for the bug documented in LOCAL_AI_STATUS.md: a prior fix
// set only `think: false`, which is a native-Ollama-API field silently
// ignored on Ollama's OpenAI-compatible endpoint (confirmed against
// https://github.com/ollama/ollama/issues/14820 /
// https://github.com/ollama/ollama/issues/15288 — that fix never actually
// worked, and this gap in coverage is exactly why it went unnoticed). Ollama's
// OpenAI shim reads `reasoning_effort` instead, so both fields must be sent.
test('sends both think:false and reasoning_effort:none to a local provider URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'qwen3:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: '12 x 7' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.think).toBe(false)
  expect(requestBody?.reasoning_effort).toBe('none')
})

test('does not send think/reasoning_effort to a remote provider URL', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody).not.toHaveProperty('think')
  expect(requestBody).not.toHaveProperty('reasoning_effort')
})

test('does not send think/reasoning_effort for a tool-call-recovery-listed model even on a local URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
    system: 'test system',
    messages: [{ role: 'user', content: 'solve for x' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody).not.toHaveProperty('think')
  expect(requestBody).not.toHaveProperty('reasoning_effort')
})

// Regression tests for the router few-shot addendum (routerFewShot.ts,
// LOCAL_AI_MASTER_PLAN.md §6 lever F) — routerFewShot.test.ts covers the
// module's own logic in isolation; these confirm the wiring inside
// _doOpenAIRequest actually fires (and doesn't fire) under the right
// conditions, matching the same local-URL/tool-call-recovery/tools-present
// gate this test suite already uses for the think/reasoning_effort feature
// above.
const FEWSHOT_TOOLS = [
  {
    name: 'AskMathModel',
    description: 'Delegate a math problem to a specialist model',
    input_schema: { type: 'object', properties: { problem: { type: 'string' } } },
  },
]

test('inserts the router few-shot examples for a local URL, non-recovery model, with tools present', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'qwen3-router:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: '12 x 7' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // system + 12 few-shot messages (6 examples, session 29) + the real user turn = 14
  expect(messages).toHaveLength(14)
  expect(messages[0]?.role).toBe('system')
  expect(messages[1]?.role).toBe('user') // first few-shot example
  expect(messages.at(-1)).toEqual({ role: 'user', content: '12 x 7' })
})

test('does not insert router few-shot examples when no tools are offered this turn', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'qwen3-router:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: '12 x 7' }],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  expect(messages).toHaveLength(2) // system + the real user turn only
})

test('does not insert router few-shot examples for a remote/cloud URL even with tools present', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: '12 x 7' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  expect(messages).toHaveLength(2)
})

test('does not insert router few-shot examples for a tool-call-recovery-listed model even on a local URL with tools present', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = mockSimpleChatCompletion(body => {
    requestBody = body
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M',
    system: 'test system',
    messages: [{ role: 'user', content: 'solve for x' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  expect(messages).toHaveLength(2)
})

// Regression tests for grammar-constrained router tool selection
// (routerConstrainedToolSelection.ts, LOCAL_AI_MASTER_PLAN.md §6 lever G) —
// routerConstrainedToolSelection.test.ts covers the module's own
// encode/decode/orchestration logic in isolation; these confirm the wiring
// inside create() actually intercepts before the normal tools-based
// request, in both shapes callers can ask for (streaming and
// non-streaming), and that a failure genuinely falls back to the normal
// path rather than surfacing a broken result.
function mockRouterDecisionAwareFetch(
  onRequest: (body: Record<string, unknown>) => void,
): FetchType {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    onRequest(body)

    if (body.response_format) {
      // The lever-G constrained-selection request.
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-g',
          model: 'qwen3-router:1.7b',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  tool: 'AskMathModel',
                  arguments: { problem: '734 x 851' },
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }

    // The normal tools-based request (used only as a fallback in these tests).
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-normal',
        model: 'qwen3-router:1.7b',
        choices: [{ message: { role: 'assistant', content: 'fallback text' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType
}

test('is off by default: create() does NOT attempt constrained selection even when every other gate condition is met, without the explicit opt-in env var', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  delete process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION
  let requestCount = 0
  globalThis.fetch = mockRouterDecisionAwareFetch(() => {
    requestCount++
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = (await client.beta.messages.create({
    model: 'qwen3-router:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: 'What is 734 x 851?' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  // Went straight to the normal tools-based request (no response_format
  // attempt first) — the mock's "no response_format" branch returns plain
  // text, not a tool_use.
  expect(requestCount).toBe(1)
  expect(result.content[0]).toEqual({ type: 'text', text: 'fallback text' })
})

test('create() with stream:false returns the constrained-selection tool_use message directly, without a fallback request, when explicitly enabled', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION = '1'
  let requestCount = 0
  globalThis.fetch = mockRouterDecisionAwareFetch(() => {
    requestCount++
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = (await client.beta.messages.create({
    model: 'qwen3-router:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: 'What is 734 x 851?' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>>; stop_reason: string }

  expect(requestCount).toBe(1)
  expect(result.content[0]?.type).toBe('tool_use')
  expect(result.content[0]?.name).toBe('AskMathModel')
  expect(result.content[0]?.input).toEqual({ problem: '734 x 851' })
  expect(result.stop_reason).toBe('tool_use')
})

test('create() with stream:true wraps the constrained-selection result in a proper async-iterable stream carrying the tool_use decision, when explicitly enabled', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION = '1'
  let requestCount = 0
  globalThis.fetch = mockRouterDecisionAwareFetch(() => {
    requestCount++
  })

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const streamResult = (await client.beta.messages.create({
    model: 'qwen3-router:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: 'What is 734 x 851?' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: true,
  })) as { controller: unknown } & AsyncIterable<Record<string, unknown>>

  // Must carry a `controller` property — claude.ts's own stream-vs-error-message
  // check (`if (!('controller' in e.value))`) depends on this exact shape.
  expect(streamResult).toHaveProperty('controller')

  const events: Array<Record<string, unknown>> = []
  for await (const event of streamResult) events.push(event)

  expect(requestCount).toBe(1)
  expect(events[0]?.type).toBe('message_start')
  const toolStart = events.find(
    e => e.type === 'content_block_start' && (e.content_block as { type?: string })?.type === 'tool_use',
  )
  expect((toolStart?.content_block as { name?: string })?.name).toBe('AskMathModel')
  const delta = events.find(e => e.type === 'content_block_delta')
  expect(JSON.parse((delta?.delta as { partial_json: string }).partial_json)).toEqual({
    problem: '734 x 851',
  })
  expect(events.at(-1)?.type).toBe('message_stop')
})

test('falls back to the normal tools-based request when the constrained-selection call fails (fail open, not a broken result)', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION = '1'
  let requestCount = 0
  const capturedBodies: Array<Record<string, unknown>> = []
  // Every request (constrained AND fallback) gets the same malformed-content
  // response, so the constrained attempt fails to decode and the code must
  // fall through to a second, normal request rather than surfacing garbage.
  globalThis.fetch = (async (_input, init) => {
    requestCount++
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    capturedBodies.push(body)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fallback',
        model: 'qwen3-router:1.7b',
        choices: [{ message: { role: 'assistant', content: 'plain final answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = (await client.beta.messages.create({
    model: 'qwen3-router:1.7b',
    system: 'test system',
    messages: [{ role: 'user', content: 'What is 734 x 851?' }],
    tools: FEWSHOT_TOOLS,
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  // One failed constrained attempt + one normal fallback attempt.
  expect(requestCount).toBe(2)
  expect(capturedBodies[0]).toHaveProperty('response_format') // first attempt: constrained
  expect(capturedBodies[0]).not.toHaveProperty('tools')
  expect(capturedBodies[1]).not.toHaveProperty('response_format') // second attempt: normal fallback
  expect(capturedBodies[1]).toHaveProperty('tools')
  expect(result.content[0]).toEqual({ type: 'text', text: 'plain final answer' })
})
