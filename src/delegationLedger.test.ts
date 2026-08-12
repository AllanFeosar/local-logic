import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runWithCwdOverride } from './utils/cwd.js'
import { classifyDelegationOutcome, logDelegationDecision } from './delegationLedger.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-ledger-'))
  tempDirs.push(dir)
  return dir
}

function readLedgerLines(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, 'reports', 'delegation-ledger.jsonl')
  const raw = readFileSync(path, 'utf8')
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

function toolResultMessage(toolUseId: string, isError: boolean, content: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }],
    },
  }
}

function humanTextMessage(text: string) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}

describe('classifyDelegationOutcome', () => {
  test('success when not an error', () => {
    expect(classifyDelegationOutcome(false, null)).toBe('success')
    expect(classifyDelegationOutcome(undefined, null)).toBe('success')
  })

  test('error when is_error but not a "no such tool" message', () => {
    expect(classifyDelegationOutcome(true, 'DataAnalyze request to /table-qa failed: 404')).toBe('error')
  })

  test('hallucinated-tool when the error matches the exact "No such tool available" wording', () => {
    expect(classifyDelegationOutcome(true, 'Error: No such tool available: MadeUpTool')).toBe(
      'hallucinated-tool',
    )
  })
})

describe('logDelegationDecision', () => {
  test('appends a ledger line with a hashed (not raw) query summary', () => {
    const cwd = makeTempCwd()
    const toolUseBlocks = [{ id: 'call_1', name: 'AskMathModel' }]
    const conversation = [humanTextMessage('What is 847 x 293?')]

    runWithCwdOverride(cwd, () => {
      logDelegationDecision(
        toolResultMessage('call_1', false, '248171'),
        toolUseBlocks,
        conversation,
        Date.now() - 1234,
      )
    })

    const lines = readLedgerLines(cwd)
    expect(lines).toHaveLength(1)
    const entry = lines[0]!
    expect(entry.tool).toBe('AskMathModel')
    expect(entry.outcome).toBe('success')
    expect(typeof entry.latencyMs).toBe('number')
    expect(entry.latencyMs as number).toBeGreaterThanOrEqual(0)

    // Never the raw query text, and never a substring of it either.
    expect(entry.querySummary).not.toBe('What is 847 x 293?')
    expect(JSON.stringify(entry)).not.toContain('847')
    expect(entry.querySummary).toBe(
      createHash('sha256').update('What is 847 x 293?').digest('hex').slice(0, 16),
    )
  })

  test('classifies a hallucinated tool call from the tool_result content', () => {
    const cwd = makeTempCwd()
    const toolUseBlocks = [{ id: 'call_2', name: 'Skill' }]
    const conversation = [humanTextMessage('What is 12 * 7?')]

    runWithCwdOverride(cwd, () => {
      logDelegationDecision(
        toolResultMessage('call_2', true, 'Error: No such tool available: math'),
        toolUseBlocks,
        conversation,
        Date.now(),
      )
    })

    const [entry] = readLedgerLines(cwd)
    expect(entry!.outcome).toBe('hallucinated-tool')
    expect(entry!.tool).toBe('Skill')
  })

  test('skips tool-result-only user messages when finding the query, uses the last real human text', () => {
    const cwd = makeTempCwd()
    const toolUseBlocks = [{ id: 'call_3', name: 'DocumentQA' }]
    const conversation = [
      humanTextMessage('first question'),
      toolResultMessage('call_0', false, 'irrelevant prior tool result'),
      humanTextMessage('second question'),
    ]

    runWithCwdOverride(cwd, () => {
      logDelegationDecision(
        toolResultMessage('call_3', false, 'answer'),
        toolUseBlocks,
        conversation,
        Date.now(),
      )
    })

    const [entry] = readLedgerLines(cwd)
    expect(entry!.querySummary).toBe(
      createHash('sha256').update('second question').digest('hex').slice(0, 16),
    )
  })

  test('is a no-op for non-user messages', () => {
    const cwd = makeTempCwd()
    runWithCwdOverride(cwd, () => {
      logDelegationDecision(
        { type: 'assistant', message: { content: [] } },
        [{ id: 'call_4', name: 'AskMathModel' }],
        [],
        Date.now(),
      )
    })
    expect(() => readLedgerLines(cwd)).toThrow()
  })

  test('is a no-op when no tool_use_id matches this batch', () => {
    const cwd = makeTempCwd()
    runWithCwdOverride(cwd, () => {
      logDelegationDecision(
        toolResultMessage('call_unrelated', false, 'x'),
        [{ id: 'call_5', name: 'AskMathModel' }],
        [],
        Date.now(),
      )
    })
    expect(() => readLedgerLines(cwd)).toThrow()
  })

  test('never throws on malformed input', () => {
    const cwd = makeTempCwd()
    expect(() =>
      runWithCwdOverride(cwd, () => {
        logDelegationDecision(null, [], [], Date.now())
        logDelegationDecision(undefined, undefined as unknown as [], undefined as unknown as [], Date.now())
        logDelegationDecision({ type: 'user' }, [], [], Date.now())
      }),
    ).not.toThrow()
  })
})
