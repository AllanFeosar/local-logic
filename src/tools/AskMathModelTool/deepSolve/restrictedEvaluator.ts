import { execa } from 'execa'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { getPlatform } from '../../../utils/platform.js'
import { which } from '../../../utils/which.js'

/**
 * §11 Tier 1 — the restricted numeric AST evaluator (added 2026-08-12,
 * Session 11) that REPLACES pythonSandbox.ts's execution-based verification
 * for DeepSolve's math-check step. See LOCAL_AI_MASTER_PLAN.md §11
 * "Verifier isolation — the settled answer" for the full architectural
 * rationale this file implements. Short version: pythonSandbox.ts ran
 * model-generated Python behind a denylist (import allowlist + banned-
 * identifier/attribute list + a runtime import guard) and three independent
 * security rounds each closed one reported hole and found the same class
 * reachable a different way, ending in a one-line RCE
 * (`dataclasses.inspect.os.system(...)`) that never called `import` at all —
 * CPython's shared, introspective module cache makes "the reachable
 * dangerous-object set" open-ended and not enumerable by any denylist. This
 * module does not patch that approach again. It is architecturally
 * different: an ALLOWLIST OF CAPABILITIES, not a denylist of names.
 *
 * WHAT MAKES THIS ACTUALLY SAFE (read together with RESTRICTED_EVAL_SCRIPT
 * below, which is the real security boundary — this file is process
 * plumbing around it)
 * ---------------------------------------------------------------------------
 * The untrusted snippet is never handed to Python's own eval()/exec()/
 * compile() — not even on a "validated" AST. RESTRICTED_EVAL_SCRIPT parses
 * the snippet with Python's real `ast.parse()` (a well-tested standard
 * grammar recognizer — reusing it is a convenience, not a safety
 * dependency: hand-rolling an arithmetic-expression parser in TypeScript
 * with correct operator precedence/associativity/chained-comparison
 * semantics would be strictly more of *this project's own* code to get
 * exactly right, for zero safety benefit, since the safety property comes
 * entirely from never calling eval()/exec() on the result — that holds
 * regardless of which language parses the source), then WALKS THE PARSED
 * TREE ITSELF and computes a result node-by-node using its own hardcoded
 * dispatch table — genuine tree-walking interpretation, not "validate, then
 * run it for real via the interpreter". There is no object graph to
 * traverse (the exact mechanism all three prior RCEs used — attribute
 * traversal from an already-imported module) because:
 *
 *   - Only a hardcoded, closed set of AST node types is recognized at all
 *     (Module, Assign, Expr, Constant[int/float/bool only], BinOp, UnaryOp,
 *     BoolOp, Compare, Call, Name — see ALLOWED_NODE_TYPES documented in
 *     RESTRICTED_EVAL_SCRIPT's own header). Anything else — Import/
 *     ImportFrom, Attribute (of ANY kind, on ANY object), Subscript, Lambda,
 *     comprehensions (list/set/dict/generator), f-strings/JoinedStr,
 *     Starred, With, Global/Nonlocal, function/class defs, Raise, Try — is
 *     rejected by construction: there is no dispatch branch for it, so the
 *     walk raises "disallowed node type" rather than silently falling
 *     through to some default behavior. `exec`/`eval`/`import`/`open`/etc.
 *     used as bare identifiers are just ordinary `Name` nodes syntactically,
 *     but a `Name` in Load position is ONLY ever resolved against this
 *     interpreter's own closed local-variable dict (see next point) — there
 *     is no dangerous-name list to maintain here because the grammar cannot
 *     express a reference to anything outside that dict plus the fixed
 *     function table, not because those particular spellings are banned.
 *   - `Name` references resolve ONLY against a plain dict this interpreter
 *     builds itself from the snippet's own prior `Assign` statements — never
 *     against Python's real `globals()`/`builtins`/`sys.modules`. There is
 *     no `os`, no `sys`, no `builtins`, no `dataclasses`/`typing`/`enum`
 *     reachable AT ALL, because nothing in this grammar can construct a
 *     reference to a module in the first place — not "reachable but
 *     denied", genuinely inexpressible in the AST shapes this walker
 *     recognizes.
 *   - `Call` is allowed ONLY when `node.func` is a bare `ast.Name` whose
 *     `.id` is literally a key in FUNCTION_TABLE — a small, fixed set of
 *     pure math wrapper functions this trusted script defines itself.
 *     Function values are never first-class in this grammar (there is no
 *     way to write `f = sqrt; f(4)` — a bare `Name` Load only ever resolves
 *     through the local-variable dict above, which never contains a
 *     callable), so there is no aliasing/re-binding vector to close, unlike
 *     every round of pythonSandbox.ts's denylist, which kept having to
 *     re-close exactly that class of bypass (`z = __import__; z(...)`,
 *     `op2 = operator; op2.attrgetter`, etc.).
 *
 * WHY THIS STILL SPAWNS A PYTHON PROCESS (not pure TypeScript)
 * ---------------------------------------------------------------------------
 * Both the master plan and this session's task explicitly left the
 * implementation language open. Chose Python, spawned with the same
 * process-hygiene discipline pythonSandbox.ts already established (no
 * shell, argv-only invocation, minimal explicitly-built env, hard timeout +
 * process-group kill on timeout), because: (1) it reuses Python's real,
 * battle-tested `ast.parse()` instead of hand-rolling an arithmetic parser
 * in TypeScript, for no safety cost (see above); (2) VibeThinker has
 * reliably produced Python-syntax verification snippets throughout every
 * DeepSolve session so far (LOCAL_AI_STATUS.md Sessions 6/8/9) — keeping the
 * candidate-facing syntax a (now much narrower) Python expression subset
 * minimizes prompt/behavior churn versus inventing an unfamiliar bespoke
 * grammar. Unlike pythonSandbox.ts, there is no "validate via stdin, then
 * write a combined script to a temp file and execute it" two-hop dance and
 * no temp directory or filesystem write at all — one process, one fixed
 * trusted script (passed via `-c`), the untrusted snippet on stdin only
 * (never interpolated into the trusted script's own source text), one small
 * fixed-shape JSON result on stdout.
 *
 * HONEST LIMITS (stated for the reviewer, matching this codebase's own
 * convention of documenting gaps rather than hiding them)
 * ---------------------------------------------------------------------------
 * - No arbitrary-algorithm verification: no loops, no data structures, no
 *   user-defined functions, no collections at all. A check that genuinely
 *   needs to *simulate* something (e.g. if a candidate tried to verify
 *   LOCAL_AI_STATUS.md Session 6's "two trains and a bird" case by
 *   simulating each back-and-forth leg rather than a closed-form
 *   recomputation) cannot be expressed here and the snippet is rejected —
 *   verification correctly falls through to 'inconclusive' (see
 *   verification.ts), never silently treated as failed. This is the master
 *   plan's own documented tradeoff (§11: "Real cost: narrows what's
 *   checkable"), not an oversight.
 * - The "final statement must be a Compare/BoolOp/Call whose computed result
 *   is literally Python's `True`/`False`" rule (validate_final_shape in
 *   RESTRICTED_EVAL_SCRIPT) closes the specific "bare
 *   `print(\"VERIFIED\")`"/"bare `True`" forgery class pythonSandbox.ts's own
 *   Finding 5 had to patch after the fact, at the grammar level rather than
 *   via post-hoc detection — but a tautological comparison of two identical
 *   literals (`4 == 4`) is still syntactically valid and not rejected; this
 *   is the same residual gap pythonSandbox.ts's own Finding 5 fix documented
 *   and accepted, not a new one introduced here. This is a correctness (not
 *   security) concern — a trivial/tautological check has zero code-execution
 *   risk either way in this design, unlike the old one, where every gap was
 *   a security gap by definition.
 * - No CPU/memory ulimits beyond the process timeout and the deliberate
 *   MAX_ABS_VALUE / MAX_POW_EXPONENT / MAX_FACTORIAL_N bounds inside
 *   RESTRICTED_EVAL_SCRIPT (added specifically so a chain of
 *   individually-small-looking arithmetic operations can't compound into a
 *   many-gigabyte integer before the timeout would catch it) — the same
 *   "timeout is the primary resource bound" honest limit pythonSandbox.ts
 *   documented, inherited here because it's a real constraint of running
 *   anything as an OS process on this Windows machine, not specific to
 *   either sandboxing approach.
 */

