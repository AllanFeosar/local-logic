import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createOpenAIShimClient } from './openaiShim.ts'

// Real end-to-end test against live Ollama + VibeThinker-3B. Deliberately
// NOT part of the fast/deterministic suite (test:provider, bare `bun test`
// runs meant to gate CI) — run explicitly:
//   bun test src/services/api/toolCallRecoveryIntegration.live.test.ts
//
// Split out of toolCallRecoveryIntegration.test.ts (where the mocked,
// deterministic recovery tests still live) because this one test:
//   1. Takes ~90s-300s+ per run (VibeThinker's visible <think> reasoning
//      before it commits to a tool call is long and variable — observed
//      195s-300s+ for this exact prompt across runs).
//   2. Requires a real, running Ollama instance on 127.0.0.1:11434 with
//      VibeThinker-3B pulled — not available in every environment.
//   3. Has genuine run-to-run output variance (see the note below) that
//      doesn't belong inside a supposedly-deterministic gate.
// Follows the same *.live.test.ts convention already used by
// src/memdir/rerank.live.test.ts, src/memdir/embeddingPreFilter.live.test.ts,
// and the AskMathModelTool/DocumentQATool/ImageCaptionTool live tests.

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
