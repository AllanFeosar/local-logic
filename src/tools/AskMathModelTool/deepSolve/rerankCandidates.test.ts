import { afterEach, describe, expect, test } from 'bun:test'
import type { Candidate } from './generateCandidates.js'
import { pickWinner, scoreCandidatesWithReranker, selfConsistencyVote } from './rerankCandidates.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function candidate(index: number, answer: string): Candidate {
  return {
    index,
    temperature: 0.5,
    rawContent: answer,
    answer,
    truncated: false,
    verificationSnippetPresent: false,
    durationMs: 1,
  }
}

function topLogprobs(entries: Array<[string, number]>) {
  return entries.map(([token, logprob]) => ({ token, logprob }))
}

function generateResponse(top: Array<{ token: string; logprob: number }>) {
  return new Response(
    JSON.stringify({ logprobs: [{ token: top[0]?.token, logprob: top[0]?.logprob, top_logprobs: top }] }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

describe('scoreCandidatesWithReranker', () => {
  test('scores each candidate via the shared yes/no-logprob mechanism', async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { prompt: string }
      if (body.prompt.includes('Final answer: 4')) {
        return generateResponse(topLogprobs([['yes', -0.1], ['no', -6]]))
      }
      return generateResponse(topLogprobs([['no', -0.1], ['yes', -6]]))
    }) as unknown as FetchType

    const candidates = [candidate(0, 'Final answer: 5'), candidate(1, 'Final answer: 4')]
    const scored = await scoreCandidatesWithReranker('what is 2+2?', candidates, new AbortController().signal)

    expect(scored).toHaveLength(2)
    const good = scored.find(s => s.candidate.index === 1)!
    const bad = scored.find(s => s.candidate.index === 0)!
    expect(good.score).not.toBeNull()
    expect(good.score!).toBeGreaterThan(bad.score!)
  })

  test('reports null score (no signal) rather than throwing when the reranker is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    const scored = await scoreCandidatesWithReranker(
      'x',
      [candidate(0, 'a'), candidate(1, 'b')],
      new AbortController().signal,
    )
    expect(scored.every(s => s.score === null)).toBe(true)
  })
})

describe('selfConsistencyVote', () => {
  test('picks the lowest-index candidate from the largest normalized-answer group', () => {
    const candidates = [
      candidate(0, 'Final answer: 4'),
      candidate(1, 'Final answer: 5'),
      candidate(2, 'final answer: 4'),
      candidate(3, 'Final Answer: 4'),
    ]
    const winner = selfConsistencyVote(candidates)
    expect(winner.index).toBe(0)
  })

  test('falls back to the first candidate when every group has size 1', () => {
    const candidates = [candidate(0, 'a'), candidate(1, 'b'), candidate(2, 'c')]
    expect(selfConsistencyVote(candidates).index).toBe(0)
  })
})

describe('pickWinner', () => {
  test('returns the clear top-scoring candidate directly', () => {
    const c0 = candidate(0, 'Final answer: 5')
    const c1 = candidate(1, 'Final answer: 4')
    const result = pickWinner([
      { candidate: c0, score: 0.2 },
      { candidate: c1, score: 0.95 },
    ])
    expect(result.winner.index).toBe(1)
    expect(result.method).toBe('reranker-scored')
  })

  test('breaks a near-tie via self-consistency among just the tied top tier', () => {
    const c0 = candidate(0, 'Final answer: 4')
    const c1 = candidate(1, 'Final answer: 4')
    const c2 = candidate(2, 'Final answer: 9')
    const result = pickWinner([
      { candidate: c0, score: 0.9 },
      { candidate: c1, score: 0.91 },
      { candidate: c2, score: 0.1 },
    ])
    // c0 and c1 tie (within epsilon) and agree on the same answer, so the
    // tie-break should land on one of them, not the clearly-lower-scored c2.
    expect([0, 1]).toContain(result.winner.index)
  })

  test('falls back to self-consistency across everything when the reranker gave zero signal', () => {
    const c0 = candidate(0, 'Final answer: 4')
    const c1 = candidate(1, 'Final answer: 4')
    const c2 = candidate(2, 'Final answer: 9')
    const result = pickWinner([
      { candidate: c0, score: null },
      { candidate: c1, score: null },
      { candidate: c2, score: null },
    ])
    expect(result.method).toBe('self-consistency')
    expect(result.winner.index).toBe(0)
  })
})
