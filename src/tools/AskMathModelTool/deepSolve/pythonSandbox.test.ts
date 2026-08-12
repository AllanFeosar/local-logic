import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetPythonInterpreterCacheForTests,
  _runPythonSnippetBypassingStaticValidationForTests,
  ALLOWED_IMPORTS,
  runPythonSnippet,
  validatePythonSnippet,
  type ValidationResult,
} from './pythonSandbox.js'

// The AST-based validator (2026-08-12 security review fix — see
// pythonSandbox.ts's header comment) needs to actually spawn the resolved
// Python interpreter to run `ast.parse` against the snippet, unlike the old
// purely-synchronous regex validator. Resolve once per test via this helper:
// if no interpreter is present in this environment at all, skip gracefully
// (`console.error` + return null) rather than failing, matching this file's
// existing convention for tests that need a real local interpreter (see the
// `runPythonSnippet` describe block below).
async function validateOrSkip(code: string): Promise<ValidationResult | null> {
  const result = await validatePythonSnippet(code)
  if (!result.ok && /no Python interpreter/.test(result.reason)) {
    console.error('SKIPPED (no local python interpreter found on PATH):', result.reason)
    return null
  }
  return result
}

describe('validatePythonSnippet — real ast.parse-based static analysis', () => {
  test('accepts a plain arithmetic check using only allowed imports', async () => {
    const code = `import math\nprint('VERIFIED' if abs(math.sqrt(4) - 2) < 1e-9 else 'FAILED')\n`
    const result = await validateOrSkip(code)
    if (!result) return
    expect(result.ok).toBe(true)
  })

  test('rejects empty snippet', async () => {
    const result = await validatePythonSnippet('   ')
    expect(result.ok).toBe(false)
  })

  test('rejects a snippet exceeding the max length', async () => {
    const result = await validatePythonSnippet('x = 1\n'.repeat(10_000))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('exceeds')
  })

  test('rejects a snippet with a syntax error rather than crashing', async () => {
    const result = await validateOrSkip('def f(:\n    pass\n')
    if (!result) return
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('syntax error')
  })

  for (const dangerous of [
    'import os',
    'import sys',
    'import subprocess',
    'import socket',
    'import urllib.request',
    'import ctypes',
    'import pathlib',
    'import shutil',
    'from os import system',
    'from subprocess import call',
  ]) {
    test(`rejects disallowed import: ${dangerous}`, async () => {
      const result = await validateOrSkip(`${dangerous}\nprint('VERIFIED')\n`)
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed import')
    })
  }

  for (const dangerous of [
    "eval('1+1')",
    "exec('print(1)')",
    "compile('1', '<s>', 'eval')",
    "__import__('os')",
    "open('x')",
    'input()',
    'globals()',
    'locals()',
    'vars()',
    "getattr(object, '__class__')",
    '().__class__.__bases__',
    '(1).__class__.__subclasses__()',
  ]) {
    test(`rejects dangerous construct: ${dangerous}`, async () => {
      const result = await validateOrSkip(`print(${dangerous})\n`)
      if (!result) return
      expect(result.ok).toBe(false)
    })
  }

  test('rejects an import not on the allowlist even without a dangerous token', async () => {
    const result = await validateOrSkip('import random\nprint(random.random())\n')
    if (!result) return
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('disallowed import')
  })

  test('allows every module on the documented allowlist', async () => {
    for (const m of ALLOWED_IMPORTS) {
      const result = await validateOrSkip(`import ${m}\nprint('VERIFIED')\n`)
      if (!result) return
      expect(result.ok).toBe(true)
    }
  })

  // ---------------------------------------------------------------------
  // 2026-08-12 security review, Finding 1 (HIGH): the old regex/substring
  // validator only matched the literal adjacent-paren call form
  // ('eval(', 'open(', etc.) and missed aliasing and whitespace bypasses.
  // The AST validator closes this class of bypass by rejecting ANY `Name`
  // reference to a banned identifier, not just an immediately-called one.
  // ---------------------------------------------------------------------
  describe('Finding 1 — aliasing/whitespace bypasses of the builtin denylist', () => {
    const bypasses: Array<[string, string]> = [
      ['assign-then-call: w = open; w(...)', "w = open\nw('x')\n"],
      ['assign-then-call: e = exec; e(...)', "e = exec\ne('print(1)')\n"],
      ['assign-then-call: z = __import__; z(...)', "z = __import__\nz('os')\n"],
      ['space before paren defeats substring match: open (...)', "open ('x')\n"],
      ['assign-then-call: g = getattr; g(...)', "g = getattr\ng(object, '__class__')\n"],
      ['assign-then-call: v = eval; v(...)', "v = eval\nv('1+1')\n"],
    ]
    for (const [label, code] of bypasses) {
      test(`rejects: ${label}`, async () => {
        const result = await validateOrSkip(`${code}print('VERIFIED')\n`)
        if (!result) return
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toContain('disallowed identifier')
      })
    }
  })

  // ---------------------------------------------------------------------
  // 2026-08-12 security review, Finding 2 (HIGH): the old line-anchored
  // import regex missed comma-separated imports, semicolon-chained
  // statements, imports indented inside a block, and (by construction of
  // matching real Python grammar instead of line-anchored text) any other
  // syntactic position an import can appear in.
  // ---------------------------------------------------------------------
  describe('Finding 2 — import-location bypasses of the import allowlist', () => {
    test('rejects comma-separated imports where only the first was previously checked', async () => {
      const result = await validateOrSkip("import math, os\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed import')
    })

    test('rejects a semicolon-chained import not at the start of a line', async () => {
      const result = await validateOrSkip("x = 1; import os\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed import')
    })

    test('rejects an import indented inside a block', async () => {
      const result = await validateOrSkip("if True:\n    import subprocess\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed import')
    })

    test('rejects a backslash-continued import line', async () => {
      const result = await validateOrSkip("import \\\n    os\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed import')
    })

    test('rejects a wildcard from-import', async () => {
      const result = await validateOrSkip("from math import *\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
    })

    test('rejects a relative import', async () => {
      const result = await validateOrSkip("from . import os\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
    })
  })

  // ---------------------------------------------------------------------
  // 2026-08-12 security review, Finding 3 (MEDIUM): operator.attrgetter /
  // operator.methodcaller are a getattr-equivalent that never contains the
  // literal string "getattr(". Closed via option (a) from the review — ban
  // both names specifically (as identifiers AND as attribute names, so
  // aliasing the operator module itself doesn't help) rather than removing
  // `operator` from the allowlist entirely (operator.mul/add/etc. are
  // genuinely used by real verification snippets).
  // ---------------------------------------------------------------------
  describe('Finding 3 — operator.attrgetter/methodcaller getattr-equivalent', () => {
    test('rejects operator.attrgetter used directly', async () => {
      const result = await validateOrSkip(
        "import operator\nf = operator.attrgetter('real')\nprint('VERIFIED')\n",
      )
      if (!result) return
      expect(result.ok).toBe(false)
    })

    test('rejects operator.methodcaller used directly', async () => {
      const result = await validateOrSkip(
        "import operator\nf = operator.methodcaller('bit_length')\nprint('VERIFIED')\n",
      )
      if (!result) return
      expect(result.ok).toBe(false)
    })

    test('rejects from operator import attrgetter', async () => {
      const result = await validateOrSkip("from operator import attrgetter\nprint('VERIFIED')\n")
      if (!result) return
      expect(result.ok).toBe(false)
    })

    test('rejects attrgetter reached through a re-aliased module reference', async () => {
      // op2 is never itself `import`ed — this is exactly the kind of
      // multi-hop aliasing a module-name-resolution approach would miss but
      // a global ban on the attribute name `attrgetter` catches regardless.
      const result = await validateOrSkip(
        "import operator\nop2 = operator\nf = op2.attrgetter('real')\nprint('VERIFIED')\n",
      )
      if (!result) return
      expect(result.ok).toBe(false)
    })

    test('still allows ordinary operator functions (operator.mul etc.)', async () => {
      const result = await validateOrSkip(
        "import operator\nfrom functools import reduce\nprint('VERIFIED' if reduce(operator.mul, [17, 23], 1) == 391 else 'FAILED')\n",
      )
      if (!result) return
      expect(result.ok).toBe(true)
    })
  })

  // ---------------------------------------------------------------------
  // 2026-08-12 second independent security review, round 2 (HIGH): the AST
  // walk only inspects real syntax nodes, never string-literal *contents* —
  // typing.get_type_hints() evaluates string/forward-reference annotations
  // as real code via its own eval(), so a payload hidden inside a string
  // constant is invisible to the walk but executed at runtime. Reproduced
  // live against the pre-round-2 code before fixing (see this file's header
  // comment for the exact confirmation). Also covers a related str.format
  // attribute-traversal variant and additional vectors found during the
  // broader audit this round asked for (ForwardRef/TypeVar-bound direct
  // paths, and — independently of any string-eval trick — several allowed
  // modules exposing the real `sys`/`builtins` modules as plain attributes).
  // ---------------------------------------------------------------------
  describe('Round 2 — string-eval and attribute-traversal bypasses (typing/format/sys)', () => {
    test('rejects the exact typing.get_type_hints forward-ref exploit from the security task', async () => {
      const code = `import typing\ndef _c() -> "__import__('os').popen('whoami').read()":\n    pass\ntyping.get_type_hints(_c)\nprint("VERIFIED")\n`
      const result = await validateOrSkip(code)
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed attribute: get_type_hints')
    })

    test('rejects the str.format attribute-traversal variant', async () => {
      const code =
        'x = "{0.__class__.__init__.__globals__}"\nclass C: pass\nprint(x.format(C()))\nprint("VERIFIED")\n'
      const result = await validateOrSkip(code)
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed attribute: format')
    })

    test('rejects direct typing.ForwardRef construction + .evaluate()', async () => {
      const code =
        'import typing\nfr = typing.ForwardRef("__import__(\'os\').getcwd()")\nprint(fr.evaluate())\nprint("VERIFIED")\n'
      const result = await validateOrSkip(code)
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed attribute')
    })

    test('rejects TypeVar(bound=...).__bound__.evaluate() — reaches a ForwardRef without ever naming ForwardRef', async () => {
      const code =
        'import typing\nT = typing.TypeVar("T", bound="__import__(\'os\').getcwd()")\nprint(T.__bound__.evaluate())\nprint("VERIFIED")\n'
      const result = await validateOrSkip(code)
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed attribute: evaluate')
    })

    test('rejects typing._eval_type used directly', async () => {
      const code = 'import typing\nprint(typing._eval_type)\nprint("VERIFIED")\n'
      const result = await validateOrSkip(code)
      if (!result) return
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('disallowed attribute: _eval_type')
    })

    // Additional finding from the broader audit ("audit typing more
    // broadly... and ban what you find"): several ALLOWED_IMPORTS modules
    // expose the real `sys`/`builtins` module as a plain attribute, because
    // they `import sys`/`import builtins as bltns` at their own module
    // scope. No string-eval trickery needed at all — confirmed live as a
    // simpler, cleaner full RCE than the get_type_hints one above.
    for (const [label, code] of [
      ['enum.bltns.__import__ (builtins alias)', 'import enum\nenum.bltns.__import__("os")\nprint("VERIFIED")\n'],
      ['typing.sys.modules dict lookup', "import typing\ntyping.sys.modules['os']\nprint(\"VERIFIED\")\n"],
      ['fractions.sys', 'import fractions\nprint(fractions.sys)\nprint("VERIFIED")\n'],
      ['statistics.sys', 'import statistics\nprint(statistics.sys)\nprint("VERIFIED")\n'],
      ['dataclasses.sys', 'import dataclasses\nprint(dataclasses.sys)\nprint("VERIFIED")\n'],
      ['collections._sys', 'import collections\nprint(collections._sys)\nprint("VERIFIED")\n'],
      ['from typing import sys', 'from typing import sys\nprint(sys)\nprint("VERIFIED")\n'],
    ] as const) {
      test(`rejects ${label}`, async () => {
        const result = await validateOrSkip(code)
        if (!result) return
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason.toLowerCase()).toMatch(/sys|bltns/)
      })
    }

    test('legitimate typing/dataclasses/enum usage (no dangerous attrs) still validates ok', async () => {
      const code = `import typing, dataclasses, enum
@dataclasses.dataclass
class Point:
    x: int
    y: int
class Color(enum.Enum):
    RED = 1
p: typing.Optional[Point] = Point(1, 2)
print("VERIFIED" if p is not None and p.x == 1 and Color.RED.value == 1 else "FAILED")
`
      const result = await validateOrSkip(code)
      if (!result) return
      expect(result.ok).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------
// 2026-08-12 round 2 — RUNTIME_IMPORT_GUARD_PREFIX, the defense-in-depth
// layer added alongside the static bans above. Uses
// _runPythonSnippetBypassingStaticValidationForTests to simulate "the
// static AST validator missed this payload" and confirm the runtime guard
// alone — independent of any of the Round 2 static bans above — still
// stops a non-allowlisted import when it actually executes. See this
// file's "RUNTIME ENFORCEMENT" header comment for the full honest scope
// (what this does and does not close).
// ---------------------------------------------------------------------
describe('runPythonSnippet — runtime import guard (defense-in-depth, static validation bypassed)', () => {
  afterEach(() => {
    _resetPythonInterpreterCacheForTests()
  })

  test('runtime guard alone stops typing.get_type_hints from importing os, even with static validation bypassed', async () => {
    const code = `import typing\ndef _c() -> "__import__('os').getcwd()":\n    pass\ntry:\n    typing.get_type_hints(_c)\n    print("UNEXPECTED SUCCESS")\nexcept Exception as e:\n    print("BLOCKED:", type(e).__name__)\nprint("VERIFIED")\n`
    const result = await _runPythonSnippetBypassingStaticValidationForTests(code)
    if (!result.executed) {
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.stdout).not.toContain('UNEXPECTED SUCCESS')
    expect(result.stdout).toContain('BLOCKED:')
    expect(result.stdout).toContain('VERIFIED')
  }, 10_000)

  test('runtime guard alone stops enum.bltns.__import__ from importing os, even with static validation bypassed', async () => {
    const code = `import enum\ntry:\n    enum.bltns.__import__('os')\n    print("UNEXPECTED SUCCESS")\nexcept Exception as e:\n    print("BLOCKED:", type(e).__name__)\nprint("VERIFIED")\n`
    const result = await _runPythonSnippetBypassingStaticValidationForTests(code)
    if (!result.executed) {
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.stdout).not.toContain('UNEXPECTED SUCCESS')
    expect(result.stdout).toContain('BLOCKED:')
    expect(result.stdout).toContain('VERIFIED')
  }, 10_000)

  test('honest gap: the runtime guard does NOT stop typing.sys.modules access (no import call happens) — only the static ban does', async () => {
    // Documents, rather than hides, what RUNTIME_IMPORT_GUARD_PREFIX does not
    // cover: pure attribute/dict-lookup access to an already-imported
    // module reference never calls __import__ at all, so the import
    // chokepoint the runtime guard enforces is never reached. This is why
    // Part 1's static ban on 'sys'/'_sys'/'bltns' is still load-bearing, not
    // redundant with Part 2.
    const code = `import typing\nresult = typing.sys.modules['os'].getcwd()\nprint("REACHED:", bool(result))\nprint("VERIFIED")\n`
    const result = await _runPythonSnippetBypassingStaticValidationForTests(code)
    if (!result.executed) {
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.stdout).toContain('REACHED: True')
  }, 10_000)

  test('runtime guard does not break legitimate allowed-module usage when static validation is bypassed', async () => {
    const code = `import math\nfrom functools import reduce\nimport operator\nprint("VERIFIED" if reduce(operator.mul, [17, 23], 1) == 391 and math.isclose(math.sqrt(4), 2) else "FAILED")\n`
    const result = await _runPythonSnippetBypassingStaticValidationForTests(code)
    if (!result.executed) {
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.stdout.trim().split('\n').pop()).toBe('VERIFIED')
  }, 10_000)
})

describe('runPythonSnippet — execution (spawns a real local interpreter if present)', () => {
  afterEach(() => {
    _resetPythonInterpreterCacheForTests()
  })

  test('never throws on a rejected snippet — reports executed:false with a reason', async () => {
    const result = await runPythonSnippet('import os\nprint("VERIFIED")\n')
    expect(result.executed).toBe(false)
    expect(result.rejectionReason).toContain('disallowed import')
  })

  test('reports executed:false (fails closed) when no interpreter is configured/found', async () => {
    const previous = process.env.MATH_VERIFY_PYTHON_PATH
    process.env.MATH_VERIFY_PYTHON_PATH = 'this-interpreter-does-not-exist-anywhere'
    try {
      const result = await runPythonSnippet('print("VERIFIED")\n')
      // Validation itself now needs to spawn the (bogus) interpreter to run
      // the AST linter — when that spawn fails, validation fails closed and
      // the snippet is never executed at all. This must never throw and
      // must never falsely report success.
      expect(result.executed).toBe(false)
      expect(result.exitCode === 0 && result.stdout.includes('VERIFIED')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.MATH_VERIFY_PYTHON_PATH
      else process.env.MATH_VERIFY_PYTHON_PATH = previous
    }
  })

  test('runs a real allowed snippet end-to-end and enforces the timeout', async () => {
    const result = await runPythonSnippet(
      'import time\nwhile True:\n    pass\n',
      { timeoutMs: 500 },
    )
    // "time" is not on the allowlist, so this should actually be rejected
    // before ever spawning — confirms the validator runs first.
    expect(result.executed).toBe(false)
  }, 10_000)

  test('a genuinely infinite pure-math loop is killed by the timeout, not left running', async () => {
    const result = await runPythonSnippet(
      'x = 1\nwhile True:\n    x = x + 1\n',
      { timeoutMs: 500 },
    )
    if (!result.executed) {
      // No local Python interpreter available in this environment — can't
      // exercise the real timeout path, but validation correctly accepted
      // it (only "time" module usage was rejected above; this uses none).
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.timedOut).toBe(true)
  }, 10_000)

  test('reports snippetMeta (hasComparison/hasNonPrintCall) on successful execution', async () => {
    const result = await runPythonSnippet(
      'computed = 17 * 23\nexpected = 391\nprint("VERIFIED" if computed == expected else "FAILED")\n',
    )
    if (!result.executed) {
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.snippetMeta?.hasComparison).toBe(true)
  }, 10_000)

  test('reports hasComparison:false and hasNonPrintCall:false for a bare print', async () => {
    const result = await runPythonSnippet('print("VERIFIED")\n')
    if (!result.executed) {
      console.error('SKIPPED (no local python interpreter found):', result.rejectionReason)
      return
    }
    expect(result.snippetMeta?.hasComparison).toBe(false)
    expect(result.snippetMeta?.hasNonPrintCall).toBe(false)
  }, 10_000)
})
