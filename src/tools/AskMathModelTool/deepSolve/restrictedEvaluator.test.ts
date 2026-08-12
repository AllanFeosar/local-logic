import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetPythonInterpreterCacheForTests,
  evaluateRestrictedCheck,
  type RestrictedEvalResult,
} from './restrictedEvaluator.js'

/**
 * Thorough tests for the Tier 1 restricted AST evaluator — see
 * restrictedEvaluator.ts's own header comment for the full design/safety
 * argument this file exercises. Every test here spawns a real local Python
 * interpreter (the evaluator's own process-hygiene layer, not a mock) —
 * matching pythonSandbox.test.ts's existing convention, tests degrade
 * gracefully (skip with a console message) if no interpreter is found on
 * PATH in this environment rather than failing.
 */

async function evalOrSkip(code: string, opts?: { timeoutMs?: number }): Promise<RestrictedEvalResult | null> {
  const result = await evaluateRestrictedCheck(code, opts)
  if (!result.executed && /no Python interpreter/.test(result.rejectionReason)) {
    console.error('SKIPPED (no local python interpreter found on PATH):', result.rejectionReason)
    return null
  }
  return result
}

function expectResult(result: RestrictedEvalResult, value: boolean) {
  expect(result.executed).toBe(true)
  if (!result.executed) return
  expect(result.outcome.status).toBe('result')
  if (result.outcome.status === 'result') {
    expect(result.outcome.value).toBe(value)
  }
}

function expectRejected(result: RestrictedEvalResult, reasonSubstring?: string) {
  expect(result.executed).toBe(true)
  if (!result.executed) return
  expect(result.outcome.status).toBe('rejected')
  if (result.outcome.status === 'rejected' && reasonSubstring) {
    expect(result.outcome.reason.toLowerCase()).toContain(reasonSubstring.toLowerCase())
  }
}

function expectError(result: RestrictedEvalResult, reasonSubstring?: string) {
  expect(result.executed).toBe(true)
  if (!result.executed) return
  expect(result.outcome.status).toBe('error')
  if (result.outcome.status === 'error' && reasonSubstring) {
    expect(result.outcome.error.toLowerCase()).toContain(reasonSubstring.toLowerCase())
  }
}