const MAX_SNIPPET_CHARS = 4_000
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 10_000
// The only output is one small, fixed-shape JSON object — there is no
// arbitrary print()-driven output in this grammar at all (print itself
// isn't in FUNCTION_TABLE), unlike pythonSandbox.ts's captured stdout.
const EXECA_MAX_BUFFER_BYTES = 65_536
const MAX_STDERR_CHARS_IN_ERROR = 2_000

/**
 * The trusted, fixed evaluator script. The untrusted candidate snippet is
 * supplied on stdin (see evaluateRestrictedCheck below) — never
 * interpolated into this source string, so there is no way for snippet
 * content to alter what this script itself does.
 *
 * ALLOWED_NODE_TYPES (enforced by validate_expr/validate_module — the walk
 * has no branch for anything else, so an unrecognized node type is always a
 * rejection, never a silent pass-through):
 *   Module, Assign (single simple Name target only), Expr (statement),
 *   Constant (int/float/bool only — no str/bytes/complex/None/Ellipsis),
 *   BinOp (+ - * / // % **), UnaryOp (+ - only, not `not`), BoolOp (and/or),
 *   Compare (== != < <= > >=, including chained comparisons e.g. 1 < x < 10),
 *   Call (only to a name literally present in FUNCTION_TABLE, positional
 *   args only, no **kwargs, no *args unpacking), Name (Load only resolves
 *   against this script's own local-variable dict; Store only as an Assign
 *   target).
 *
 * Grammar shape: zero or more `name = <expr>` assignment statements,
 * followed by exactly one final statement that must be a bare expression
 * whose top-level node is a Compare, BoolOp, or Call (see
 * validate_final_shape) — this is what closes the "trivial forged pass"
 * class at the grammar level. At runtime, that final expression must
 * literally evaluate to Python's `True` or `False`; anything else (a
 * function call that raises, an undefined variable, a non-boolean result)
 * is reported as `{"status": "error", ...}`, which verification.ts treats
 * as 'inconclusive', never as a provable pass or fail.
 *
 * FUNCTION_TABLE — the complete, deliberately small set of callables:
 * sqrt, abs, pow (2-arg real exponent or 3-arg modular form), gcd, lcm,
 * factorial, min, max, round, floor, ceil, sum, isclose. Each is a plain
 * Python function this trusted script defines itself; none of them accept
 * or return anything derived from Python's real import/attribute machinery.
 */
