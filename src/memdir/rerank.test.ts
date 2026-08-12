import { afterEach, describe, expect, test } from 'bun:test'
import { RERANK_TOP_N, rerankMemoriesByRelevance } from './rerank.js'
import type { MemoryHeader } from './memoryScan.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function memory(filename: string, description: string): MemoryHeader {
  return { filename, filePath: `/memory/${filename}`, mtimeMs: 0, description, type: undefined }
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

// Maps a document's fetch call to a canned yes/no logprob response based on
// substring match against the request body, so each mocked test can express
// "this document should score as relevant" declaratively.
function mockRerankFetch(
  scoreByDocSubstring: Array<{ contains: string; yesLogprob: number; noLogprob: number }>,
): FetchType {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { prompt: string }
    const match = scoreByDocSubstring.find(s => body.prompt.includes(s.contains))
    if (!match) throw new Error(`no mock entry for prompt: ${body.prompt}`)
    return generateResponse(
      topLogprobs([
        ['yes', match.yesLogprob],
        ['no', match.noLogprob],
      ]),
    )
  }) as unknown as FetchType
}

describe('rerankMemoriesByRelevance', () => {
  test('returns the input unchanged when at or below topN — no network call made', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error('should not be called')
    }) as unknown as FetchType

    const memories = [memory('a.md', 'about apples'), memory('b.md', 'about bananas')]
    const result = await rerankMemoriesByRelevance('fruit', memories, new AbortController().signal, 5)

    expect(called).toBe(false)
    expect(result).toEqual(memories)
  })

  test('ranks candidates by yes-probability and returns topN', async () => {
    const memories = [
      memory('unrelated.md', 'unrelated topic'),
      memory('relevant.md', 'exact match for the query'),
      memory('somewhat.md', 'loosely related topic'),
    ]
    globalThis.fetch = mockRerankFetch([
      { contains: 'unrelated.md', yesLogprob: -6, noLogprob: -0.1 },
      { contains: 'relevant.md', yesLogprob: -0.1, noLogprob: -6 },
      { contains: 'somewhat.md', yesLogprob: -1, noLogprob: -1.2 },
    ])

    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 2)

    expect(result).toHaveLength(2)
    expect(result[0]?.filename).toBe('relevant.md')
    expect(result[1]?.filename).toBe('somewhat.md')
  })

  test('combines casing variants (yes/Yes/YES) via logsumexp instead of picking one', async () => {
    const memories = [
      memory('split-case.md', 'split across casings'),
      memory('single-case.md', 'single casing only'),
      ...Array.from({ length: 9 }, (_, i) => memory(`filler${i}.md`, `filler ${i}`)),
    ]

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { prompt: string }
      if (body.prompt.includes('split-case.md')) {
        // Probability mass for "yes" is split across two casings; combined
        // they should outscore single-case.md's one lower-probability "Yes".
        return generateResponse(
          topLogprobs([
            ['yes', -2],
            ['Yes', -2],
            ['no', -5],
          ]),
        )
      }
      if (body.prompt.includes('single-case.md')) {
        return generateResponse(
          topLogprobs([
            ['Yes', -1.5],
            ['no', -5],
          ]),
        )
      }
      return generateResponse(topLogprobs([['no', -0.1], ['yes', -6]]))
    }) as unknown as FetchType

    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 1)

    expect(result).toHaveLength(1)
    expect(result[0]?.filename).toBe('split-case.md')
  })

  test('fails open (returns the unranked list) when every judgment call fails', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as unknown as FetchType

    const memories = Array.from({ length: 15 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 5)

    expect(result).toEqual(memories)
  })

  test('fails open when fetch throws (e.g. connection refused)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    const memories = Array.from({ length: 15 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 5)

    expect(result).toEqual(memories)
  })

  test('treats a malformed response (missing logprobs) as no-signal, not a crash', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ done: true }), {
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as FetchType

    const memories = Array.from({ length: 12 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 5)

    // All candidates score null -> every judgment "failed" -> fail open.
    expect(result).toEqual(memories)
  })

  test('a single failed candidate among otherwise-successful ones falls back to score 0, not an aborted batch', async () => {
    const memories = [
      memory('good.md', 'clearly relevant'),
      memory('broken.md', 'this one errors'),
      ...Array.from({ length: 9 }, (_, i) => memory(`filler${i}.md`, `filler ${i}`)),
    ]

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { prompt: string }
      if (body.prompt.includes('broken.md')) {
        throw new Error('simulated single-call failure')
      }
      if (body.prompt.includes('good.md')) {
        return generateResponse(topLogprobs([['yes', -0.1], ['no', -6]]))
      }
      return generateResponse(topLogprobs([['no', -0.1], ['yes', -6]]))
    }) as unknown as FetchType

    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 3)

    expect(result.map(m => m.filename)).toContain('good.md')
    expect(result[0]?.filename).toBe('good.md')
  })

  test('skips reranking (fails open) when candidate count exceeds the max — never fires one call per file on a fail-open manifest', async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      return new Response('should not be called', { status: 500 })
    }) as unknown as FetchType

    // Larger than RERANK_MAX_CANDIDATES (EMBEDDING_PREFILTER_TOP_K, 20).
    const memories = Array.from({ length: 40 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal, 5)

    expect(callCount).toBe(0)
    expect(result).toEqual(memories)
  })

  test('default topN matches the exported constant', async () => {
    const memories = Array.from({ length: RERANK_TOP_N + 5 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    globalThis.fetch = (async () =>
      generateResponse(topLogprobs([['yes', -0.5], ['no', -1]]))) as unknown as FetchType

    const result = await rerankMemoriesByRelevance('query', memories, new AbortController().signal)
    expect(result).toHaveLength(RERANK_TOP_N)
  })
})