describe('accepted — every allowed node type / operator computes correctly', () => {
  test('int/float/bool literal comparisons', async () => {
    const r = await evalOrSkip('4 == 4')
    if (!r) return
    expectResult(r, true)
  })

  test('BinOp: + - * / // % **', async () => {
    for (const [code, expected] of [
      ['2 + 3 == 5', true],
      ['5 - 3 == 2', true],
      ['4 * 5 == 20', true],
      ['7 / 2 == 3.5', true],
      ['10 // 3 == 3', true],
      ['10 % 3 == 1', true],
      ['2 ** 10 == 1024', true],
    ] as const) {
      const r = await evalOrSkip(code)
      if (!r) return
      expectResult(r, expected)
    }
  })

  test('UnaryOp: + and -', async () => {
    const r1 = await evalOrSkip('-5 + 5 == 0')
    if (!r1) return
    expectResult(r1, true)
    const r2 = await evalOrSkip('+5 == 5')
    if (!r2) return
    expectResult(r2, true)
  })

  test('Compare: == != < <= > >= and chaining', async () => {
    for (const [code, expected] of [
      ['4 != 5', true],
      ['3 < 4', true],
      ['4 <= 4', true],
      ['5 > 4', true],
      ['4 >= 4', true],
      ['1 < 2 < 3', true],
      ['1 < 5 < 3', false],
    ] as const) {
      const r = await evalOrSkip(code)
      if (!r) return
      expectResult(r, expected)
    }
  })

  test('BoolOp: and / or, with short-circuit-safe evaluation', async () => {
    const r1 = await evalOrSkip('(2 + 2 == 4) and (3 + 3 == 6)')
    if (!r1) return
    expectResult(r1, true)
    const r2 = await evalOrSkip('(2 + 2 == 5) or (3 + 3 == 6)')
    if (!r2) return
    expectResult(r2, true)
    const r3 = await evalOrSkip('(2 + 2 == 5) and (3 + 3 == 6)')
    if (!r3) return
    expectResult(r3, false)
  })

  test('Assign: local variables carried into the final check', async () => {
    const r = await evalOrSkip('computed = 17 * 23\nexpected = 391\ncomputed == expected')
    if (!r) return
    expectResult(r, true)
  })

  test('Assign: multiple statements building on each other', async () => {
    const r = await evalOrSkip('a = 10\nb = a * 2\nc = b + 5\nc == 25')
    if (!r) return
    expectResult(r, true)
  })

  describe('FUNCTION_TABLE — every allowed function', () => {
    test('sqrt', async () => {
      const r = await evalOrSkip('sqrt(4) == 2')
      if (!r) return
      expectResult(r, true)
    })
    test('abs', async () => {
      const r = await evalOrSkip('abs(-7) == 7')
      if (!r) return
      expectResult(r, true)
    })
    test('pow (2-arg)', async () => {
      const r = await evalOrSkip('pow(2, 10) == 1024')
      if (!r) return
      expectResult(r, true)
    })
    test('pow (3-arg modular exponentiation) — 7^100 mod 13 == 9', async () => {
      const r = await evalOrSkip('pow(7, 100, 13) == 9')
      if (!r) return
      expectResult(r, true)
    })
    test('gcd', async () => {
      const r = await evalOrSkip('gcd(12, 18) == 6')
      if (!r) return
      expectResult(r, true)
    })
    test('lcm', async () => {
      const r = await evalOrSkip('lcm(4, 6) == 12')
      if (!r) return
      expectResult(r, true)
    })
    test('factorial', async () => {
      const r = await evalOrSkip('factorial(5) == 120')
      if (!r) return
      expectResult(r, true)
    })
    test('min', async () => {
      const r = await evalOrSkip('min(3, 1, 2) == 1')
      if (!r) return
      expectResult(r, true)
    })
    test('max', async () => {
      const r = await evalOrSkip('max(3, 1, 2) == 3')
      if (!r) return
      expectResult(r, true)
    })
    test('round (1-arg and 2-arg)', async () => {
      const r1 = await evalOrSkip('round(3.7) == 4')
      if (!r1) return
      expectResult(r1, true)
      const r2 = await evalOrSkip('round(3.14159, 2) == 3.14')
      if (!r2) return
      expectResult(r2, true)
    })
    test('floor', async () => {
      const r = await evalOrSkip('floor(3.9) == 3')
      if (!r) return
      expectResult(r, true)
    })
    test('ceil', async () => {
      const r = await evalOrSkip('ceil(3.1) == 4')
      if (!r) return
      expectResult(r, true)
    })
    test('sum', async () => {
      const r = await evalOrSkip('sum(1, 2, 3, 4) == 10')
      if (!r) return
      expectResult(r, true)
    })
    test('isclose — float-tolerant equality, usable as the final check on its own', async () => {
      const r = await evalOrSkip('isclose(0.1 + 0.2, 0.3)')
      if (!r) return
      expectResult(r, true)
    })
  })

  test('final shape: bare Call to isclose is a valid check (no Compare needed)', async () => {
    const r = await evalOrSkip('isclose(17 * 23, 391)')
    if (!r) return
    expectResult(r, true)
  })
})

