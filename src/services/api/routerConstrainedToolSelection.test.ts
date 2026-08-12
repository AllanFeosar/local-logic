import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildToolDecisionSchema,
  decodeToolDecision,
  messageToStreamEvents,
  runRouterConstrainedToolSelection,
  shouldApplyRouterConstrainedSelection,
  type RouterToolDefinition,
} from './routerConstrainedToolSelection.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const ASK_MATH_MODEL: RouterToolDefinition = {
  name: 'AskMathModel',
  description: 'Delegate a math problem to a specialist model',
  input_schema: {
    type: 'object',
    properties: { problem: { type: 'string' } },
    required: ['problem'],
  },
}

const DOCUMENT_QA: RouterToolDefinition = {
  name: 'DocumentQA',
  description: 'Extract an answer from a passage',
  input_schema: {
    type: 'object',
    properties: { question: { type: 'string' }, context: { type: 'string' } },
    required: ['question', 'context'],
  },
}

describe('shouldApplyRouterConstrainedSelection', () => {
  test('true only when explicitly enabled, tools are present, the base URL is local, and the model is not tool-call-recovery-listed', () => {
    expect(shouldApplyRouterConstrainedSelection('http://localhost:11434/v1', false, true, true)).toBe(true)
    expect(shouldApplyRouterConstrainedSelection('http://127.0.0.1:11434/v1', false, true, true)).toBe(true)
  })

  // Off by default — live routing-eval measurement found this regresses
  // accuracy versus both the untouched baseline and lever F alone (see this
  // module's own header comment, "Off by default, not just local-only", and
  // LOCAL_AI_STATUS.md's session notes for the full numbers). Every other
  // condition being met must NOT be enough on its own.
  test('false when not explicitly enabled, even when every other condition is met', () => {
    expect(shouldApplyRouterConstrainedSelection('http://localhost:11434/v1', false, true, false)).toBe(false)
  })

  test('false when no tools are offered this turn', () => {
    expect(shouldApplyRouterConstrainedSelection('http://localhost:11434/v1', false, false, true)).toBe(false)
  })

  test('false for a remote/cloud base URL, even with tools present and enabled', () => {
    expect(shouldApplyRouterConstrainedSelection('https://api.openai.com/v1', false, true, true)).toBe(false)
  })

  test('false when baseUrl is undefined', () => {
    expect(shouldApplyRouterConstrainedSelection(undefined, false, true, true)).toBe(false)
  })

  test('false for a tool-call-recovery-listed model even on a local URL with tools present and enabled', () => {
    expect(shouldApplyRouterConstrainedSelection('http://localhost:11434/v1', true, true, true)).toBe(false)
  })
})

describe('buildToolDecisionSchema (encode)', () => {
  test('produces one oneOf branch per tool plus a "none" branch', () => {
    const schema = buildToolDecisionSchema([ASK_MATH_MODEL, DOCUMENT_QA])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    expect(oneOf).toHaveLength(3)
  })

  test('each tool branch uses a const discriminator on "tool" and embeds that tool\'s own sanitized input_schema under "arguments"', () => {
    const schema = buildToolDecisionSchema([ASK_MATH_MODEL])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    const askMathBranch = oneOf[0] as {
      properties: { tool: { const: string }; arguments: Record<string, unknown> }
      required: string[]
      additionalProperties: boolean
    }
    expect(askMathBranch.properties.tool.const).toBe('AskMathModel')
    expect(askMathBranch.properties.arguments.properties).toEqual({ problem: { type: 'string' } })
    expect(askMathBranch.required).toEqual(['tool', 'arguments'])
    expect(askMathBranch.additionalProperties).toBe(false)
  })

  test('the "none" branch requires only tool and answer, no arguments', () => {
    const schema = buildToolDecisionSchema([ASK_MATH_MODEL])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    const noneBranch = oneOf.at(-1) as {
      properties: { tool: { const: string }; answer: { type: string } }
      required: string[]
    }
    expect(noneBranch.properties.tool.const).toBe('none')
    expect(noneBranch.properties.answer.type).toBe('string')
    expect(noneBranch.required).toEqual(['tool', 'answer'])
  })

  test('a tool with no input_schema at all still produces a valid object-typed arguments branch', () => {
    const schema = buildToolDecisionSchema([{ name: 'NoSchemaTool' }])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    const branch = oneOf[0] as { properties: { arguments: Record<string, unknown> } }
    expect(branch.properties.arguments.type).toBe('object')
  })

  test('an empty tool list still produces a schema with only the "none" branch', () => {
    const schema = buildToolDecisionSchema([])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    expect(oneOf).toHaveLength(1)
    expect((oneOf[0] as { properties: { tool: { const: string } } }).properties.tool.const).toBe('none')
  })

  test('strips a tool with an empty/missing name rather than emitting a malformed const branch', () => {
    const schema = buildToolDecisionSchema([{ name: '' }, ASK_MATH_MODEL])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    expect(oneOf).toHaveLength(2) // AskMathModel + none, the blank-name tool is dropped
  })

  test('OpenAI-incompatible schema keywords (e.g. "format", "pattern") are stripped from tool argument schemas', () => {
    const schema = buildToolDecisionSchema([
      {
        name: 'WithPattern',
        input_schema: {
          type: 'object',
          properties: { email: { type: 'string', format: 'email', pattern: '^.+@.+$' } },
        },
      },
    ])
    const oneOf = schema.oneOf as Array<Record<string, unknown>>
    const branch = oneOf[0] as {
      properties: { arguments: { properties: { email: Record<string, unknown> } } }
    }
    expect(branch.properties.arguments.properties.email).not.toHaveProperty('format')
    expect(branch.properties.arguments.properties.email).not.toHaveProperty('pattern')
  })
})

