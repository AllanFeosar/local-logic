/**
 * Observes tool_result messages flowing out of the existing tool-execution
 * loop and feeds them to an AdaptiveToolSelector, without touching how
 * tools are actually run.
 *
 * Deliberately a passive observer, not a gate: it never blocks, rewrites,
 * or reorders a tool call. It watches `runTools()`'s own output stream
 * (already yielded, unmodified) and records success/failure after the
 * fact. If this module throws, the caller swallows it — the agent loop
 * must never fail because a learning side-channel had a bug.
 */

import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Message } from '../../../types/message.js'
import { AdaptiveToolSelector } from './adaptiveToolSelector.js'

// One selector per process. Tool performance is a property of the tool
// (e.g. "WebSearch times out a lot on this network"), not of a single
// conversation, so learning persists across queries within a session.
const toolSelector = new AdaptiveToolSelector()

export function getToolSelector(): AdaptiveToolSelector {
  return toolSelector
}

/**
 * Call once per yielded `update.message` from the `runTools`/
 * `streamingToolExecutor` loop in query.ts, alongside the `toolUseBlocks`
 * for that same batch. No-ops for any message that isn't a tool_result.
 */
export function observeToolUpdateForLearning(
  message: Message | undefined,
  toolUseBlocks: readonly ToolUseBlock[],
): void {
  if (!message || message.type !== 'user') return

  try {
    const content = message.message.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as { type?: string }).type !== 'tool_result'
      ) {
        continue
      }
      const toolResult = block as {
        type: 'tool_result'
        tool_use_id: string
        is_error?: boolean
      }
      const matchingToolUse = toolUseBlocks.find(
        t => t.id === toolResult.tool_use_id,
      )
      if (!matchingToolUse) continue

      toolSelector.updateReward(matchingToolUse.name, !toolResult.is_error)
    }
  } catch {
    // Learning is best-effort. A malformed message here must never break
    // the actual tool-result path the user is waiting on.
  }
}