describe('rejected — every category of disallowed construct is refused, never evaluated', () => {
  test('import statement', async () => {
    const r = await evalOrSkip('import os\n1 == 1')
    if (!r) return
    expectRejected(r, 'import')
  })

  test('from-import statement', async () => {
    const r = await evalOrSkip('from os import system\n1 == 1')
    if (!r) return
    expectRejected(r, 'import')
  })

  test('attribute access of any kind', async () => {
    const r = await evalOrSkip('x = (1).__class__\n1 == 1')
    if (!r) return
    expectRejected(r, 'attribute')
  })

  test('eval/exec as bare identifiers used as a call target', async () => {
    const r1 = await evalOrSkip("eval('1') == 1")
    if (!r1) return
    expectRejected(r1, 'not in the allowed table')
    const r2 = await evalOrSkip("exec('1') == 1")
    if (!r2) return
    expectRejected(r2, 'not in the allowed table')
  })

  test('open/getattr/setattr/__import__/print as call targets', async () => {
    for (const code of [
      "open('x') == 1",
      "getattr(1, 'x') == 1",
      "setattr(1, 'x', 1) == 1",
      "__import__('os') == 1",
      "print(1) == 1",
    ]) {
      const r = await evalOrSkip(code)
      if (!r) return
      expectRejected(r, 'not in the allowed table')
    }
  })

  test('a bare dangerous identifier with no call at all is inert (undefined variable at runtime), not specially banned', async () => {
    // There is no dangerous-name list in this design (see header comment) —
    // `__class__` is syntactically just a Name, accepted by the grammar
    // like any other identifier, but it was never assigned locally, so it
    // fails at evaluation time exactly like any other typo'd variable name
    // would, with the same generic error — not a special-cased rejection.
    const r = await evalOrSkip('__class__ == __class__')
    if (!r) return
    expectError(r, 'undefined variable')
  })

  test('lambda', async () => {
    const r = await evalOrSkip('f = lambda: 1\n1 == 1')
    if (!r) return
    expectRejected(r, 'disallowed node type')
  })

  test('list/set/dict/generator comprehensions', async () => {
    for (const code of ['x = [i for i in [1]]\n1 == 1', 'x = {i for i in [1]}\n1 == 1']) {
      const r = await evalOrSkip(code)
      if (!r) return
      expectRejected(r)
    }
  })

  test('f-strings (JoinedStr)', async () => {
    const r = await evalOrSkip('x = f"{1}"\n1 == 1')
    if (!r) return
    expectRejected(r)
  })

  test('subscript access', async () => {
    const r = await evalOrSkip('x = 5\nx[0] == 1')
    if (!r) return
    expectRejected(r, 'disallowed node type')
  })

  test('keyword arguments in a call', async () => {
    const r = await evalOrSkip('round(3.14159, ndigits=2) == 3.14')
    if (!r) return
    expectRejected(r, 'keyword')
  })

  test('ternary conditional (IfExp) — deliberately not on the allowlist', async () => {
    const r = await evalOrSkip('(1 if True else 2) == 1')
    if (!r) return
    expectRejected(r, 'disallowed node type')
  })

  test('`not` — deliberately excluded from UnaryOp (only + and - are allowed)', async () => {
    const r = await evalOrSkip('not (1 == 2)')
    if (!r) return
    expectRejected(r, 'disallowed unary operator')
  })

  test('string/bytes constants', async () => {
    const r1 = await evalOrSkip("x = 'hello'\n1 == 1")
    if (!r1) return
    expectRejected(r1, 'only numeric')
    const r2 = await evalOrSkip("x = b'hello'\n1 == 1")
    if (!r2) return
    expectRejected(r2, 'only numeric')
  })

  test('tuple/list assignment targets', async () => {
    const r = await evalOrSkip('a, b = 1, 2\na == 1')
    if (!r) return
    expectRejected(r)
  })

  test('other statement types: while/for/if/def/class/raise/try/with/global', async () => {
    for (const code of [
      'while True:\n    pass',
      'for i in [1]:\n    pass',
      'if True:\n    x = 1',
      'def f():\n    return 1',
      'class C:\n    pass',
      'raise ValueError()',
      'try:\n    pass\nexcept Exception:\n    pass',
      'with open("x"):\n    pass',
      'global x',
    ]) {
      const r = await evalOrSkip(code)
      if (!r) return
      expectRejected(r)
    }
  })

  test('final statement is a bare value/variable/arithmetic expression, not a genuine check', async () => {
    const r1 = await evalOrSkip('17 * 23')
    if (!r1) return
    expectRejected(r1, 'must itself be a comparison')
    const r2 = await evalOrSkip('True')
    if (!r2) return
    expectRejected(r2, 'must itself be a comparison')
    const r3 = await evalOrSkip('ok = (1 == 1)\nok')
    if (!r3) return
    expectRejected(r3, 'must itself be a comparison')
  })

  test('an assignment as the final statement (no check at all)', async () => {
    const r = await evalOrSkip('x = 1')
    if (!r) return
    expectRejected(r, 'not an assignment')
  })

  test('a call to a function not in the table, even one that sounds plausible', async () => {
    const r = await evalOrSkip('log(4) == 1')
    if (!r) return
    expectRejected(r, 'not in the allowed table')
  })

  test('empty snippet', async () => {
    const result = await evaluateRestrictedCheck('   ')
    expect(result.executed).toBe(false)
    if (result.executed) return
    expect(result.rejectionReason).toContain('empty')
  })

  test('oversized snippet is rejected before ever spawning a process', async () => {
    const result = await evaluateRestrictedCheck(`${'1'.repeat(5_000)} == 1`)
    expect(result.executed).toBe(false)
    if (result.executed) return
    expect(result.rejectionReason).toContain('exceeds')
  })
})

