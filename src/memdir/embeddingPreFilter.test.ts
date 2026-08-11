import { afterEach, describe, expect, test } from 'bun:test'
import type { MemoryHeader } from './memoryScan.js'
import { EMBEDDING_PREFILTER_TOP_K, preFilterMemoriesByEmbedding } from './embeddingPreFilter.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function memory(filename: string, description: string): MemoryHeader {
  return { filename, filePath: `/memory/${filename}`, mtimeMs: 0, description, type: undefined }
}

// Toy embeddings: each is a 2D unit-ish vector so cosine similarity is easy
// to reason about by hand. Index 0 is always the query embedding.
function mockEmbedFetch(vectors: number[][]): FetchType {
  return (async () => {
    return new Response(JSON.stringify({ embeddings: vectors }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType
}

describe('preFilterMemoriesByEmbedding', () => {
  test('returns the full list unchanged when at or below topK — no network call made', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error('should not be called')
    }) as unknown as FetchType

    const memories = [memory('a.md', 'about apples'), memory('b.md', 'about bananas')]
    const result = await preFilterMemoriesByEmbedding('fruit', memories, new AbortController().signal, 5)

    expect(called).toBe(false)
    expect(result).toEqual(memories)
  })

  test('ranks memories by cosine similarity to the query and returns topK', async () => {
    // query=[1,0]; close.md=[1,0] (identical → sim 1); far.md=[0,1] (orthogonal → sim 0)
    globalThis.fetch = mockEmbedFetch([
      [1, 0],
      [0, 1], // far.md
      [1, 0], // close.md
      [0.9, 0.1], // mid.md
    ])

    const memories = [
      memory('far.md', 'unrelated'),
      memory('close.md', 'exact match'),
      memory('mid.md', 'somewhat related'),
    ]
    const result = await preFilterMemoriesByEmbedding('query', memories, new AbortController().signal, 2)

    expect(result).toHaveLength(2)
    expect(result[0]?.filename).toBe('close.md')
    expect(result[1]?.filename).toBe('mid.md')
  })

  test('fails open (returns the unfiltered list) when the embedding endpoint errors', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as unknown as FetchType

    const memories = Array.from({ length: 20 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await preFilterMemoriesByEmbedding('query', memories, new AbortController().signal, 5)

    expect(result).toEqual(memories)
  })

  test('fails open when fetch throws (e.g. connection refused)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    const memories = Array.from({ length: 20 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await preFilterMemoriesByEmbedding('query', memories, new AbortController().signal, 5)

    expect(result).toEqual(memories)
  })

  test('fails open when the embeddings array length does not match the request', async () => {
    globalThis.fetch = mockEmbedFetch([[1, 0]]) // only 1 vector back for many texts sent

    const memories = Array.from({ length: 20 }, (_, i) => memory(`m${i}.md`, `memory ${i}`))
    const result = await preFilterMemoriesByEmbedding('query', memories, new AbortController().signal, 5)

    expect(result).toEqual(memories)
  })

  test('default topK matches the exported constant', async () => {
    const memories = Array.from({ length: EMBEDDING_PREFILTER_TOP_K + 5 }, (_, i) =>
      memory(`m${i}.md`, `memory ${i}`),
    )
    globalThis.fetch = mockEmbedFetch(
      Array.from({ length: memories.length + 1 }, () => [1, 0]),
    )

    const result = await preFilterMemoriesByEmbedding('query', memories, new AbortController().signal)
    expect(result).toHaveLength(EMBEDDING_PREFILTER_TOP_K)
  })
})
