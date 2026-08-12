import { afterEach, describe, expect, test } from 'bun:test'
import { solveDeep } from './solveDeep.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// Fixtures for the Tier 1 restricted evaluator (2026-08-12, Session 11 —
// see verification.ts/restrictedEvaluator.ts): zero or more simple
// assignments, followed by a final bare comparison (the check itself, no
// print statement — the grammar has no `print`).
const PASSING_SNIPPET = '```python-verify\ncomputed = 2 + 2\nexpected = 4\ncomputed == expected\n```'
const FAILING_SNIPPET = '```python-verify\ncomputed = 2 + 2\nexpected = 5\ncomputed == expected\n```'
const NO_SNIPPET = '' // no fenced block at all -> inconclusive

function candidateContent(answerBody: string, snippet: string): string {
  return `<think>reasoning</think>\nFinal answer: ${answerBody}\n\n${snippet}`
}

function rerankResponse(yesLogprob: number, noLogprob: number): Response {
  return new Response(
    JSON.stringify({
      logprobs: [
        {
          top_logprobs: [
            { token: 'yes', logprob: yesLogprob },
            { token: 'no', logprob: noLogprob },
          ],
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

describe('solveDeep', () => {
  test('early-exits on the first candidate that provably passes — no further candidates generated', async () => {
    let chatCalls = 0
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.includes('/chat/completions')) {
        chatCalls++
        return chatResponse(candidateContent('4', PASSING_SNIPPET))
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as FetchType

    const result = await solveDeep('What is 2+2?', new AbortController().signal, { n: 3 })

    expect(result.verified).toBe(true)
    expect(result.method).toBe('code-verified')
    expect(result.candidatesGenerated).toBe(1)
    expect(chatCalls).toBe(1)
    expect(result.retried).toBe(false)
  }, 20_000)

  test('falls through to reranker scoring when no candidate is code-verifiable', async () => {
    let chatCalls = 0
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/chat/completions')) {
        chatCalls++
        const answer = chatCalls === 2 ? '4' : '9' // candidate 2 (index 1) is "the good one"
        return chatResponse(candidateContent(answer, NO_SNIPPET))
      }
      if (u.includes('/api/generate')) {
        const body = JSON.parse(String(init?.body)) as { prompt: string }
        if (body.prompt.includes('Final answer: 4')) return rerankResponse(-0.1, -6)
        return rerankResponse(-6, -0.1)
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as FetchType

    const result = await solveDeep('What is 2+2?', new AbortController().signal, { n: 3 })

    expect(result.verified).toBe(false)
    expect(result.method).toBe('reranker-scored')
    expect(result.candidatesGenerated).toBe(3)
    expect(result.candidatesInconclusive).toBe(3)
    expect(result.answer).toContain('Final answer: 4')
  }, 20_000)

  test('falls back to self-consistency when the reranker gives zero signal', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.includes('/chat/completions')) {
        return chatResponse(candidateContent('4', NO_SNIPPET))
      }
      if (u.includes('/api/generate')) {
        throw new Error('reranker unreachable')
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as FetchType

    const result = await solveDeep('What is 2+2?', new AbortController().signal, { n: 2 })

    expect(result.verified).toBe(false)
    expect(result.method).toBe('self-consistency')
    expect(result.candidatesGenerated).toBe(2)
  }, 20_000)

  test('escalates to exactly one bounded retry when every candidate is provably wrong, and returns the passing retry', async () => {
    let chatCalls = 0
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/chat/completions')) {
        chatCalls++
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        const isRetry = body.messages[0]!.content.includes('Previous attempts')
        return chatResponse(candidateContent(isRetry ? '4' : '5', isRetry ? PASSING_SNIPPET : FAILING_SNIPPET))
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as FetchType

    const result = await solveDeep('What is 2+2?', new AbortController().signal, { n: 2 })

    expect(result.verified).toBe(true)
    expect(result.method).toBe('code-verified')
    expect(result.retried).toBe(true)
    expect(result.candidatesGenerated).toBe(3) // 2 originals + 1 retry
    expect(result.candidatesFailed).toBe(2)
    expect(chatCalls).toBe(3)
  }, 20_000)

  test('returns a best-effort-unverified result (never throws) when even the retry fails', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.includes('/chat/completions')) {
        return chatResponse(candidateContent('5', FAILING_SNIPPET))
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as FetchType

    const result = await solveDeep('What is 2+2?', new AbortController().signal, { n: 2 })

    expect(result.verified).toBe(false)
    expect(result.method).toBe('best-effort-unverified')
    expect(result.retried).toBe(true)
    expect(result.candidatesGenerated).toBe(3)
  }, 20_000)

  test('n is hard-capped at the temperature schedule length regardless of what is requested', async () => {
    let chatCalls = 0
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.includes('/chat/completions')) {
        chatCalls++
        return chatResponse(candidateContent('9', NO_SNIPPET))
      }
      if (u.includes('/api/generate')) {
        return rerankResponse(-1, -1)
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as FetchType

    await solveDeep('What is 2+2?', new AbortController().signal, { n: 999 })
    expect(chatCalls).toBeLessThanOrEqual(5) // DEEP_MODE_TEMPERATURES.length
  }, 20_000)
})
