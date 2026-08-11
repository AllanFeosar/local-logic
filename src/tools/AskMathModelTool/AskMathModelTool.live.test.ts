import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { AskMathModelTool } from './AskMathModelTool.js'

// Real end-to-end test against live Ollama + VibeThinker-3B. Not run as part
// of the normal fast suite — filter it in explicitly:
//   bun test src/tools/AskMathModelTool/AskMathModelTool.live.test.ts

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}
test('real Ollama + VibeThinker-3B: solves an actual math problem end-to-end', async () => {
  const result = await AskMathModelTool.call(
    { problem: 'What is 17 * 23? Show your final answer clearly.' },
    fakeContext(),
    )
  console.error('ANSWER:', result.data.answer)
  console.error('TRUNCATED:', result.data.truncated)
  console.error('DURATION_MS:', result.data.durationMs)
  expect(result.data.answer.length).toBeGreaterThan(0)
  expect(result.data.answer).toContain('391')
}, 400000)
