import { expect, test } from 'bun:test'
import type { MemoryHeader } from './memoryScan.js'
import { rerankMemoriesByRelevance } from './rerank.js'

// Real end-to-end test against live Ollama + Qwen3-Reranker-0.6B. Not part of
// the fast suite — run explicitly:
//   bun test src/memdir/rerank.live.test.ts

function memory(filename: string, description: string): MemoryHeader {
  return { filename, filePath: `/memory/${filename}`, mtimeMs: 0, description, type: undefined }
}

test('real Ollama + Qwen3-Reranker-0.6B: ranks semantically relevant memories above unrelated ones', async () => {
  const memories = [
    memory('python-debugging.md', 'Tips for debugging Python stack traces and exceptions'),
    memory('cooking-pasta.md', 'How to cook al dente pasta at high altitude'),
    memory('javascript-async.md', 'Patterns for handling async/await error propagation in JavaScript'),
    memory('gardening-tomatoes.md', 'Best soil pH and watering schedule for growing tomatoes'),
    memory('rust-ownership.md', 'Explanation of borrow checker rules and lifetime annotations in Rust'),
    memory('bird-watching.md', 'Common backyard bird species and how to identify them by call'),
    // pad above RERANK_TOP_N (10) so reranking actually engages, same as
    // embeddingPreFilter's live test padding past its own threshold.
    ...Array.from({ length: 6 }, (_, i) => memory(`filler${i}.md`, `unrelated filler memory ${i}`)),
  ]

  const result = await rerankMemoriesByRelevance(
    'How do I fix a coding error in my program?',
    memories,
    new AbortController().signal,
    5,
  )

  console.error('TOP 5:', result.map(m => m.filename))
  const topFilenames = result.map(m => m.filename)
  const programmingRelated = ['python-debugging.md', 'javascript-async.md', 'rust-ownership.md']
  expect(topFilenames.some(f => programmingRelated.includes(f))).toBe(true)
}, 30000)

test('real Ollama + Qwen3-Reranker-0.6B: composes with the embedding pre-filter for genuine two-stage retrieval', async () => {
  const { preFilterMemoriesByEmbedding } = await import('./embeddingPreFilter.js')

  const memories = [
    memory('python-debugging.md', 'Tips for debugging Python stack traces and exceptions'),
    memory('cooking-pasta.md', 'How to cook al dente pasta at high altitude'),
    memory('javascript-async.md', 'Patterns for handling async/await error propagation in JavaScript'),
    memory('gardening-tomatoes.md', 'Best soil pH and watering schedule for growing tomatoes'),
    memory('rust-ownership.md', 'Explanation of borrow checker rules and lifetime annotations in Rust'),
    memory('bird-watching.md', 'Common backyard bird species and how to identify them by call'),
    ...Array.from({ length: 12 }, (_, i) => memory(`filler${i}.md`, `unrelated filler memory ${i}`)),
  ]

  const query = 'How do I fix a coding error in my program?'
  const signal = new AbortController().signal

  const recalled = await preFilterMemoriesByEmbedding(query, memories, signal, 12)
  const reranked = await rerankMemoriesByRelevance(query, recalled, signal, 5)

  console.error('RECALLED:', recalled.map(m => m.filename))
  console.error('RERANKED TOP 5:', reranked.map(m => m.filename))

  const programmingRelated = ['python-debugging.md', 'javascript-async.md', 'rust-ownership.md']
  expect(reranked.map(m => m.filename).some(f => programmingRelated.includes(f))).toBe(true)
}, 30000)