describe('decodeToolDecision (decode)', () => {
  const registered = new Set(['AskMathModel', 'DocumentQA'])

  test('decodes a valid tool decision', () => {
    const decision = decodeToolDecision(
      JSON.stringify({ tool: 'AskMathModel', arguments: { problem: '734 x 851' } }),
      registered,
    )
    expect(decision).toEqual({
      kind: 'tool',
      name: 'AskMathModel',
      input: { problem: '734 x 851' },
    })
  })

  test('decodes a valid "none" decision with an answer', () => {
    const decision = decodeToolDecision(JSON.stringify({ tool: 'none', answer: '12 * 7 = 84.' }), registered)
    expect(decision).toEqual({ kind: 'none', answer: '12 * 7 = 84.' })
  })

  test('a "none" decision with a missing/non-string answer defaults to an empty string rather than failing', () => {
    const decision = decodeToolDecision(JSON.stringify({ tool: 'none' }), registered)
    expect(decision).toEqual({ kind: 'none', answer: '' })
  })

  // --- edge cases the task explicitly calls out: malformed JSON,
  // schema-violating output despite the grammar guarantee, unknown tool
  // name, missing required args ---

  test('malformed JSON is rejected as invalid, not thrown', () => {
    const decision = decodeToolDecision('{not valid json', registered)
    expect(decision.kind).toBe('invalid')
  })

  test('a JSON array (not an object) is rejected as invalid', () => {
    const decision = decodeToolDecision('[1,2,3]', registered)
    expect(decision.kind).toBe('invalid')
  })

  test('a JSON primitive (not an object) is rejected as invalid', () => {
    const decision = decodeToolDecision('"just a string"', registered)
    expect(decision.kind).toBe('invalid')
  })

  test('a missing "tool" field is rejected as invalid', () => {
    const decision = decodeToolDecision(JSON.stringify({ arguments: {} }), registered)
    expect(decision.kind).toBe('invalid')
  })

  test('a tool name outside the registered set is rejected as invalid (defense in depth — the grammar should make this inexpressible, but this must never be trusted blindly)', () => {
    const decision = decodeToolDecision(
      JSON.stringify({ tool: 'TotallyMadeUpTool', arguments: {} }),
      registered,
    )
    expect(decision).toEqual({
      kind: 'invalid',
      reason: '"TotallyMadeUpTool" is not a registered tool name',
    })
  })

  test('missing "arguments" for a real tool is rejected as invalid', () => {
    const decision = decodeToolDecision(JSON.stringify({ tool: 'AskMathModel' }), registered)
    expect(decision.kind).toBe('invalid')
  })

  test('a non-object "arguments" (e.g. a string) is rejected as invalid', () => {
    const decision = decodeToolDecision(
      JSON.stringify({ tool: 'AskMathModel', arguments: 'not an object' }),
      registered,
    )
    expect(decision.kind).toBe('invalid')
  })

  test('an array "arguments" is rejected as invalid (arrays are typeof object in JS but not a valid arguments bag)', () => {
    const decision = decodeToolDecision(
      JSON.stringify({ tool: 'AskMathModel', arguments: [1, 2, 3] }),
      registered,
    )
    expect(decision.kind).toBe('invalid')
  })

  test('empty string input is rejected as invalid, not thrown', () => {
    const decision = decodeToolDecision('', registered)
    expect(decision.kind).toBe('invalid')
  })
})

