import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { DataAnalyzeTool } from './DataAnalyzeTool.js'

// Real end-to-end tests against the running python-bridge server. Not part
// of the fast suite — run explicitly:
//   bun test src/tools/DataAnalyzeTool/DataAnalyzeTool.live.test.ts
//
// As of 2026-08-12 these routes (/table-qa, /tabular-predict, /forecast)
// are being built in parallel by python-bridge-agent per the contract in
// .claude/contracts/tool-contract.md's "Planned routes (2026-08-12)"
// section, and may not be live yet — that's expected, not a bug in this
// file. If they're down, these tests fail with the tool's own
// "Could not reach the local model bridge" / non-2xx error, same as the
// other three local-AI tools' live tests would.

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

test('real bridge: answers a grounded question about a small table', async () => {
  const result = await DataAnalyzeTool.call(
    {
      operation: 'question',
      question: 'Which city has the highest population?',
      table: {
        columns: ['City', 'Population'],
        rows: [
          ['Springfield', '120000'],
          ['Shelbyville', '95000'],
          ['Ogdenville', '60000'],
        ],
      },
    },
    fakeContext(),
  )
  console.error('QUESTION RESULT:', result.data)
  expect(result.data.operation).toBe('question')
  expect(result.data.answer?.toLowerCase()).toContain('springfield')
}, 60000)

test('real bridge: predicts a class label from small labeled tabular data', async () => {
  const result = await DataAnalyzeTool.call(
    {
      operation: 'predict',
      task: 'classify',
      train_features: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 2], [2, 3]],
      train_labels: ['low', 'low', 'low', 'low', 'high', 'high'],
      test_features: [[2, 2.5]],
    },
    fakeContext(),
  )
  console.error('PREDICT RESULT:', result.data)
  expect(result.data.operation).toBe('predict')
  expect(result.data.predictions?.length).toBe(1)
}, 60000)

test('real bridge: forecasts a short numeric series', async () => {
  const result = await DataAnalyzeTool.call(
    { operation: 'forecast', series: [10, 12, 14, 16, 18, 20], horizon: 3 },
    fakeContext(),
  )
  console.error('FORECAST RESULT:', result.data)
  expect(result.data.operation).toBe('forecast')
  expect(result.data.forecast?.length).toBe(3)
}, 60000)
