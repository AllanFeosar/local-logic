import { expect, test } from 'bun:test'
import { solveDeep } from './solveDeep.js'

// Real end-to-end test against live Ollama + VibeThinker-3B + Qwen3-Reranker
// + a real local Python interpreter. Not part of the fast suite — run
// explicitly:
//   bun test src/tools/AskMathModelTool/deepSolve/solveDeep.live.test.ts
//
// This exercises the actual generate -> verify -> search pipeline for real:
// a real HTTP call per candidate, a real python.exe subprocess per
// verification attempt, and (if no candidate is code-verified) a real
// reranker call. Deliberately kept to n:2 and a problem simple enough that
// VibeThinker should nail it (fast, cheap sanity check that the whole wire
// actually works) — the eval harness (scripts/eval/deepSolveEval.ts) is
// where the real pipeline-vs-single-shot comparison on harder problems
// lives; this test's only job is "does the real end-to-end wiring work at
// all", not "is the pipeline good".
test('real Ollama + VibeThinker-3B + Qwen3-Reranker + real Python: solves a problem end-to-end via the deep pipeline', async () => {
  const result = await solveDeep('What is 17 * 23? Show your final answer clearly.', new AbortController().signal, {
    n: 2,
  })

  console.error('ANSWER:', result.answer)
  console.error('VERIFIED:', result.verified)
  console.error('METHOD:', result.method)
  console.error('CANDIDATES:', {
    generated: result.candidatesGenerated,
    passed: result.candidatesPassed,
    failed: result.candidatesFailed,
    inconclusive: result.candidatesInconclusive,
  })
  console.error('RETRIED:', result.retried)
  console.error('DURATION_MS:', result.durationMs)

  expect(result.answer.length).toBeGreaterThan(0)
  expect(result.answer).toContain('391')
  // Not asserting `verified: true` unconditionally — a 3B model's
  // self-generated verification snippet may not always be well-formed on a
  // given run (see the eval report for the measured real-world rate). The
  // pipeline's own contract is "never throw, always return something
  // usable, be honest about whether it was proven" — that's what this test
  // actually checks.
  expect(['code-verified', 'reranker-scored', 'self-consistency', 'best-effort-unverified']).toContain(
    result.method,
  )
}, 900_000)