describe('regression — exact exploit payloads from the three retired pythonSandbox.ts security rounds, confirmed inert here', () => {
  // These are not expected to be "reachable" in this design at all — the
  // grammar cannot express any of them, so this is a permanent record that
  // the new mechanism closes what the old one didn't, not a defense against
  // an actually-live threat in this file.

  test('round 1 finding: aliased dangerous builtin (z = __import__; z(...))', async () => {
    const r = await evalOrSkip("z = __import__\nz('os') == 1")
    if (!r) return
    // The assignment itself is grammatically fine (`__import__` is just a
    // Name reference) but z is never a function-table entry, so calling it
    // is rejected outright — the exact aliasing bypass that took repeated
    // denylist patches to close in the old design doesn't need closing here
    // because there is no path from "a local variable" to "something
    // callable" at all.
    expectRejected(r, 'not in the allowed table')
  })

  test('round 1 finding: operator.attrgetter/methodcaller getattr-equivalent', async () => {
    const r = await evalOrSkip("x = operator.attrgetter('os')\n1 == 1")
    if (!r) return
    expectRejected(r) // `operator` itself is an undefined Name; also Attribute is unreachable
  })

  test('round 2 finding: typing.get_type_hints string-annotation eval RCE', async () => {
    const r = await evalOrSkip(
      'import typing\ndef _c():\n    pass\ntyping.get_type_hints(_c)\n1 == 1',
    )
    if (!r) return
    expectRejected(r) // `import typing` alone is already rejected (disallowed statement)
  })

  test('round 2 finding: enum.bltns.__import__(...) attribute-chase RCE', async () => {
    const r = await evalOrSkip("x = enum.bltns.__import__('os')\n1 == 1")
    if (!r) return
    expectRejected(r) // `enum` undefined; Attribute unreachable regardless
  })

  test('round 2 finding: str.format globals-leak', async () => {
    const r = await evalOrSkip('x = "{0.__class__}".format(1)\n1 == 1')
    if (!r) return
    // Rejected on two independent grounds: the call target is `.format`, an
    // Attribute expression (not a bare Name in the fixed function table),
    // and separately string constants aren't allowed literals at all either
    // way — either would close this by itself.
    expectRejected(r, 'fixed function name')
  })

  test('round 3 finding: dataclasses.inspect.os.system(...) — the live full-RCE finding', async () => {
    const r = await evalOrSkip("dataclasses.inspect.os.system('echo PWNED') == 0")
    if (!r) return
    // `dataclasses` is an undefined Name (no import statement is even
    // reachable), and even if it somehow were, Attribute is not a
    // recognized node type at all — this is the finding that ended the
    // pythonSandbox.ts approach; confirmed inert here by construction, not
    // by adding `dataclasses`/`inspect`/`os` to a denylist.
    expectRejected(r)
  })

  test('round 3 finding, alternate path: statistics._random._os', async () => {
    const r = await evalOrSkip('statistics._random._os == 1')
    if (!r) return
    expectRejected(r) // `statistics` undefined; Attribute unreachable regardless
  })
})

describe('runtime errors — grammar-accepted but not evaluable, classified as "error" (inconclusive upstream), never a false pass', () => {
  test('division, floor-division, and modulo by zero', async () => {
    for (const code of ['5 / 0 == 5', '5 // 0 == 5', '5 % 0 == 5']) {
      const r = await evalOrSkip(code)
      if (!r) return
      expectError(r, 'division by zero')
    }
  })

  test('undefined variable reference', async () => {
    const r = await evalOrSkip('undefined_var == 5')
    if (!r) return
    expectError(r, 'undefined variable')
  })

  test('wrong number of arguments to a table function', async () => {
    const r = await evalOrSkip('sqrt(1, 2) == 1')
    if (!r) return
    expectError(r, 'wrong number of arguments')
  })

  test('factorial argument out of the allowed range', async () => {
    const r1 = await evalOrSkip('factorial(-1) == 1')
    if (!r1) return
    expectError(r1)
    const r2 = await evalOrSkip('factorial(999999) == 1')
    if (!r2) return
    expectError(r2, 'out of the allowed range')
  })

  test('exponent magnitude bound (** and pow 2-arg)', async () => {
    const r1 = await evalOrSkip('2 ** 999999 == 2 ** 999999')
    if (!r1) return
    expectError(r1, 'exceeds the allowed bound')
    const r2 = await evalOrSkip('pow(2, 999999) == pow(2, 999999)')
    if (!r2) return
    expectError(r2, 'exceeds the allowed bound')
  })

  test('sqrt of a negative number', async () => {
    const r = await evalOrSkip('sqrt(-1) == 1')
    if (!r) return
    expectError(r, 'negative')
  })
})

