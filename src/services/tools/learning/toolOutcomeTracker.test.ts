import { describe, expect, test } from 'bun:test'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Message } from '../../../types/message.js'
import { AdaptiveToolSelector } from './adaptiveToolSelector.js'
import { getToolSelector, observeToolUpdateForLearning } from './toolOutcomeTracker.js'

function toolUse(id: string, name: string): ToolUseBlock {
  return { type: 'tool_use', id, name, input: {} } as ToolUseBlock
}

function userToolResult(
  toolUseId: string,
  isError: boolean,
): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError },
      ],
    },
  } as unknown as Message
}

describe('observeToolUpdateForLearning', () => {
  test('records a success against the matching tool by id', () => {
    const selector = getToolSelector()
    selector.reset()
    const blocks = [toolUse('t1', 'Bash')]

    observeToolUpdateForLearning(userToolResult('t1', false), blocks)

    const diag = selector.getDiagnostics(['Bash'])
    expect(diag.sampleCounts.get('Bash')).toBe(1)
  })

  test('records a failure when is_error is true', () => {
    const selector = getToolSelector()
    selector.reset()
    const blocks = [toolUse('t1', 'Bash')]

    observeToolUpdateForLearning(userToolResult('t1', true), blocks)
    // score should reflect one failure: (0+1)/(0+1+2) = 1/3
    const score = selector.getSelectionScores(['Bash']).get('Bash')!
    expect(score).toBeCloseTo(1 / 3, 10)
  })

  test('ignores messages that are not user/tool_result (assistant text, etc.)', () => {
    const selector = getToolSelector()
    selector.reset()
    const notAToolResult = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as Message

    observeToolUpdateForLearning(notAToolResult, [toolUse('t1', 'Bash')])
    expect(selector.getDiagnostics(['Bash']).sampleCounts.size).toBe(0)
  })

  test('ignores a tool_result whose tool_use_id has no matching block (does not throw)', () => {
    const selector = getToolSelector()
    selector.reset()
    expect(() =>
      observeToolUpdateForLearning(userToolResult('unknown-id', false), [
        toolUse('t1', 'Bash'),
      ]),
    ).not.toThrow()
    expect(selector.getDiagnostics(['Bash']).sampleCounts.size).toBe(0)
  })

  test('handles undefined message without throwing', () => {
    expect(() =>
      observeToolUpdateForLearning(undefined, [toolUse('t1', 'Bash')]),
    ).not.toThrow()
  })

  test('attributes multiple tool_result blocks in one message to their own tools', () => {
    const selector = getToolSelector()
    selector.reset()
    const blocks = [toolUse('t1', 'Bash'), toolUse('t2', 'Read')]
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
          { type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: true },
        ],
      },
    } as unknown as Message

    observeToolUpdateForLearning(message, blocks)

    expect(selector.getSelectionScores(['Bash']).get('Bash')).toBeCloseTo(2 / 3, 10) // 1 success
    expect(selector.getSelectionScores(['Read']).get('Read')).toBeCloseTo(1 / 3, 10) // 1 failure
  })

  test('getToolSelector returns the same singleton across calls', () => {
    expect(getToolSelector()).toBe(getToolSelector())
    expect(getToolSelector()).toBeInstanceOf(AdaptiveToolSelector)
  })
})
