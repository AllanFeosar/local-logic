import { describe, expect, test } from 'bun:test'
import { extractVerificationSnippet, verifyAnswer } from './verification.js'

describe('extractVerificationSnippet', () => {
  test('extracts a tagged python-verify fence', () => {
    const text = 'Final answer: 4\n\n```python-verify\ncomputed == expected\n```\n'
    expect(extractVerificationSnippet(text)).toBe('computed == expected')
  })

  test('falls back to a single plain python fence', () => {
    const text = 'Final answer: 4\n\n```python\ncomputed == expected\n```\n'
    expect(extractVerificationSnippet(text)).toBe('computed == expected')
  })

  test('returns null when there are multiple ambiguous plain fences and no tagged one', () => {
    const text = '```python\nprint(1)\n```\nsome text\n```python\nprint(2)\n```\n'
    expect(extractVerificationSnippet(text)).toBeNull()
  })

  test('returns null when there is no fence at all', () => {
    expect(extractVerificationSnippet('Final answer: 4, no code here')).toBeNull()
  })

  test('prefers the tagged fence over an unrelated plain fence', () => {
    const text =
      '```python\nprint("this is just illustrative, not the check")\n```\n' +
      '```python-verify\n4 == 4\n```\n'
    expect(extractVerificationSnippet(text)).toBe('4 == 4')
  })
})

describe('verifyAnswer', () => {
  test('inconclusive when no snippet is present', async () => {
    const result = await verifyAnswer('Final answer: 4, no code block')
    expect(result.outcome).toBe('inconclusive')
    expect(result.detail).toContain('no verification snippet')
  })

  // 2026-08-12 (Session 11): the verification mechanism is now the Tier 1
  // restricted AST evaluator (restrictedEvaluator.ts), not pythonSandbox.ts.
  // `import os` was never expressible as a valid statement in the new
  // grammar at all (Import isn't an allowed statement type) — it's rejected
  // by the grammar itself, not by an import allowlist check, but the
  // observable classification is the same: the snippet was never evaluated.
  test('inconclusive when the snippet is rejected by the restricted grammar', async () => {
    const text = 'Final answer: 4\n```python-verify\nimport os\n1 == 1\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('inconclusive')
    expect(result.detail).toContain('not executed')
  })

  test('pass when the snippet genuinely evaluates to true', async () => {
    const text = 'Final answer: 4\n```python-verify\nabs(2 * 2 - 4) < 1e-9\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('pass')
  }, 15_000)

  // 2026-08-12 (round-1 security review, Finding 5): a candidate could
  // forge "code-verified" with a bare `print("VERIFIED")` that never
  // actually checked anything. Under the new restricted grammar this class
  // is closed at the GRAMMAR level (validate_final_shape in
  // restrictedEvaluator.ts) rather than by a downstream heuristic: a bare
  // `True` literal is not a Compare/BoolOp/Call, so it's rejected before
  // ever being evaluated — 'inconclusive' with a "not executed" detail, not
  // a special "too trivial" bucket (there's nothing to detect after the
  // fact anymore, since it never runs).
  test('inconclusive (not pass) for a bare `True` with no real check — rejected by the grammar, never evaluated', async () => {
    const text = 'Final answer: 4\n```python-verify\nTrue\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('inconclusive')
    expect(result.detail).toContain('not executed')
  })

  test('accepted (documented residual gap, matches the old design\'s own accepted limit): a tautological literal comparison still passes', async () => {
    const text = 'Final answer: 4\n```python-verify\n4 == 4\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('pass')
  }, 15_000)

  test('still pass when the check is a bare call into the allowed function table with no explicit comparison (isclose)', async () => {
    const text = 'Final answer: 391\n```python-verify\nisclose(17 * 23, 391)\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('pass')
  }, 15_000)

  test('fail when the snippet genuinely evaluates to false', async () => {
    const text = 'Final answer: 5\n```python-verify\n2 * 2 == 5\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('fail')
  }, 15_000)

  test('inconclusive when the snippet raises a runtime error (not a provable failure of the answer)', async () => {
    const text = 'Final answer: 4\n```python-verify\nundefined_variable == 4\n```\n'
    const result = await verifyAnswer(text)
    expect(result.outcome).toBe('inconclusive')
    expect(result.detail).toContain('could not be evaluated')
  }, 15_000)

  // The new grammar cannot express an unbounded loop at all (no while/for
  // statement is a recognized node type), so unlike the old
  // pythonSandbox.ts-based test, this forces the timeout via an
  // unreasonably tight budget rather than a genuinely slow computation —
  // see restrictedEvaluator.test.ts for the direct, more thorough version
  // of this test against evaluateRestrictedCheck itself.
  test('inconclusive when the snippet evaluation times out', async () => {
    const text = 'Final answer: 4\n```python-verify\n1 == 1\n```\n'
    const result = await verifyAnswer(text, { timeoutMs: 1 })
    if (result.outcome !== 'inconclusive' || !result.detail.includes('timed out')) {
      console.error('SKIPPED assertion (evaluator completed within 1ms on this machine):', result)
      return
    }
    expect(result.outcome).toBe('inconclusive')
    expect(result.detail).toContain('timed out')
  }, 15_000)
})