describe('audit round 4 (2026-08-12) fixes — non-finite literals and multi-statement Pow blowup', () => {
  // Independent security-audit-agent review found these two correctness
  // gaps (neither is code-execution/capability-leak — the audit's verdict
  // was SAFE TO SHIP with these as non-blocking follow-ups): a snippet could
  // resolve to a false "code-verified true" via an unbounded/undefined
  // numeric value slipping past every bound, which defeats the entire point
  // of a *verification* mechanism even though nothing dangerous is
  // reachable. Both are now closed; regression-tested here so they can't
  // silently regress.

  test('an overflowing float literal (parses to inf without a SyntaxError) is rejected, not silently planted into env', async () => {
    const r1 = await evalOrSkip('1e400 > 0')
    if (!r1) return
    expectError(r1, 'not a finite number')

    const r2 = await evalOrSkip('x = 1e400\nx > 0')
    if (!r2) return
    expectError(r2, 'not a finite number')
  })

  test('NaN cannot be smuggled to a false "true" via a self-inequality (nan != nan)', async () => {
    // Before the fix: _finalize's `abs(value) > MAX_ABS_VALUE` check is
    // False for NaN (all comparisons against NaN are False in Python), so
    // this would have silently returned {status: 'result', value: true} —
    // a genuinely false "code-verified" pass on an undefined computation.
    const r = await evalOrSkip('x = 1e400\ny = x - x\ny != y')
    if (!r) return
    expectError(r, 'not a finite number')
  })

  test('a large-int base raised to a bounded exponent is rejected before the eager ** computation, not merely killed by the process timeout', async () => {
    // `10 ** 10000` alone is legal (within MAX_ABS_VALUE). Raising that
    // result to another bounded-looking exponent (10000) used to only be
    // stopped by the process timeout, computing a real ~100-million-digit
    // integer in the meantime — this asserts it now rejects promptly
    // instead, via the log10-estimate pre-check.
    const start = Date.now()
    const r = await evalOrSkip('x = 10 ** 10000\nx ** 10000 == 0', { timeoutMs: 5_000 })
    if (!r) return
    expectError(r, 'magnitude too large')
    // Should reject well within a second — proves it's a pre-check, not the
    // 5s timeout firing.
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test('legitimate Pow chains that stay within MAX_ABS_VALUE are unaffected', async () => {
    const r = await evalOrSkip('x = 2 ** 10\nx ** 2 == 1048576')
    if (!r) return
    expectResult(r, true)
  })
})

describe('honest documented residual gap: a tautological literal comparison is accepted, not a security issue', () => {
  test('4 == 4 is a valid, accepted check even though it proves nothing about the candidate\'s answer', async () => {
    const r = await evalOrSkip('4 == 4')
    if (!r) return
    // Matches the same residual gap pythonSandbox.ts's own Finding 5 fix
    // documented and accepted (see this file's header comment) — a
    // correctness concern for the pipeline's confidence signal, not a
    // security concern, since a trivial check still can't execute anything.
    expectResult(r, true)
  })
})

describe('evaluateRestrictedCheck plumbing', () => {
  beforeEach(() => {
    // Earlier describe blocks in this file already resolved and cached the
    // real interpreter path via evalOrSkip — reset before AND after each
    // test here so an env-var override actually takes effect (the resolver
    // checks the cache before the override) and so this block never leaks
    // its own overrides into later tests.
    _resetPythonInterpreterCacheForTests()
  })
  afterEach(() => {
    _resetPythonInterpreterCacheForTests()
  })

  test('fails closed (executed:false) when no interpreter is configured/found', async () => {
    const previous = process.env.MATH_VERIFY_PYTHON_PATH
    process.env.MATH_VERIFY_PYTHON_PATH = 'this-interpreter-does-not-exist-anywhere'
    try {
      const result = await evaluateRestrictedCheck('1 == 1')
      expect(result.executed).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.MATH_VERIFY_PYTHON_PATH
      else process.env.MATH_VERIFY_PYTHON_PATH = previous
    }
  })

  test('an unreasonably tight timeout is honored (process spawn alone exceeds it), never hangs', async () => {
    const result = await evaluateRestrictedCheck('1 == 1', { timeoutMs: 1 })
    // The grammar itself cannot express an unbounded loop (no `while`/`for`
    // is a recognized statement type at all), so unlike pythonSandbox.ts's
    // "genuine infinite loop" timeout test, this exercises the same
    // execa-level timeout/kill mechanism via a budget too small for even
    // Python interpreter startup to complete in — confirms the timeout is
    // real and enforced regardless of how fast the computation itself is.
    if (result.executed) {
      // Extremely fast machine/cached interpreter startup — the computation
      // finished within 1ms. Not a failure of the mechanism, just means
      // this environment couldn't reproduce the timeout via this budget.
      console.error('SKIPPED assertion (evaluator completed within 1ms on this machine)')
      return
    }
    expect(result.timedOut).toBe(true)
  }, 10_000)
})
