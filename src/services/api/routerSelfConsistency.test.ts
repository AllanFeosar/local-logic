import { afterEach, describe, expect, test } from 'bun:test'
import {
  canonicalizeVoteKey,
  hasUnbeatableLead,
  runRouterSelfConsistency,
  shouldApplyRouterSelfConsistency,
  tallyVotes,
  type VotableDecision,
} from './routerSelfConsistency.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const ASK_MATH_MODEL = {
  name: 'AskMathModel',
  description: 'Delegate a math problem to a specialist model',
  input_schema: {
    type: 'object',
    properties: { problem: { type: 'string' } },
    required: ['problem'],
  },
}

const DOCUMENT_QA = {
  name: 'DocumentQA',
  description: 'Extract an answer from a passage',
  input_schema: {
    type: 'object',
    properties: { question: { type: 'string' }, context: { type: 'string' } },
    required: ['question', 'context'],
  },
}

function toolDecision(name: string, input: Record<string, unknown>): VotableDecision {
  return { kind: 'tool', name, input }
}

const noneDecision = (answer = 'no tool needed'): VotableDecision => ({ kind: 'none', answer })

// ---------------------------------------------------------------------------
// shouldApplyRouterSelfConsistency — gate function
// ---------------------------------------------------------------------------

describe('shouldApplyRouterSelfConsistency', () => {
  test('true only when explicitly enabled, tools are present, the base URL is local, and the model is not tool-call-recovery-listed', () => {
    expect(shouldApplyRouterSelfConsistency('http://localhost:11434/v1', false, true, true)).toBe(true)
    expect(shouldApplyRouterSelfConsistency('http://127.0.0.1:11434/v1', false, true, true)).toBe(true)
  })

  test('false when not explicitly enabled, even when every other condition is met', () => {
    expect(shouldApplyRouterSelfConsistency('http://localhost:11434/v1', false, true, false)).toBe(false)
  })

  test('false when no tools are offered this turn', () => {
    expect(shouldApplyRouterSelfConsistency('http://localhost:11434/v1', false, false, true)).toBe(false)
  })

  test('false for a remote/cloud base URL, even with tools present and enabled', () => {
    expect(shouldApplyRouterSelfConsistency('https://api.openai.com/v1', false, true, true)).toBe(false)
  })

  test('false when baseUrl is undefined', () => {
    expect(shouldApplyRouterSelfConsistency(undefined, false, true, true)).toBe(false)
  })

  test('false for a tool-call-recovery-listed model even on a local URL with tools present and enabled', () => {
    expect(shouldApplyRouterSelfConsistency('http://localhost:11434/v1', true, true, true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canonicalizeVoteKey — the "(tool, roughly-similar-arguments)" grouping key
// ---------------------------------------------------------------------------

describe('canonicalizeVoteKey', () => {
  test('two "none" decisions vote together regardless of their free-text answer wording', () => {
    expect(canonicalizeVoteKey(noneDecision('Sure, 12 * 7 = 84.'))).toBe(
      canonicalizeVoteKey(noneDecision('84.')),
    )
  })

  test('same tool + identical arguments produce the same key', () => {
    const a = toolDecision('AskMathModel', { problem: '734 x 851' })
    const b = toolDecision('AskMathModel', { problem: '734 x 851' })
    expect(canonicalizeVoteKey(a)).toBe(canonicalizeVoteKey(b))
  })

  test('same tool + arguments differing only by key order still match ("roughly similar")', () => {
    const a = toolDecision('DataAnalyze', { operation: 'question', question: 'who?' })
    const b = toolDecision('DataAnalyze', { question: 'who?', operation: 'question' })
    expect(canonicalizeVoteKey(a)).toBe(canonicalizeVoteKey(b))
  })

  test('same tool + arguments differing only by a thousands-separator comma still match — the exact math-3 case shape', () => {
    const a = toolDecision('AskMathModel', { problem: 'A theater sold 3,842 tickets.' })
    const b = toolDecision('AskMathModel', { problem: 'A theater sold 3842 tickets.' })
    expect(canonicalizeVoteKey(a)).toBe(canonicalizeVoteKey(b))
  })

  test('same tool + arguments differing only by incidental whitespace/case still match', () => {
    const a = toolDecision('AskMathModel', { problem: '  734 X 851  ' })
    const b = toolDecision('AskMathModel', { problem: '734 x 851' })
    expect(canonicalizeVoteKey(a)).toBe(canonicalizeVoteKey(b))
  })

  test('different tool names never match', () => {
    const a = toolDecision('AskMathModel', { problem: '734 x 851' })
    const b = toolDecision('DataAnalyze', { problem: '734 x 851' })
    expect(canonicalizeVoteKey(a)).not.toBe(canonicalizeVoteKey(b))
  })

  test('meaningfully different arguments never match', () => {
    const a = toolDecision('AskMathModel', { problem: '734 x 851' })
    const b = toolDecision('AskMathModel', { problem: '512 x 768' })
    expect(canonicalizeVoteKey(a)).not.toBe(canonicalizeVoteKey(b))
  })

  test('"none" and a "tool" decision never match', () => {
    expect(canonicalizeVoteKey(noneDecision())).not.toBe(
      canonicalizeVoteKey(toolDecision('AskMathModel', { problem: 'x' })),
    )
  })
})

// ---------------------------------------------------------------------------
// tallyVotes — majority-vote logic in isolation, synthetic candidate sets
// ---------------------------------------------------------------------------

describe('tallyVotes', () => {
  test('returns null for an empty input', () => {
    expect(tallyVotes([])).toBeNull()
  })

  test('a single decision wins trivially', () => {
    const d = toolDecision('AskMathModel', { problem: '734 x 851' })
    const tally = tallyVotes([d])
    expect(tally?.voteCount).toBe(1)
    expect(tally?.totalValidSamples).toBe(1)
    expect(tally?.winner).toEqual(d)
  })

  test('a clear 3-2 majority wins', () => {
    const majority = toolDecision('AskMathModel', { problem: '734 x 851' })
    const minority = toolDecision('DataAnalyze', { problem: '734 x 851' })
    const tally = tallyVotes([majority, minority, majority, minority, majority])
    expect(tally?.voteCount).toBe(3)
    expect(tally?.winner).toEqual(majority)
    expect(tally?.totalValidSamples).toBe(5)
  })

  test('a tie is broken deterministically by the earliest (lowest-index) sample in the largest group, not randomly', () => {
    const first = toolDecision('AskMathModel', { problem: '734 x 851' })
    const second = toolDecision('DataAnalyze', { problem: '734 x 851' })
    const tallyA = tallyVotes([first, second])
    const tallyB = tallyVotes([first, second])
    expect(tallyA?.winner).toEqual(first)
    expect(tallyA?.winnerIndex).toBe(0)
    // Deterministic — repeated calls on the same input never flip the tie-break.
    expect(tallyB?.winner).toEqual(first)
  })

  test('a near-tie (2-2-1) still picks a single, deterministic winner', () => {
    const a = toolDecision('AskMathModel', { problem: 'a' })
    const b = toolDecision('AskMathModel', { problem: 'b' })
    const c = toolDecision('AskMathModel', { problem: 'c' })
    const tally = tallyVotes([a, b, a, b, c])
    expect(tally?.voteCount).toBe(2)
    expect(tally?.winner).toEqual(a) // group "a" appears first (lowest index)
  })

  test('all-"none" samples produce a "none" winner', () => {
    const tally = tallyVotes([noneDecision('84'), noneDecision('eighty-four'), noneDecision('84.0')])
    expect(tally?.winner.kind).toBe('none')
    expect(tally?.voteCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// hasUnbeatableLead — confidence-weighted early-stop
// ---------------------------------------------------------------------------

describe('hasUnbeatableLead', () => {
  test('false with zero decisions gathered so far', () => {
    expect(hasUnbeatableLead([], 5)).toBe(false)
  })

  test('the master plan\'s own example: 3-of-5 agreeing (2 remaining) is unbeatable', () => {
    const majority = toolDecision('AskMathModel', { problem: 'x' })
    expect(hasUnbeatableLead([majority, majority, majority], 2)).toBe(true)
  })

  test('2-of-5 agreeing with 3 remaining is NOT yet unbeatable', () => {
    const a = toolDecision('AskMathModel', { problem: 'x' })
    expect(hasUnbeatableLead([a, a], 3)).toBe(false)
  })

  test('a 1-1 split with 3 remaining is NOT unbeatable', () => {
    const a = toolDecision('AskMathModel', { problem: 'x' })
    const b = toolDecision('DataAnalyze', { problem: 'x' })
    expect(hasUnbeatableLead([a, b], 3)).toBe(false)
  })

  test('a 1-1 split with zero remaining IS unbeatable only for the leader found by tallyVotes tie-break — but by itself a pure tie is not a lead, so this must be false', () => {
    const a = toolDecision('AskMathModel', { problem: 'x' })
    const b = toolDecision('DataAnalyze', { problem: 'x' })
    // leader (1) is not > secondPlace (1) + remaining (0) -> 1 > 1 is false
    expect(hasUnbeatableLead([a, b], 0)).toBe(false)
  })

  test('all remaining samples exhausted with a real lead is unbeatable (trivially, nothing left to change it)', () => {
    const a = toolDecision('AskMathModel', { problem: 'x' })
    const b = toolDecision('DataAnalyze', { problem: 'x' })
    expect(hasUnbeatableLead([a, a, b], 0)).toBe(true)
  })

  test('exact boundary: leader must strictly exceed secondPlace+remaining, equal is not enough', () => {
    // leader=2, secondPlace=1, remaining=1 -> 2 > 1+1=2 is false (not yet unbeatable)
    const a = toolDecision('AskMathModel', { problem: 'x' })
    const b = toolDecision('DataAnalyze', { problem: 'x' })
    expect(hasUnbeatableLead([a, a, b], 1)).toBe(false)
    // one more remaining sample resolves it either way, so it correctly keeps sampling
  })
})

// ---------------------------------------------------------------------------
// runRouterSelfConsistency — orchestration, mocked HTTP
// ---------------------------------------------------------------------------

type FetchType = typeof globalThis.fetch

function chatCompletionResponse(
  message: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> },
  status = 200,
): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model: 'qwen3-router:1.7b',
      choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function toolCallMessage(name: string, args: Record<string, unknown>) {
  return { tool_calls: [{ id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] }
}

const baseOpts = {
  baseUrl: 'http://localhost:11434/v1',
  resolvedModel: 'qwen3-router:1.7b',
  messages: [{ role: 'user', content: 'What is 734 x 851?' }],
  system: 'test system',
  tools: [ASK_MATH_MODEL, DOCUMENT_QA],
  max_tokens: 512,
  // Keep tests fast and deterministic in count — most tests don't care about
  // early-stop specifically, so use a small, odd sample count.
  sampleCount: 3,
}

describe('runRouterSelfConsistency (orchestration, mocked HTTP)', () => {
  test('returns null immediately (no fetch attempted) when the tool list is empty', async () => {
    let fetchCalled = false
    globalThis.fetch = (async (_input, _init) => {
      fetchCalled = true
      return new Response('{}')
    }) as FetchType

    const result = await runRouterSelfConsistency({ ...baseOpts, tools: [] })

    expect(result).toBeNull()
    expect(fetchCalled).toBe(false)
  })

  test('returns null immediately when sampleCount is zero or negative', async () => {
    let fetchCalled = false
    globalThis.fetch = (async (_input, _init) => {
      fetchCalled = true
      return new Response('{}')
    }) as FetchType

    expect(await runRouterSelfConsistency({ ...baseOpts, sampleCount: 0 })).toBeNull()
    expect(await runRouterSelfConsistency({ ...baseOpts, sampleCount: -1 })).toBeNull()
    expect(fetchCalled).toBe(false)
  })

  test('a unanimous majority across all samples wins and produces a tool_use message', async () => {
    globalThis.fetch = (async (_input, _init) =>
      chatCompletionResponse(toolCallMessage('AskMathModel', { problem: '734 x 851' }))) as FetchType

    const result = await runRouterSelfConsistency(baseOpts)

    expect(result).not.toBeNull()
    const content = result?.message.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('tool_use')
    expect(content[0]?.name).toBe('AskMathModel')
    expect(content[0]?.input).toEqual({ problem: '734 x 851' })
    expect(result?.message.stop_reason).toBe('tool_use')
  })

  test('early-stops before exhausting sampleCount once the leader has an unbeatable lead', async () => {
    let calls = 0
    globalThis.fetch = (async (_input, _init) => {
      calls++
      return chatCompletionResponse(toolCallMessage('AskMathModel', { problem: '734 x 851' }))
    }) as FetchType

    await runRouterSelfConsistency({ ...baseOpts, sampleCount: 5 })

    // For a fully-unanimous sequence at N=5: after 1 sample (leader=1,
    // second=0, remaining=4) 1 > 0+4 is false; after 2 (leader=2, remaining=3)
    // 2 > 0+3 is false; after 3 (leader=3, remaining=2) 3 > 0+2 is true ->
    // stops. Exactly 3 of the 5 possible requests should have been made.
    expect(calls).toBe(3)
  })

  test('runs the full sampleCount when the vote stays split (no early stop possible)', async () => {
    let calls = 0
    globalThis.fetch = (async (_input, _init) => {
      calls++
      // Alternate between two different tools every call — no majority ever
      // becomes unbeatable before samples are exhausted.
      const name = calls % 2 === 0 ? 'AskMathModel' : 'DocumentQA'
      return chatCompletionResponse(
        toolCallMessage(name, name === 'AskMathModel' ? { problem: 'x' } : { question: 'x', context: 'y' }),
      )
    }) as FetchType

    await runRouterSelfConsistency({ ...baseOpts, sampleCount: 4 })

    expect(calls).toBe(4)
  })

  test('a plain end_turn "none" decision wins when the majority of samples call no tool', async () => {
    globalThis.fetch = (async (_input, _init) => chatCompletionResponse({ content: '12 * 7 = 84.' })) as FetchType

    const result = await runRouterSelfConsistency({
      ...baseOpts,
      messages: [{ role: 'user', content: 'What is 12 * 7?' }],
    })

    expect(result).not.toBeNull()
    const content = result?.message.content as Array<Record<string, unknown>>
    expect(content).toEqual([{ type: 'text', text: '12 * 7 = 84.' }])
    expect(result?.message.stop_reason).toBe('end_turn')
  })

  test('a sample naming an unregistered tool does not count as a vote, and is not returned as the winner unless every sample agrees on it (defense in depth)', async () => {
    globalThis.fetch = (async (_input, _init) => chatCompletionResponse(toolCallMessage('NotARealTool', {}))) as FetchType

    const result = await runRouterSelfConsistency(baseOpts)

    // Every sample hallucinates the same unregistered tool -> no valid votes
    // at all -> full fail-open.
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) when every sample fails (non-200)', async () => {
    globalThis.fetch = (async (_input, _init) => chatCompletionResponse({ content: 'irrelevant' }, 500)) as FetchType
    const result = await runRouterSelfConsistency(baseOpts)
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) when every sample throws (network error)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType
    const result = await runRouterSelfConsistency(baseOpts)
    expect(result).toBeNull()
  })

  test('falls back to null (fail open) when every sample returns an empty completion', async () => {
    globalThis.fetch = (async (_input, _init) => chatCompletionResponse({ content: '' })) as FetchType
    const result = await runRouterSelfConsistency(baseOpts)
    expect(result).toBeNull()
  })

  test('a minority of failed/invalid samples does not prevent a majority winner among the valid ones', async () => {
    let calls = 0
    globalThis.fetch = (async (_input, _init) => {
      calls++
      if (calls === 2) return chatCompletionResponse({ content: '' }, 200) // one invalid sample
      return chatCompletionResponse(toolCallMessage('AskMathModel', { problem: '734 x 851' }))
    }) as FetchType

    const result = await runRouterSelfConsistency({ ...baseOpts, sampleCount: 3 })

    expect(result).not.toBeNull()
    const content = result?.message.content as Array<Record<string, unknown>>
    expect(content[0]?.name).toBe('AskMathModel')
  })

  test('sends think:false, reasoning_effort:none, and the requested temperature on every sample request', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url, init) => {
      capturedBodies.push(JSON.parse(String((init as { body: string }).body)))
      return chatCompletionResponse(toolCallMessage('AskMathModel', { problem: '734 x 851' }))
    }) as FetchType

    await runRouterSelfConsistency({ ...baseOpts, sampleCount: 3, temperature: 0.6 })

    expect(capturedBodies.length).toBeGreaterThan(0)
    for (const body of capturedBodies) {
      expect(body.think).toBe(false)
      expect(body.reasoning_effort).toBe('none')
      expect(body.temperature).toBe(0.6)
      expect(body.stream).toBe(false)
      expect(Array.isArray(body.tools)).toBe(true)
    }
  })

  test('includes the few-shot examples in each sample request, same as the normal single-shot local path', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String((init as { body: string }).body))
      return chatCompletionResponse(toolCallMessage('AskMathModel', { problem: '734 x 851' }))
    }) as FetchType

    await runRouterSelfConsistency({ ...baseOpts, sampleCount: 1 })

    const messages = capturedBody?.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user') // first few-shot example, not the real user turn
  })

  test('falls back to null when the base URL is remote, even if called directly (defense in depth — real gating happens via shouldApplyRouterSelfConsistency at the caller)', async () => {
    // runRouterSelfConsistency itself does not re-check isLocalProviderUrl —
    // that's the caller's job via the gate function — so this documents the
    // actual (correct) behavior: it still executes if called directly.
    // Included for clarity of the module boundary, not as a safety net.
    globalThis.fetch = (async (_input, _init) =>
      chatCompletionResponse(toolCallMessage('AskMathModel', { problem: 'x' }))) as FetchType
    const result = await runRouterSelfConsistency({ ...baseOpts, baseUrl: 'https://api.openai.com/v1' })
    expect(result).not.toBeNull()
  })
})
