import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildDeepPrompt,
  buildRetryPrompt,
  DEEP_MODE_TEMPERATURES,
  generateCandidate,
  generateRetryCandidate,
} from './generateCandidates.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('buildDeepPrompt / buildRetryPrompt', () => {
  test('deep prompt includes the problem and the restricted python-verify format instructions', () => {
    const prompt = buildDeepPrompt('What is 2+2?')
    expect(prompt).toContain('What is 2+2?')
    expect(prompt).toContain('python-verify')
    // 2026-08-12 (Session 11): the prompt no longer asks for a VERIFIED/
    // FAILED print sentinel (Tier 1 restricted evaluator, not arbitrary
    // Python) — it asks for the restricted function table instead.
    expect(prompt).toContain('isclose')
    expect(prompt).toContain('sqrt')
  })

  test('retry prompt includes prior failed attempts and verifier feedback', () => {
    const prompt = buildRetryPrompt('What is 2+2?', [
      { answer: 'Final answer: 5', verifierDetail: 'FAILED: 2+2 != 5' },
    ])
    expect(prompt).toContain('Final answer: 5')
    expect(prompt).toContain('2+2 != 5')
    expect(prompt).toContain('Previous attempts')
  })
})

describe('generateCandidate', () => {
  test('sends the requested temperature and strips the think trace', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '<think>reasoning...</think>\nFinal answer: 4\n\n```python-verify\nprint("VERIFIED")\n```',
              },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as FetchType

    const candidate = await generateCandidate(
      'What is 2+2?',
      DEEP_MODE_TEMPERATURES[1]!,
      1,
      new AbortController().signal,
    )

    expect(requestBody?.temperature).toBe(DEEP_MODE_TEMPERATURES[1])
    expect(candidate.answer).toContain('Final answer: 4')
    expect(candidate.verificationSnippetPresent).toBe(true)
    expect(candidate.truncated).toBe(false)
    expect(candidate.index).toBe(1)
  })

  test('reports verificationSnippetPresent:false when the model did not include one', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '<think>x</think>\nFinal answer: 4' } }] }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as unknown as FetchType

    const candidate = await generateCandidate('What is 2+2?', 0.5, 0, new AbortController().signal)
    expect(candidate.verificationSnippetPresent).toBe(false)
  })

  test('propagates an error on a non-ok HTTP response', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as unknown as FetchType
    await expect(
      generateCandidate('x', 0.5, 0, new AbortController().signal),
    ).rejects.toThrow(/500/)
  })
})

describe('generateRetryCandidate', () => {
  test('sends a prompt containing the failed attempts', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '<think>x</think>\nFinal answer: 4' } }] }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as FetchType

    await generateRetryCandidate(
      'What is 2+2?',
      [{ answer: 'Final answer: 5', verifierDetail: 'FAILED: wrong' }],
      99,
      new AbortController().signal,
    )

    const messages = requestBody?.messages as Array<{ content: string }>
    expect(messages[0]?.content).toContain('Final answer: 5')
    expect(messages[0]?.content).toContain('FAILED: wrong')
  })
})
