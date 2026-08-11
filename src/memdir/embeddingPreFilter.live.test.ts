import { expect, test } from 'bun:test'
import { preFilterMemoriesByEmbedding } from './embeddingPreFilter.js'
import type { MemoryHeader } from './memoryScan.js'

// Real end-to-end test against live Ollama + all-minilm. Not part of the
// fast suite — run explicitly:
//   bun test src/memdir/embeddingPreFilter.live.test.ts

function memory(filename: string, description: string): MemoryHeader {
  return { filename, filePath: `/memory/${filename}`, mtimeMs: 0, description, type: undefined }
}

test('real Ollama + all-minilm: ranks semantically relevant memories above unrelated ones', async () => {
  const memories = [
    memory('python-debugging.md', 'Tips for debugging Python stack traces and exceptions'),
    memory('cooking-pasta.md', 'How to cook al dente pasta at high altitude'),
    memory('javascript-async.md', 'Patterns for handling async/await error propagation in JavaScript'),
    memory('gardening-tomatoes.md', 'Best soil pH and watering schedule for growing tomatoes'),
    memory('rust-ownership.md', 'Explanation of borrow checker rules and lifetime annotations in Rust'),
    memory('bird-watching.md', 'Common backyard bird species and how to identify them by call'),
    // pad past the threshold so the pre-filter actually engages
    ...Array.from({ length: 12 }, (_, i) => memory(`filler${i}.md`, `unrelated filler memory ${i}`)),
  ]

  const result = await preFilterMemoriesByEmbedding(
    'How do I fix a coding error in my program?',
    memories,
    new AbortController().signal,
    5,
  )

  console.error('TOP 5:', result.map(m => m.filename))
  const topFilenames = result.map(m => m.filename)
  // At least one of the genuinely programming-related memories should
  // outrank the unrelated ones (cooking/gardening/bird-watching).
  const programmingRelated = ['python-debugging.md', 'javascript-async.md', 'rust-ownership.md']
  expect(topFilenames.some(f => programmingRelated.includes(f))).toBe(true)
}, 30000)
