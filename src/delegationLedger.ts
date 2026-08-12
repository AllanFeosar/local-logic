/**
 * Delegation ledger — cheap, append-only instrumentation for tool-routing
 * decisions (LOCAL_AI_MASTER_PLAN.md §7 — "the cheap, honest version of
 * self-improvement": no fine-tuning, just measured iteration).
 *
 * Passive observer, mirrors the shape/contract of
 * services/tools/learning/toolOutcomeTracker.ts's observeToolUpdateForLearning:
 * called once per yielded `update.message` from the runTools/
 * streamingToolExecutor loop in query.ts, alongside that batch's
 * `toolUseBlocks`. Never blocks, rewrites, or reorders a tool call — just
 * watches the already-yielded, unmodified tool_result stream and appends a
 * line after the fact. Never throws: a bug here must not break the agent
 * loop the user is waiting on.
 *
 * Deliberately logs only: tool name, a one-way hash of the triggering human
 * query (never raw text — the query could contain sensitive content), a
 * coarse outcome, and a latency estimate. Never logs tool arguments or tool
 * results, which routinely contain file contents, passages, or other
 * sensitive material.
 *
 * Not typed against ./types/message.js — that file is missing from this
 * fork's tree (a pre-existing, already-documented gap; see the ~4100
 * pre-existing `tsc --noEmit` baseline). Message/tool-result shapes below
 * are duck-typed defensively instead, same approach toolOutcomeTracker.ts
 * already uses for the tool_result block itself.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getCwd } from './utils/cwd.js'

export type DelegationOutcome = 'success' | 'error' | 'hallucinated-tool'

export type DelegationLedgerEntry = {
  timestamp: string
  tool: string
  /** SHA-256 (first 16 hex chars) of the triggering human query text, or
   * null if no human query text could be found. Never the raw query. */
  querySummary: string | null
  outcome: DelegationOutcome
  latencyMs: number
}

const LEDGER_DIR_NAME = 'reports'
const LEDGER_FILE_NAME = 'delegation-ledger.jsonl'
/** Matches the exact wording services/tools/toolExecution.ts uses when a
 * tool_use references a tool name that isn't registered at all — the
 * clearest available signal that a routing decision was a hallucination,
 * not just an ordinary tool-level failure. */
const HALLUCINATED_TOOL_MARKER = 'No such tool available:'

function hashQuerySummary(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

type DuckTypedContentBlock = { type?: string; text?: string; content?: unknown }
type DuckTypedMessage = {
  type?: string
  message?: { role?: string; content?: unknown }
}

/**
 * Finds the most recent human-authored message's text (skipping
 * tool-result-only "user" messages, which aren't the human's own words),
 * for hashing into a query summary.
 */
function extractLatestUserQueryText(
  conversationMessages: readonly unknown[],
): string | null {
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i] as DuckTypedMessage | undefined
    if (!msg || msg.type !== 'user') continue

    const content = msg.message?.content
    if (typeof content === 'string') {
      if (content.trim()) return content
      continue
    }
    if (!Array.isArray(content)) continue

    const blocks = content as DuckTypedContentBlock[]
    const isToolResultMessage = blocks.some(b => b && b.type === 'tool_result')
    if (isToolResultMessage) continue

    const text = blocks
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join(' ')
      .trim()
    if (text) return text
  }
  return null
}

export function classifyDelegationOutcome(
  isError: boolean | undefined,
  resultText: string | null,
): DelegationOutcome {
  if (isError && resultText?.includes(HALLUCINATED_TOOL_MARKER)) {
    return 'hallucinated-tool'
  }
  return isError ? 'error' : 'success'
}

function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = (content as DuckTypedContentBlock[])
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join(' ')
    return text || null
  }
  return null
}

function appendLedgerLine(entry: DelegationLedgerEntry): void {
  const dir = join(getCwd(), LEDGER_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, LEDGER_FILE_NAME), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Call once per yielded `update.message` from the `runTools`/
 * `streamingToolExecutor` loop in query.ts, alongside that batch's
 * `toolUseBlocks`, the conversation messages so far (for query-summary
 * hashing), and the batch's start timestamp (`Date.now()` captured
 * immediately before the `for await` loop begins — an approximation of
 * per-tool latency, since tools in a batch typically execute concurrently).
 * No-ops for any message that isn't a tool_result. Never throws.
 */
export function logDelegationDecision(
  message: unknown,
  toolUseBlocks: readonly { id: string; name: string }[],
  conversationMessages: readonly unknown[],
  batchStartedAtMs: number,
): void {
  try {
    const msg = message as DuckTypedMessage | undefined
    if (!msg || msg.type !== 'user') return

    const content = msg.message?.content
    if (!Array.isArray(content)) return

    for (const block of content as DuckTypedContentBlock[]) {
      if (!block || block.type !== 'tool_result') continue
      const toolResult = block as {
        type: 'tool_result'
        tool_use_id?: string
        is_error?: boolean
        content?: unknown
      }
      const matchingToolUse = toolUseBlocks.find(t => t.id === toolResult.tool_use_id)
      if (!matchingToolUse) continue

      const resultText = extractResultText(toolResult.content)
      const outcome = classifyDelegationOutcome(toolResult.is_error, resultText)
      const queryText = extractLatestUserQueryText(conversationMessages)

      appendLedgerLine({
        timestamp: new Date().toISOString(),
        tool: matchingToolUse.name,
        querySummary: queryText ? hashQuerySummary(queryText) : null,
        outcome,
        latencyMs: Date.now() - batchStartedAtMs,
      })
    }
  } catch {
    // Instrumentation is best-effort only — must never break the tool
    // result path the user is waiting on.
  }
}
