import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { DocumentQATool } from './DocumentQATool.js'

// Real end-to-end test against the running python-bridge server. Not part
// of the fast suite — run explicitly:
//   bun test src/tools/DocumentQATool/DocumentQATool.live.test.ts

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}
test('real bridge: extracts the correct answer from a passage', async () => {
  const result = await DocumentQATool.call(
    {
      question: 'What color is the sky?',
      context:
        'On a clear day, the sky appears blue due to Rayleigh scattering of sunlight in the atmosphere.',
    },
    fakeContext(),
    )
  console.error('RESULT:', result.data)
  expect(result.data.answer.toLowerCase()).toContain('blue')
  expect(result.data.score).toBeGreaterThan(0.5)
}, 60000)