const RESTRICTED_EVAL_SCRIPT = `
import ast
import json
import math
import sys

MAX_STATEMENTS = 25
MAX_NODES = 300
MAX_CALL_ARGS = 20
MAX_POW_EXPONENT = 10_000
MAX_FACTORIAL_N = 10_000
MAX_ABS_VALUE_EXP = 50_000
MAX_ABS_VALUE = 10 ** MAX_ABS_VALUE_EXP


class RejectedError(Exception):
    """The snippet does not fit the allowed grammar -- never evaluated."""


class EvalError(Exception):
    """The snippet fits the grammar but could not be evaluated to a genuine
    boolean result (undefined variable, division by zero, wrong argument
    count, a bound exceeded, a non-boolean final result, etc). Not a
    security issue -- just means the check is unusable, same bucket a crash
    landed in under the old design."""


def _require_int(x):
    if isinstance(x, bool):
        return int(x)
    if isinstance(x, int):
        return x
    if isinstance(x, float) and x.is_integer():
        return int(x)
    raise EvalError("expected an integer argument")


def _finalize(value):
    # Every arithmetic/call/literal result flows through here (including
    # bare Constant nodes -- see evaluate() below, fixed 2026-08-12 audit
    # round 4: a literal used to return straight from evaluate() without
    # this check, so x = 1e400 could plant an unbounded inf into env
    # untouched by any bound): enforces the interpreter's entire value
    # domain is exactly {int, float, bool} (never str/complex/etc, even
    # though nothing in this grammar could otherwise construct another type
    # -- e.g. real ** on a negative base with a fractional exponent can
    # produce a complex result) and bounds magnitude so a CHAIN of
    # operations, each individually within bounds, can't compound into a
    # many-gigabyte integer before the process timeout would catch it.
    # Checked after every single operation, not just at Pow, so growth is
    # stopped at most one operation after crossing the threshold.
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            # inf/-inf/nan: a float literal like 1e400 parses to inf
            # without raising (Python allows overflowing float literals),
            # and nan compares False against everything -- abs(nan) >
            # MAX_ABS_VALUE is False, so the magnitude check below would
            # silently let it through. Reject explicitly instead of relying
            # on that comparison for non-finite values. Not a code-execution
            # risk (nothing dangerous is reachable from a plain float either
            # way), but an unbounded/undefined value must never resolve to a
            # reported True/False -- a verification tool that says "verified"
            # about a NaN-poisoned check is worse than one that says
            # "inconclusive".
            raise EvalError("intermediate result is not a finite number (inf/nan)")
        try:
            if abs(value) > MAX_ABS_VALUE:
                raise EvalError("intermediate result magnitude too large")
        except OverflowError:
            raise EvalError("intermediate result magnitude too large")
        return value
    raise EvalError("operation produced an unsupported value type: " + type(value).__name__)


def _fn_sqrt(x):
    if x < 0:
        raise EvalError("sqrt of a negative number")
    return math.sqrt(x)


def _fn_pow(base, exp, mod=None):
    if mod is not None:
        return pow(_require_int(base), _require_int(exp), _require_int(mod))
    if abs(exp) > MAX_POW_EXPONENT:
        raise EvalError("exponent magnitude exceeds the allowed bound")
    return base ** exp


def _fn_factorial(n):
    n = _require_int(n)
    if n < 0 or n > MAX_FACTORIAL_N:
        raise EvalError("factorial argument out of the allowed range")
    return math.factorial(n)


def _fn_gcd(*args):
    return math.gcd(*[_require_int(a) for a in args])


def _fn_lcm(*args):
    return math.lcm(*[_require_int(a) for a in args])


def _fn_round(x, ndigits=None):
    return round(x) if ndigits is None else round(x, _require_int(ndigits))


def _fn_sum(*args):
    return sum(args)


def _fn_isclose(a, b, tol=1e-9):
    return math.isclose(a, b, rel_tol=tol, abs_tol=tol)


# name -> (callable, min_args, max_args (None = unbounded))
FUNCTION_TABLE = {
    "sqrt": (_fn_sqrt, 1, 1),
    "abs": (abs, 1, 1),
    "pow": (_fn_pow, 2, 3),
    "gcd": (_fn_gcd, 1, None),
    "lcm": (_fn_lcm, 1, None),
    "factorial": (_fn_factorial, 1, 1),
    "min": (min, 1, None),
    "max": (max, 1, None),
    "round": (_fn_round, 1, 2),
    "floor": (math.floor, 1, 1),
    "ceil": (math.ceil, 1, 1),
    "sum": (_fn_sum, 1, None),
    "isclose": (_fn_isclose, 2, 3),
}

ALLOWED_BINOPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
}
ALLOWED_CMPOPS = {
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
}


def validate_expr(node, depth=0):
    if depth > 60:
        raise RejectedError("expression nested too deeply")
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            return
        if isinstance(node.value, (int, float)):
            return
        raise RejectedError(
            "only numeric (int/float/bool) literals are allowed, found: " + type(node.value).__name__
        )
    if isinstance(node, ast.BinOp):
        if type(node.op) not in ALLOWED_BINOPS and not isinstance(node.op, ast.Pow):
            raise RejectedError("disallowed binary operator: " + type(node.op).__name__)
        validate_expr(node.left, depth + 1)
        validate_expr(node.right, depth + 1)
        return
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, (ast.UAdd, ast.USub)):
            raise RejectedError("disallowed unary operator: " + type(node.op).__name__)
        validate_expr(node.operand, depth + 1)
        return
    if isinstance(node, ast.BoolOp):
        if not isinstance(node.op, (ast.And, ast.Or)):
            raise RejectedError("disallowed boolean operator: " + type(node.op).__name__)
        for v in node.values:
            validate_expr(v, depth + 1)
        return
    if isinstance(node, ast.Compare):
        for op in node.ops:
            if type(op) not in ALLOWED_CMPOPS:
                raise RejectedError("disallowed comparison operator: " + type(op).__name__)
        validate_expr(node.left, depth + 1)
        for c in node.comparators:
            validate_expr(c, depth + 1)
        return
    if isinstance(node, ast.Call):
        if node.keywords:
            raise RejectedError("keyword arguments are not allowed")
        if not isinstance(node.func, ast.Name):
            raise RejectedError("calls are only allowed to a fixed function name, not an expression")
        if node.func.id not in FUNCTION_TABLE:
            raise RejectedError("call to a function that is not in the allowed table: " + node.func.id)
        if len(node.args) > MAX_CALL_ARGS:
            raise RejectedError("too many arguments in a single call")
        for a in node.args:
            validate_expr(a, depth + 1)
        return
    if isinstance(node, ast.Name):
        return
    raise RejectedError("disallowed node type: " + type(node).__name__)


def validate_final_shape(node):
    # The final statement's expression must be one that can genuinely
    # represent a pass/fail verdict on its own -- a bare literal, a bare
    # variable reference, or a bare arithmetic value are all rejected here,
    # independent of the separate runtime requirement (see main()) that the
    # computed value literally be True or False. Closes the "bare True" /
    # "print a constant sentinel" forgery class at the grammar level rather
    # than trying to detect it after the fact.
    if isinstance(node, (ast.Compare, ast.BoolOp, ast.Call)):
        return
    raise RejectedError(
        "the final line must itself be a comparison (e.g. computed == expected), a combination of "
        "comparisons with and/or, or a call to a function that returns a boolean (e.g. isclose(...)) "
        "-- not a bare value, variable, or arithmetic expression"
    )


def validate_module(tree):
    if not isinstance(tree, ast.Module):
        raise RejectedError("top-level input must be a sequence of statements")
    body = tree.body
    if len(body) == 0:
        raise RejectedError("empty snippet")
    if len(body) > MAX_STATEMENTS:
        raise RejectedError("too many statements")

    reserved = set(FUNCTION_TABLE.keys())
    for i, stmt in enumerate(body):
        is_last = i == len(body) - 1
        if isinstance(stmt, ast.Assign):
            if is_last:
                raise RejectedError("the final statement must be a check expression, not an assignment")
            if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
                raise RejectedError("an assignment target must be a single simple variable name")
            name = stmt.targets[0].id
            if name in reserved:
                raise RejectedError("cannot use a reserved function name as a variable: " + name)
            validate_expr(stmt.value)
        elif isinstance(stmt, ast.Expr):
            if not is_last:
                raise RejectedError("only the final statement may be a bare expression")
            validate_expr(stmt.value)
            validate_final_shape(stmt.value)
        else:
            raise RejectedError("disallowed statement type: " + type(stmt).__name__)


def evaluate(node, env):
    if isinstance(node, ast.Constant):
        # Routed through _finalize (2026-08-12 audit round 4 fix) -- a bare
        # literal used to return directly here, bypassing every bound: a
        # float literal like 1e400 parses to inf without a SyntaxError
        # (Python permits overflowing float literals), so x = 1e400 could
        # plant an unbounded value into env untouched by MAX_ABS_VALUE.
        return _finalize(node.value)
    if isinstance(node, ast.BinOp):
        left = evaluate(node.left, env)
        right = evaluate(node.right, env)
        try:
            if isinstance(node.op, ast.Pow):
                if abs(right) > MAX_POW_EXPONENT:
                    raise EvalError("exponent magnitude exceeds the allowed bound")
                # 2026-08-12 audit round 4: bounding only the exponent still
                # let a large-int BASE (itself already within MAX_ABS_VALUE,
                # e.g. from a prior x = 10 ** 10000 statement) raised to a
                # bounded exponent produce a ~100-million-digit integer
                # *before* _finalize below ever saw the result -- CPython
                # computes int ** int eagerly and exactly, so the process
                # timeout was the only thing stopping it, contradicting this
                # function's own "checked after every single operation"
                # guarantee. Estimate the result's magnitude via logarithms
                # (cheap, and correct for arbitrary-precision int bases --
                # math.log10 has a special path for big ints that avoids the
                # float-overflow a naive float(left) conversion would hit)
                # and reject BEFORE calling ** at all when the estimate
                # alone already exceeds the bound.
                if isinstance(left, (int, float)) and not isinstance(left, bool) and right > 0:
                    abs_left = abs(left)
                    if abs_left > 1:
                        try:
                            estimated_log10 = right * math.log10(abs_left)
                        except (ValueError, OverflowError):
                            estimated_log10 = float('inf')
                        if not math.isfinite(estimated_log10) or estimated_log10 > MAX_ABS_VALUE_EXP:
                            raise EvalError("intermediate result magnitude too large")
                result = left ** right
            else:
                fn = ALLOWED_BINOPS.get(type(node.op))
                if fn is None:
                    raise RejectedError("unreachable: unvalidated binary operator")
                result = fn(left, right)
        except ZeroDivisionError:
            raise EvalError("division by zero")
        except OverflowError:
            raise EvalError("arithmetic overflow")
        return _finalize(result)
    if isinstance(node, ast.UnaryOp):
        val = evaluate(node.operand, env)
        result = val if isinstance(node.op, ast.UAdd) else -val
        return _finalize(result)
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            result = True
            for v in node.values:
                result = bool(evaluate(v, env))
                if not result:
                    break
        else:
            result = False
            for v in node.values:
                result = bool(evaluate(v, env))
                if result:
                    break
        return result
    if isinstance(node, ast.Compare):
        left = evaluate(node.left, env)
        ok = True
        for op, comparator in zip(node.ops, node.comparators):
            if not ok:
                break
            right = evaluate(comparator, env)
            fn = ALLOWED_CMPOPS.get(type(op))
            if fn is None:
                raise RejectedError("unreachable: unvalidated comparison operator")
            ok = bool(fn(left, right))
            left = right
        return ok
    if isinstance(node, ast.Call):
        fn, min_args, max_args = FUNCTION_TABLE[node.func.id]
        args = [evaluate(a, env) for a in node.args]
        if len(args) < min_args or (max_args is not None and len(args) > max_args):
            raise EvalError("wrong number of arguments to " + node.func.id)
        try:
            result = fn(*args)
        except EvalError:
            raise
        except (ValueError, TypeError, OverflowError) as e:
            raise EvalError(str(e))
        return _finalize(result)
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        raise EvalError("undefined variable: " + node.id)
    raise RejectedError("unreachable: unvalidated node type " + type(node).__name__)


def _write_rejected(reason):
    sys.stdout.write(json.dumps({"status": "rejected", "reason": reason}))


def _write_error(message):
    sys.stdout.write(json.dumps({"status": "error", "error": message}))


def main():
    source = sys.stdin.read()
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as e:
        _write_rejected("syntax error: " + str(e))
        return
    except Exception as e:
        _write_rejected("parse error: " + str(e))
        return

    node_count = 0
    for _ in ast.walk(tree):
        node_count += 1
        if node_count > MAX_NODES:
            _write_rejected("expression too complex (too many AST nodes)")
            return

    try:
        validate_module(tree)
    except RejectedError as e:
        _write_rejected(str(e))
        return
    except RecursionError:
        _write_rejected("expression nested too deeply")
        return

    env = {}
    try:
        for stmt in tree.body[:-1]:
            value = evaluate(stmt.value, env)
            env[stmt.targets[0].id] = value
        result = evaluate(tree.body[-1].value, env)
    except EvalError as e:
        _write_error(str(e))
        return
    except RejectedError as e:
        # Should be unreachable given validate_module already ran -- fail
        # closed as an inconclusive error, never as a silent pass.
        _write_error("internal: " + str(e))
        return
    except RecursionError:
        _write_error("expression nested too deeply")
        return
    except ZeroDivisionError:
        _write_error("division by zero")
        return
    except Exception as e:
        # A genuinely unexpected interpreter-internal error -- never let it
        # propagate as an unhandled crash / non-zero exit.
        _write_error("internal evaluator error: " + str(e))
        return

    if isinstance(result, bool):
        sys.stdout.write(json.dumps({"status": "result", "value": result}))
    else:
        _write_error("the final check must evaluate to a boolean (True/False), not a plain number")


main()
`