describe('messageToStreamEvents', () => {
  test('a tool_use message yields message_start, a tool_use content block sequence, message_delta, message_stop', async () => {
    const message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'AskMathModel', input: { problem: '734 x 851' } }],
      model: 'qwen3-router:1.7b',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }

    const events = []
    for await (const event of messageToStreamEvents(message)) events.push(event)

    expect(events[0]?.type).toBe('message_start')
    expect(events.some(e => e.type === 'content_block_start' && (e.content_block as { type: string })?.type === 'tool_use')).toBe(true)
    const delta = events.find(e => e.type === 'content_block_delta')
    expect(JSON.parse((delta?.delta as { partial_json: string }).partial_json)).toEqual({ problem: '734 x 851' })
    expect(events.some(e => e.type === 'content_block_stop')).toBe(true)
    expect(events.some(e => e.type === 'message_delta' && (e.delta as { stop_reason: string }).stop_reason === 'tool_use')).toBe(true)
    expect(events.at(-1)?.type).toBe('message_stop')
  })

  test('a plain-text (no-tool) message yields a text_delta with the full answer', async () => {
    const message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '12 * 7 = 84.' }],
      model: 'qwen3-router:1.7b',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }

    const events = []
    for await (const event of messageToStreamEvents(message)) events.push(event)

    const delta = events.find(e => e.type === 'content_block_delta')
    expect((delta?.delta as { text: string }).text).toBe('12 * 7 = 84.')
    expect(events.at(-1)?.type).toBe('message_stop')
  })

  test('an empty-content message (e.g. a "none" decision with no answer) still yields a valid start/delta/stop sequence with no content blocks', async () => {
    const message = {
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'qwen3-router:1.7b',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }

    const events = []
    for await (const event of messageToStreamEvents(message)) events.push(event)

    expect(events[0]?.type).toBe('message_start')
    expect(events.some(e => e.type === 'content_block_start')).toBe(false)
    expect(events.at(-1)?.type).toBe('message_stop')
  })
})

type FetchType = typeof globalThis.fetch