export type RestrictedEvalOutcome =
  | { status: 'rejected'; reason: string }
  | { status: 'error'; error: string }
  | { status: 'result'; value: boolean }

export type RestrictedEvalResult =
  | { executed: true; timedOut: false; outcome: RestrictedEvalOutcome }
  | { executed: false; timedOut: boolean; rejectionReason: string }

let cachedPythonPath: string | null | undefined

/**
 * Resolves a Python interpreter on PATH. Deliberately independent of
 * python-bridge/venv (a different service's heavy dependency graph, out of
 * scope here) — this evaluator needs nothing beyond the stdlib `ast`/`math`/
 * `json` modules. Same env-override convention as pythonSandbox.ts
 * (`MATH_VERIFY_PYTHON_PATH`) so a single override still controls both
 * modules during any transition period.
 */
async function resolvePythonInterpreter(): Promise<string | null> {
  if (cachedPythonPath !== undefined) return cachedPythonPath
  const override = process.env.MATH_VERIFY_PYTHON_PATH
  if (override) {
    cachedPythonPath = override
    return cachedPythonPath
  }
  for (const candidate of ['python3', 'python', 'py']) {
    const resolved = await which(candidate)
    if (resolved) {
      cachedPythonPath = resolved
      return cachedPythonPath
    }
  }
  cachedPythonPath = null
  return cachedPythonPath
}

/** Exposed for tests only — clears the memoized interpreter path. */
export function _resetPythonInterpreterCacheForTests(): void {
  cachedPythonPath = undefined
}

function buildMinimalEnv(pythonPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Just enough PATH for the interpreter's own directory — the executed
    // script cannot spawn other programs regardless (there is no `Call` to
    // anything resembling subprocess/os in this grammar), this is
    // belt-and-braces, not load-bearing.
    PATH: dirname(pythonPath),
    PYTHONDONTWRITEBYTECODE: '1',
  }
  if (getPlatform() === 'windows') {
    // Windows subprocesses commonly fail to start without SystemRoot present
    // (DLL search path / basic OS init) — well-documented Node/Windows
    // gotcha, unrelated to anything the executed script itself can see.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  }
  return env
}

function truncate(text: string): string {
  return text.length > MAX_STDERR_CHARS_IN_ERROR
    ? `${text.slice(0, MAX_STDERR_CHARS_IN_ERROR)}…[truncated]`
    : text
}

function parseOutcome(value: unknown): RestrictedEvalOutcome | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.status === 'rejected' && typeof v.reason === 'string') {
    return { status: 'rejected', reason: v.reason }
  }
  if (v.status === 'error' && typeof v.error === 'string') {
    return { status: 'error', error: v.error }
  }
  if (v.status === 'result' && typeof v.value === 'boolean') {
    return { status: 'result', value: v.value }
  }
  return null
}