function mockChatCompletion(content: string, status = 200): FetchType {
  return (async (_input, _init) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen3-router:1.7b',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType
}

const baseOpts = {
  baseUrl: 'http://localhost:11434/v1',
  resolvedModel: 'qwen3-router:1.7b',
  messages: [{ role: 'user', content: 'What is 734 x 851?' }],
  system: 'test system',
  tools: [ASK_MATH_MODEL, DOCUMENT_QA],
  max_tokens: 512,
}

describe('runRouterConstrainedToolSelection (orchestration, mocked HTTP)', () => {
  test('returns a tool_use message on a valid constrained response', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'qwen3-router:1.7b',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ tool: 'AskMathModel', arguments: { problem: '734 x 851' } }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    const result = await runRouterConstrainedToolSelection(baseOpts)

    expect(result).not.toBeNull()
    const content = result?.message.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('tool_use')
    expect(content[0]?.name).toBe('AskMathModel')
    expect(content[0]?.input).toEqual({ problem: '734 x 851' })
    expect(result?.message.stop_reason).toBe('tool_use')

    // Never sends `tools` alongside `response_format` — the Constraint Tax
    // landmine this module's own header comment documents.
    expect(capturedBody).not.toHaveProperty('tools')
    expect(capturedBody).not.toHaveProperty('tool_choice')
    expect(capturedBody?.response_format).toBeDefined()
    expect(capturedBody?.stream).toBe(false)
  })

  test('returns a plain-text end_turn message on a valid "none" decision', async () => {
    globalThis.fetch = mockChatCompletion(JSON.stringify({ tool: 'none', answer: '12 * 7 = 84.' }))

    const result = await runRouterConstrainedToolSelection({
      ...baseOpts,
      messages: [{ role: 'user', content: 'What is 12 * 7?' }],
    })

    expect(result).not.toBeNull()
    const content = result?.message.content as Array<Record<string, unknown>>
    expect(content).toEqual([{ type: 'text', text: '12 * 7 = 84.' }])
    expect(result?.message.stop_reason).toBe('end_turn')
  })

  test('falls back to null (fail open) on malformed JSON content', async () => {
    globalThis.fetch = mockChatCompletion('not valid json at all')
    const result = await runRouterConstrainedToolSelection(baseOpts)
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) when the decoded tool name is not registered', async () => {
    globalThis.fetch = mockChatCompletion(
      JSON.stringify({ tool: 'SomethingNotRegistered', arguments: {} }),
    )
    const result = await runRouterConstrainedToolSelection(baseOpts)
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) on a non-200 HTTP response', async () => {
    globalThis.fetch = mockChatCompletion('{}', 500)
    const result = await runRouterConstrainedToolSelection(baseOpts)
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) when fetch itself throws (network error)', async () => {
    globalThis.fetch = (async (_input: unknown, _init: unknown) => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType
    const result = await runRouterConstrainedToolSelection(baseOpts)
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) on an empty response content', async () => {
    globalThis.fetch = mockChatCompletion('')
    const result = await runRouterConstrainedToolSelection(baseOpts)
    expect(result).toBeNull()
  })

  test('returns null immediately (no fetch attempted) when the tool list is empty', async () => {
    let fetchCalled = false
    globalThis.fetch = (async (_input, _init) => {
      fetchCalled = true
      return new Response('{}')
    }) as FetchType

    const result = await runRouterConstrainedToolSelection({ ...baseOpts, tools: [] })

    expect(result).toBeNull()
    expect(fetchCalled).toBe(false)
  })

  test('includes the few-shot decision examples in the outgoing request, right after the system message', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tool: 'none', answer: 'hi' }) } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    await runRouterConstrainedToolSelection(baseOpts)

    const messages = capturedBody?.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user') // first few-shot example
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'What is 734 x 851?' })
  })

  test('sends think:false and reasoning_effort:none (same local-only rationale as the normal request path)', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tool: 'none', answer: 'hi' }) } }] }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    await runRouterConstrainedToolSelection(baseOpts)

    expect(capturedBody?.think).toBe(false)
    expect(capturedBody?.reasoning_effort).toBe('none')
  })

  // Regression test for a real bug found and fixed during this module's
  // development (see the module's own buildToolCatalogText() comment): the
  // system message must carry each tool's real description, not just its
  // name — omitting this caused the live model to fabricate answers instead
  // of delegating to ImageCaption, and to over-select DataAnalyze for
  // passage-and-question prompts that should have gone to DocumentQA.
  test('appends a tool catalog (name + real description) to the system message, not just tool names', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tool: 'none', answer: 'hi' }) } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    await runRouterConstrainedToolSelection({
      ...baseOpts,
      tools: [
        { name: 'AskMathModel', description: 'Delegate a math problem to a specialist model' },
        DOCUMENT_QA,
      ],
    })

    const messages = capturedBody?.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('test system')
    expect(messages[0]?.content).toContain('AskMathModel')
    expect(messages[0]?.content).toContain('Delegate a math problem to a specialist model')
    expect(messages[0]?.content).toContain('DocumentQA')
    expect(messages[0]?.content).toContain('Extract an answer from a passage')
  })

  test('a tool with no description still gets a catalog entry rather than being silently omitted', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tool: 'none', answer: 'hi' }) } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    await runRouterConstrainedToolSelection({ ...baseOpts, tools: [{ name: 'NoDescriptionTool' }] })

    const messages = capturedBody?.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.content).toContain('NoDescriptionTool')
  })

  test('still works (inserts a system message) when the original request had no system prompt at all', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tool: 'none', answer: 'hi' }) } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    await runRouterConstrainedToolSelection({ ...baseOpts, system: undefined })

    const messages = capturedBody?.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('AskMathModel')
  })
})