function spawnEvaluator(
  pythonPath: string,
  code: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
) {
  return execa(pythonPath, ['-I', '-S', '-B', '-c', RESTRICTED_EVAL_SCRIPT], {
    input: code,
    cwd: tmpdir(),
    env,
    extendEnv: false,
    shell: false,
    timeout: timeoutMs,
    forceKillAfterDelay: 2_000,
    cancelSignal: signal,
    maxBuffer: EXECA_MAX_BUFFER_BYTES,
    windowsHide: true,
    reject: false,
  })
}

/**
 * Evaluates a candidate verification snippet under the Tier 1 restricted
 * grammar — see this file's header comment for the full safety argument.
 * Never throws: every failure mode (no interpreter, spawn failure, timeout,
 * malformed output) resolves to `executed: false` with a reason string, and
 * every snippet-level outcome (grammar-rejected, evaluated-but-errored,
 * genuinely computed true/false) resolves to `executed: true` with a typed
 * `outcome`, so callers can distinguish "the mechanism itself didn't run"
 * from "it ran and correctly refused/computed an answer".
 */
export async function evaluateRestrictedCheck(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RestrictedEvalResult> {
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { executed: false, timedOut: false, rejectionReason: 'empty snippet' }
  }
  if (code.length > MAX_SNIPPET_CHARS) {
    return {
      executed: false,
      timedOut: false,
      rejectionReason: `snippet exceeds ${MAX_SNIPPET_CHARS} characters`,
    }
  }

  const pythonPath = await resolvePythonInterpreter()
  if (!pythonPath) {
    return {
      executed: false,
      timedOut: false,
      rejectionReason: 'no Python interpreter found on PATH (cannot run the restricted evaluator)',
    }
  }

  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))

  let result: Awaited<ReturnType<typeof spawnEvaluator>>
  try {
    result = await spawnEvaluator(pythonPath, code, timeoutMs, buildMinimalEnv(pythonPath), opts.signal)
  } catch (error) {
    return {
      executed: false,
      timedOut: false,
      rejectionReason: `failed to launch Python: ${String(error)}`,
    }
  }

  if (result.timedOut) {
    return { executed: false, timedOut: true, rejectionReason: 'evaluation timed out' }
  }
  if (result.exitCode !== 0) {
    return {
      executed: false,
      timedOut: false,
      rejectionReason: `evaluator crashed unexpectedly: ${truncate(result.stderr ?? result.stdout ?? '')}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse((result.stdout ?? '').trim())
  } catch {
    return { executed: false, timedOut: false, rejectionReason: 'evaluator produced unparseable output' }
  }

  const outcome = parseOutcome(parsed)
  if (!outcome) {
    return {
      executed: false,
      timedOut: false,
      rejectionReason: 'evaluator produced an unexpected result shape',
    }
  }

  return { executed: true, timedOut: false, outcome }
}
