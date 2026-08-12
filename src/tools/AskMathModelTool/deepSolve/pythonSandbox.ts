import { execa } from 'execa'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import treeKill from 'tree-kill'
import { getClaudeTempDir } from '../../../utils/permissions/filesystem.js'
import { getPlatform } from '../../../utils/platform.js'
import { which } from '../../../utils/which.js'

/**
 * ============================================================================
 * RETIRED — 2026-08-12 (Session 11). DO NOT WIRE THIS BACK INTO THE LIVE
 * PIPELINE. Kept in the tree for historical/audit reference only: three
 * consecutive independent security-audit rounds (see Sessions 8/9/10 in
 * LOCAL_AI_STATUS.md) each closed one reported RCE class in this file's
 * denylist and found the SAME class reachable a different way, ending in a
 * live one-line full RCE (`dataclasses.inspect.os.system(...)`) that needed
 * no `import` call at all — plain attribute traversal on an already-
 * imported module. The conclusion, now settled in
 * LOCAL_AI_MASTER_PLAN.md §11 "Verifier isolation — the settled answer":
 * in-process Python denylisting is a known-unwinnable problem (CPython's
 * shared, introspective module cache means the reachable-dangerous-object
 * set is open-ended and cannot be enumerated by any denylist, no matter how
 * many rounds of names get added to it). This is not a "the denylist wasn't
 * complete yet" situation — the *shape* of the approach (validate untrusted
 * source text, then hand it to Python's own interpreter to actually run) is
 * what's wrong, not the specific names that were banned. Do not attempt a
 * round-4 name-ban patch on this file.
 *
 * DeepSolve's verification step now uses
 * `deepSolve/restrictedEvaluator.ts` instead: an ALLOWLIST of AST node types
 * (not a denylist of names) that never calls Python's eval()/exec()/
 * compile() on anything — it walks the parsed tree itself and computes a
 * result node-by-node from a small, fixed set of arithmetic operations and a
 * fixed function table. `verification.ts` no longer imports anything from
 * this file. See restrictedEvaluator.ts's own header comment for the full
 * "why this is actually safe" argument, and LOCAL_AI_MASTER_PLAN.md §11 for
 * the architectural writeup this decision follows.
 *
 * Everything below this banner is the ORIGINAL (retired) implementation,
 * unmodified, preserved so a future reader can see exactly what was tried
 * and why each round failed (see this file's own "ROUND 2" section and
 * LOCAL_AI_STATUS.md Sessions 6/8/9/10 for the full history, including the
 * round-3 finding that ended this approach).
 * ============================================================================
 *
 * The narrowest possible local code-execution mechanism for DeepSolve's
 * verification step (see LOCAL_AI_MASTER_PLAN.md §11 / §8 Phase 3.5).
 *
 * WHY THIS EXISTS INSTEAD OF REUSING THE BASH TOOL'S SANDBOX
 * -----------------------------------------------------------
 * This project already has a reviewed sandbox mechanism
 * (@anthropic-ai/sandbox-runtime, wrapped by
 * src/utils/sandbox/sandbox-adapter.ts and src/tools/BashTool/shouldUseSandbox.ts)
 * and the default assumption going in was to reuse it. Investigated and
 * ruled out for two independent reasons, verified by reading the actual
 * package source (node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/
 * sandbox-manager.js, isSupportedPlatform()):
 *
 * 1. Platform: `isSupportedPlatform()` returns `platform === 'linux' || platform
 *    === 'macos'` (WSL1 explicitly excluded too). `getPlatform()` maps
 *    `process.platform === 'win32'` to `'windows'`, which is neither — so on
 *    this project's actual dev/runtime machine (native Windows, not WSL),
 *    `SandboxManager.isSandboxingEnabled()` is unconditionally `false`
 *    regardless of settings. There is no "invoke it non-interactively"
 *    question to answer: the underlying OS-level primitives (bubblewrap,
 *    Seatbelt) don't exist on Windows at all. Reusing sandbox-runtime here
 *    would silently no-op on this machine.
 * 2. Even where the sandbox-runtime IS supported, it wraps a *shell command*
 *    the model asked to run and is wired into the interactive
 *    permission-prompt flow (BashTool). DeepSolve's verification step is
 *    internal plumbing inside AskMathModelTool's own call() — a nested nvocation
 *    from inside another tool, run up to N times per user turn — not a
 *    user-facing "the model wants to run a command" event. Routing it
 *    through the permission-prompt UI would mean prompting per-candidate,
 *    which is both bad UX and not what that plumbing is designed for. (The
 *    outer AskMathModelTool call itself now DOES prompt once per deep-mode
 *    invocation — see AskMathModelTool.ts's checkPermissions — but that is a
 *    single tool-level gate, not a per-candidate one; this mechanism still
 *    has no permission-prompt integration of its own.)
 *
 * So per LOCAL_AI_MASTER_PLAN.md's explicit fallback instruction, this is a
 * dedicated, narrow mechanism: run one short Python snippet, no shell, no
 * arbitrary paths, hard timeout, layered defenses, nothing else. It is NOT a
 * general "run any Python" capability and must not become one.
 *
 * LAYERED DEFENSES (read together, no single one is a hard guarantee alone)
 * ---------------------------------------------------------------------------
 * - No shell involved at all: the snippet is written to a file we create at
 *   a path we control, then executed via `execa(pythonPath, [scriptPath])`
 *   with `shell: false` — argv array, never string interpolation. There is
 *   no command-injection surface because there is no command string.
 * - Import allowlist (default-deny) enforced via REAL static analysis — see
 *   "STATIC VALIDATION" below — of a fixed list of pure-computation
 *   standard-library modules (see ALLOWED_IMPORTS below). Anything else —
 *   os, sys, subprocess, socket, urllib, requests, ctypes, pathlib, shutil,
 *   multiprocessing, threading, importlib, pickle, etc. — is rejected before
 *   the interpreter ever starts.
 * - Dangerous-identifier denylist, independent of imports and of call
 *   syntax: eval, exec, compile, __import__, open, input, globals, locals,
 *   vars, getattr, setattr, delattr, breakpoint, exit, quit, help,
 *   memoryview, attrgetter, methodcaller, __builtins__, and dunder-attribute
 *   gadgets (__class__, __bases__, __subclasses__, __globals__, __mro__,
 *   __code__, __closure__, __loader__, __reduce__, __reduce_ex__,
 *   __getattribute__, and others — see BANNED_ATTRS in the linter script
 *   below). Any *reference* to one of these — not just a call with an
 *   adjacent paren — is rejected. See "STATIC VALIDATION" below for why this
 *   closes the aliasing/whitespace bypasses a text-substring scan cannot.
 * - Process launched with `-I` (isolated mode: ignores PYTHONPATH/user site,
 *   no environment-based interpreter manipulation) and `-S` (skip site
 *   initialization, so no sitecustomize hooks and no implicit user
 *   site-packages on the import path) — real interpreter-level hardening,
 *   independent of the static-analysis checks above.
 * - Minimal, explicitly-built environment (`extendEnv: false`) — the child
 *   never inherits this process's environment, so no API keys or other
 *   ambient secrets (this project's own OPENAI_API_KEY / ANTHROPIC_API_KEY /
 *   NVIDIA NIM key in a local .env, etc.) are exposed to it, defense in
 *   depth on top of `os` being import-denied entirely.
 * - Fresh, uniquely-named temp directory per call (nested under this
 *   project's own getClaudeTempDir(), matching this codebase's existing temp
 *   dir convention) used as both the write location for the script and the
 *   child's cwd; deleted in a `finally` block whether execution succeeded,
 *   failed, or timed out.
 * - Hard timeout (default DEFAULT_TIMEOUT_MS, hard-capped at MAX_TIMEOUT_MS
 *   regardless of what a caller requests) via execa's own `timeout` option,
 *   plus a belt-and-braces `treeKill(pid, 'SIGKILL')` after resolution —
 *   the same primitive this codebase's own ShellCommand.ts already uses to
 *   guarantee a spawned process (and, on Windows, its process tree via
 *   `taskkill /T`) is actually gone, not just sent a signal it might ignore.
 * - Output capped (maxBuffer + a further truncation on what's returned) so a
 *   runaway print loop can't blow up memory or flood the caller.
 *
 * STATIC VALIDATION — now real AST analysis, not text matching
 * ---------------------------------------------------------------------------
 * A 2026-08-12 security review found the previous regex/substring validator
 * bypassable (Findings 1-3): `'eval('`-style literal-substring matching
 * missed `z = __import__` + `z(...)` (aliasing), `open (...)` (a space
 * before the paren), and the line-anchored import regex missed
 * `import math, os` (comma-separated), `x = 1; import os`
 * (semicolon-chained), `if True: import subprocess` (indented inside a
 * block), and backslash-continued import lines — an inherent limitation of
 * matching *text* against a grammar regex can't fully enumerate.
 *
 * Fixed by actually parsing the snippet with Python's own `ast` module
 * (ships with every Python 3 install — no new dependency) via a small,
 * fixed, trusted linter script this file spawns the same resolved
 * interpreter to run (source embedded below as AST_LINTER_SCRIPT; the
 * user-supplied snippet is passed on stdin, never interpolated into the
 * script's own source). It walks the real parsed tree with `ast.walk()`,
 * which sees `import math, os` as one `Import` node with two `alias`
 * entries (both checked), and finds `if True: import subprocess` and
 * `x = 1; import os` identically to a plain top-level import — there is no
 * surface-syntax hiding place once the actual grammar is parsing it.
 * Aliasing is closed without needing dataflow/taint tracking: EVERY
 * `ast.Name` node (regardless of Load/Store/Del context) whose `id` is a
 * banned identifier is rejected, so `z = __import__` is itself a rejected
 * reference — `z(...)` never gets the chance to run. Multi-hop attribute
 * re-aliasing is closed the same way: the attribute *name* `attrgetter` /
 * `methodcaller` (Finding 3's `operator.attrgetter`/`methodcaller`
 * getattr-equivalent) is banned regardless of what object it's accessed on,
 * so `op = operator; op2 = op; op2.attrgetter` is rejected without needing
 * to prove `op2` resolves back to the `operator` module.
 *
 * This is still static analysis (what the snippet *could* reference), not a
 * runtime capability sandbox — see HONEST LIMITS below — but it now
 * inspects the real parsed structure Python's own grammar produces rather
 * than substrings of the source text, which is the specific class of bypass
 * the review demonstrated.
 *
 * ROUND 2 (2026-08-12) — the AST validator's own remaining blind spot, and
 * what was done about it
 * ---------------------------------------------------------------------------
 * A second independent review found that the AST walk above only inspects
 * real syntax NODES — it never looks inside STRING LITERAL CONTENTS. `typing`
 * is in ALLOWED_IMPORTS, and `typing.get_type_hints()` evaluates
 * string/forward-reference type annotations as real Python code internally
 * via its own `eval()` call. A payload hidden inside a string constant is
 * therefore invisible to the walk (it's just an opaque `ast.Constant`), but
 * Python's own `typing` module parses and executes that text at runtime:
 *
 *   import typing
 *   def _c() -> "__import__('os').popen('whoami').read()":
 *       pass
 *   typing.get_type_hints(_c)   # executes the annotation string as code
 *
 * Reproduced live against this file's pre-round-2 code (confirmed the
 * payload's `os.getcwd()`/`os.listdir()` output leaking into the resulting
 * SyntaxError's own message — proof the import and filesystem calls
 * actually ran, not just a theoretical read of the CPython source). A
 * related variant, `"{0.__class__.__init__.__globals__[k]}".format(x)`,
 * performs attribute-traversal driven by a *format-spec string* — also
 * invisible to the walk, and also reproduced live (cleanly leaked
 * `__name__` with no error at all).
 *
 * The broader audit this round also asked for ("audit typing more broadly")
 * turned up two more things, empirically confirmed, not just theorized:
 *  - `typing.TypeVar("T", bound="<payload>").__bound__` returns a
 *    `ForwardRef` instance *without ever referencing the name `ForwardRef`
 *    at all* — calling `.evaluate()` on it triggers the identical eval-a-
 *    string behavior. Closed by banning `evaluate`/`_evaluate` as attribute
 *    names (see BANNED_ATTRS), not just `ForwardRef`/`get_type_hints`
 *    themselves.
 *  - Independently of any string-eval trick at all: several ALLOWED_IMPORTS
 *    modules expose a live reference to the real `sys` or `builtins` module
 *    as a plain attribute, because they `import sys`/`import builtins as
 *    bltns` at their own module scope — `typing.sys`, `fractions.sys`,
 *    `statistics.sys`, `dataclasses.sys`, `enum.sys`, `enum.bltns`,
 *    `collections._sys`. `enum.bltns.__import__('os').popen(...)` is a
 *    *simpler* full RCE than the string-eval one above — no annotation, no
 *    eval, just plain attribute traversal on an already-imported module —
 *    and was confirmed working against the pre-round-2 validator. Closed by
 *    banning `sys`/`_sys`/`bltns` as both identifiers and attribute names.
 *
 * All of the above are fixed the same way Findings 1-3 were: adding the
 * specific names to BANNED_IDENTIFIERS/BANNED_ATTRS. This closes exactly
 * what was found, empirically confirmed rejected (see pythonSandbox.test.ts),
 * but per the HONEST LIMITS note below (now even more true after two rounds
 * of "closed the reported bypass, found a new one in the same mechanism"),
 * a fixed denylist can never be a complete enumeration of every way Python's
 * stdlib might turn a string — or an already-imported module's own
 * attributes — into an executed capability. This is *why* round 2 also adds
 * RUNTIME_IMPORT_GUARD_PREFIX below: a second, structurally different
 * enforcement layer that doesn't depend on enumerating names at all for the
 * import chokepoint specifically. See "RUNTIME ENFORCEMENT" below.
 *
 * HONEST LIMITS (documented for the security reviewer, not hidden)
 * ---------------------------------------------------------------------------
 * - This is real AST-based static analysis, but it is still static analysis
 *   of source structure, not a full Python capability/taint system. It does
 *   not attempt general dataflow analysis (e.g. it would not catch a
 *   dynamically-constructed banned identifier assembled at runtime via
 *   string concatenation and then invoked through some other allowed
 *   dynamic-dispatch mechanism, if one existed among the allowed modules —
 *   none is currently known to the allowlisted set, and the module
 *   allowlist itself is the actual boundary, not an exhaustive per-symbol
 *   audit of every function in every allowed stdlib module). Sized for its
 *   actual threat model — a 3B local model asked to write a short self-check
 *   of its own arithmetic, not a red-team adversary — and paired with the
 *   process-level defenses above specifically so a gap in this layer
 *   doesn't translate into unrestricted execution. Round 2 demonstrated this
 *   is not a hypothetical caveat: it found real bypasses via string-literal
 *   content (invisible to any AST walk by construction, since a string
 *   constant is a string constant regardless of what it says) and via
 *   already-in-scope module attributes (a namespace/dataflow question the
 *   walk doesn't answer). RUNTIME_IMPORT_GUARD_PREFIX (see "RUNTIME
 *   ENFORCEMENT" below) is the structural answer to the *first* category for
 *   the import chokepoint specifically; the second category (reaching a
 *   dangerous already-imported object via attribute traversal, with no
 *   import call at all — the `enum.bltns`/`typing.sys` class) is NOT closed
 *   by the runtime guard, only by this static denylist, which is honestly
 *   not exhaustive. A future undiscovered variant of that second category
 *   remains a real, open risk this design does not eliminate.
 * - There is no OS-level network-namespace or filesystem-namespace
 *   isolation here (no bubblewrap/Job Object equivalent is wired up) — the
 *   import allowlist is what actually prevents network/arbitrary-file
 *   access (no socket/http/urllib/requests/os/pathlib/shutil means no way
 *   to reach the network or the filesystem using only what's importable),
 *   not an OS-enforced boundary. Worth explicit note: this project's own
 *   BashTool is in the identical position on this same Windows machine —
 *   sandbox-runtime doesn't cover Windows either, so BashTool already runs
 *   unsandboxed here today and relies entirely on the interactive
 *   permission prompt.
 * - No CPU/memory ulimits are applied (Windows has no simple equivalent
 *   without a native Job Object binding, which isn't part of this
 *   codebase's dependency set) — the timeout is the primary resource bound.
 * - The AST linter subprocess itself runs the same resolved interpreter
 *   with the same `-I -S -B` isolation and minimal env as the real
 *   execution — if the linter can't even be spawned (e.g. a bogus
 *   MATH_VERIFY_PYTHON_PATH override), validation fails closed (the snippet
 *   is rejected), it never silently "skips" static validation and falls
 *   through to execution.
 *
 * RUNTIME ENFORCEMENT — a second, structurally different layer (round 2)
 * ---------------------------------------------------------------------------
 * Everything above is static: it inspects what the snippet's source *could*
 * do before any of it runs. RUNTIME_IMPORT_GUARD_PREFIX (defined further
 * below, near AST_LINTER_SCRIPT) is prepended to the *executed* script (never
 * to what the linter parses) and enforces the same module allowlist again,
 * for real, at the moment an import is actually attempted — so a future
 * static-analysis blind spot in the category above (string-hidden or
 * otherwise) still can't reach a non-allowlisted import when the payload
 * actually runs, regardless of whether it originates from the script's own
 * top-level code or from inside some allowed module's internal machinery.
 * This was verified directly, not assumed: with the round-2 static bans
 * temporarily removed in a test, the runtime guard alone still stopped both
 * `typing.get_type_hints`'s internal eval AND `enum.bltns.__import__('os')`
 * from reaching a real import of `os`.
 *
 * State plainly, not overclaimed: this closes the IMPORT chokepoint,
 * empirically confirmed for both "hidden in a string" and "reached via an
 * allowed module's own attribute" cases — but it does NOT close attribute
 * traversal to an already-imported dangerous object that never calls
 * `__import__` at all (confirmed empirically: `typing.sys.modules['os']` —
 * a plain dict lookup on `sys`'s already-populated module cache — is
 * completely unaffected by the runtime guard; only the static `sys`/`_sys`/
 * `bltns` ban above stops it). "Even if the static scan misses a payload,
 * the payload can no longer reach a non-allowlisted import when it actually
 * executes" is the honest bar this meets — not "unbypassable". See
 * RUNTIME_IMPORT_GUARD_PREFIX's own doc comment for the full mechanism,
 * including why `sys.modules` cache presence is deliberately NOT trusted as
 * a reason to allow a name (verified empirically that `os` itself, along
 * with `winreg`, ends up in `sys.modules` as legitimate priming plumbing on
 * this platform — a cache-based exception would have reopened the hole),
 * and the separate, narrower `__builtins__`-stripping layer bundled with it.
 */

const DEFAULT_TIMEOUT_MS = 8_000
const MAX_TIMEOUT_MS = 15_000
const MAX_SNIPPET_CHARS = 20_000
const MAX_CAPTURED_OUTPUT_CHARS = 4_000
// execa's own maxBuffer, in bytes — generous relative to
// MAX_CAPTURED_OUTPUT_CHARS since we truncate again afterward; this just
// stops an extreme print-loop from consuming unbounded memory before we
// even get to truncate.
const EXECA_MAX_BUFFER_BYTES = 1_000_000
// The AST linter only parses source text (no I/O, no loops driven by
// untrusted input) — it should always finish in well under a second. A
// short, fixed timeout independent of the caller's execution timeout is
// enough headroom while still failing closed promptly if something is
// badly wrong with the resolved interpreter.
const AST_LINTER_TIMEOUT_MS = 5_000

/**
 * Pure-computation standard-library modules a math verification snippet is
 * plausibly allowed to need. Default-deny: anything not in this list is
 * rejected, including third-party packages that might happen to be
 * importable on whatever Python is resolved. Exported so tests can assert
 * against the real allowlist instead of a hand-duplicated copy. Kept in
 * sync with AST_LINTER_SCRIPT's own ALLOWED_IMPORTS (duplicated there since
 * the linter runs as a standalone Python process and can't import this
 * file) — update both together.
 */
export const ALLOWED_IMPORTS = new Set([
  'math',
  'cmath',
  'fractions',
  'decimal',
  'statistics',
  'itertools',
  'functools',
  'operator',
  're',
  'string',
  'collections',
  'heapq',
  'bisect',
  'numbers',
  'typing',
  'dataclasses',
  'enum',
])

/**
 * Single source of truth for the Python-literal form of ALLOWED_IMPORTS, so
 * a third hand-duplicated copy isn't introduced now that a second script
 * (RUNTIME_IMPORT_GUARD_PREFIX, added 2026-08-12 round 2) needs the same
 * set. AST_LINTER_SCRIPT's own copy is still a separate literal (pre-dates
 * this helper, see its own comment) — not worth churning in a security fix
 * whose job is to close bypasses, not refactor unrelated working code.
 */
function pyStringSetLiteral(values: Iterable<string>): string {
  return [...values].map(v => JSON.stringify(v)).join(', ')
}

/**
 * Real static analysis via Python's own `ast` module — see this file's
 * header comment ("STATIC VALIDATION") for the full design rationale. The
 * snippet under test is supplied on stdin, never interpolated into this
 * script's own source, so there is no way for snippet content to alter what
 * the linter itself does.
 *
 * Every `ast.Name` reference (regardless of load/store/del context) to a
 * BANNED_IDENTIFIERS entry is rejected, and every `ast.Attribute` access
 * whose `.attr` is a BANNED_ATTRS entry is rejected — both independent of
 * whether the reference is immediately called, aliased through a variable,
 * or re-aliased through another variable. `ast.Import`/`ast.ImportFrom` are
 * walked via `ast.walk()`, which finds them regardless of nesting,
 * comma-separation, semicolon-chaining, or line continuation.
 *
 * Also reports two structural facts as a byproduct of the same walk, used
 * by verification.ts (Finding 5: a bare `print("VERIFIED")` with no real
 * check must not count as a genuine pass): `hasComparison` (an `ast.Compare`
 * node where at least one operand is not a bare literal constant — so
 * `1 == 1` doesn't count, but `computed == expected` does) and
 * `hasNonPrintCall` (a `Call` node targeting anything other than the bare
 * `print` builtin).
 */
const AST_LINTER_SCRIPT = `
import ast
import json
import sys

ALLOWED_IMPORTS = {
    "math", "cmath", "fractions", "decimal", "statistics", "itertools",
    "functools", "operator", "re", "string", "collections", "heapq",
    "bisect", "numbers", "typing", "dataclasses", "enum",
}

BANNED_IDENTIFIERS = {
    "eval", "exec", "compile", "__import__", "open", "input", "globals",
    "locals", "vars", "getattr", "setattr", "delattr", "breakpoint",
    "exit", "quit", "help", "copyright", "license", "credits",
    "memoryview", "attrgetter", "methodcaller", "__builtins__",
    # 2026-08-12 round-2 review: typing.get_type_hints() evaluates
    # string/forward-reference annotations as real code via its own
    # internal eval() -- a payload hidden inside an annotation *string*
    # constant is invisible to this AST walk (it's just an opaque
    # Constant node) but gets executed at runtime when get_type_hints()
    # (or the lower-level primitives it's built from) runs. Banning the
    # bare-name/import forms here; the attribute forms (typing.X) are
    # banned in BANNED_ATTRS below since that's how these are normally
    # reached.
    "get_type_hints", "ForwardRef", "_eval_type",
    # 'sys'/'_sys'/'bltns' (enum.py's own internal alias for the real
    # 'builtins' module) are exposed as plain attributes on several
    # ALLOWED_IMPORTS modules (typing.sys, fractions.sys, statistics.sys,
    # dataclasses.sys, enum.sys, enum.bltns, collections._sys) -- reaching
    # any of these gives a direct, no-string-eval-required path to the
    # real 'sys'/'builtins' modules (e.g. enum.bltns.__import__('os') or
    # typing.sys.modules['os']), found during the same broader audit.
    # Banned as both identifier and attribute names for the same reason
    # attrgetter/methodcaller are (Finding 3, round 1): the ban is on the
    # *name*, not on proving what object it resolves to, so re-aliasing
    # doesn't help either.
    "sys", "_sys", "bltns",
}

BANNED_ATTRS = {
    "__class__", "__bases__", "__subclasses__", "__globals__",
    "__builtins__", "__mro__", "__code__", "__closure__", "__loader__",
    "__reduce__", "__reduce_ex__", "__getattribute__", "__setattr__",
    "__delattr__", "__init_subclass__", "__subclasshook__", "__dict__",
    "__self__", "__func__", "__module__", "__weakref__",
    "attrgetter", "methodcaller",
    # get_type_hints/ForwardRef/_eval_type: see BANNED_IDENTIFIERS comment
    # above -- these are almost always reached as typing.get_type_hints
    # etc. (an Attribute node), not a bare Name, so both forms are banned.
    # 'evaluate'/'_evaluate': ForwardRef's own evaluation method -- reachable
    # WITHOUT ever naming ForwardRef at all (empirically confirmed:
    # typing.TypeVar("T", bound="<payload>").__bound__ returns a
    # ForwardRef instance from TypeVar's own internal bound-resolution
    # machinery; calling .evaluate() on that instance triggers the same
    # eval-a-string behavior). Banning the attribute name closes this
    # regardless of how the ForwardRef instance was obtained.
    "get_type_hints", "ForwardRef", "evaluate", "_evaluate", "_eval_type",
    # 'format': str.format() performs attribute-traversal driven by a
    # format-spec string (e.g. "{0.__class__.__init__.__globals__}"), which
    # is likewise invisible to this AST walk -- the format spec is just
    # string content inside a Constant node. Disclosure-only in this
    # sandbox's minimal env (no eval/exec reachable through it alone), but
    # closed symmetrically to attrgetter/methodcaller. Legitimate numeric
    # formatting in a verification snippet can still use f-strings
    # (compile to JoinedStr/FormattedValue, not an Attribute/Call node) or
    # %-formatting -- this bans the .format() *method*, not all formatting.
    "format",
    "sys", "_sys", "bltns",
}


def fail(reason):
    sys.stdout.write(json.dumps({"ok": False, "reason": reason}))
    sys.exit(0)


def main():
    source = sys.stdin.read()
    try:
        tree = ast.parse(source, filename="<verify>")
    except SyntaxError as e:
        fail("syntax error: " + str(e))
        return
    except Exception as e:
        fail("parse error: " + str(e))
        return

    has_comparison = False
    has_non_print_call = False

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top not in ALLOWED_IMPORTS:
                    fail("disallowed import: " + alias.name)
                    return
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                fail("relative imports are not allowed")
                return
            if node.module is None:
                fail("import with no module is not allowed")
                return
            top = node.module.split(".")[0]
            if top not in ALLOWED_IMPORTS:
                fail("disallowed import: " + node.module)
                return
            for alias in node.names:
                if alias.name == "*":
                    fail("wildcard imports are not allowed")
                    return
                if alias.name in BANNED_IDENTIFIERS:
                    fail("disallowed import: " + node.module + "." + alias.name)
                    return
        elif isinstance(node, ast.Name):
            if node.id in BANNED_IDENTIFIERS:
                fail("disallowed identifier: " + node.id)
                return
        elif isinstance(node, ast.Attribute):
            if node.attr in BANNED_ATTRS:
                fail("disallowed attribute: " + node.attr)
                return
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                if func.id != "print":
                    has_non_print_call = True
            else:
                has_non_print_call = True
        elif isinstance(node, ast.Compare):
            operands = [node.left] + list(node.comparators)
            if not all(isinstance(o, ast.Constant) for o in operands):
                has_comparison = True

    sys.stdout.write(json.dumps({
        "ok": True,
        "hasComparison": has_comparison,
        "hasNonPrintCall": has_non_print_call,
    }))


main()
`

/**
 * RUNTIME IMPORT GUARD — defense-in-depth added 2026-08-12 (round 2), see
 * this file's header comment ("RUNTIME ENFORCEMENT") for the full design
 * rationale, what it does and does not close, and how it was empirically
 * verified. Summary: prepended to the *executed* script (never to what the
 * AST linter above validates — the linter still only ever sees the raw
 * untrusted snippet), this fixed, trusted preamble runs before a single line
 * of the untrusted snippet does, and:
 *
 *  1. Primes sys.modules by really importing every ALLOWED_IMPORTS module
 *     via the real, unguarded __import__ first — CPython's own pure-Python
 *     stdlib modules transitively need internal plumbing (`_io`, `ntpath`,
 *     even `os` itself on Windows) to load at all, so priming has to happen
 *     BEFORE the strict guard activates or ordinary `import math` would
 *     itself get blocked. Verified empirically (see pythonSandbox.test.ts).
 *  2. Overrides the *shared* `builtins.__import__` (not a local copy) with a
 *     function that re-checks the same ALLOWED_IMPORTS allowlist at the
 *     moment any import is actually attempted — regardless of whether the
 *     request came from a top-level `import` statement, a dynamically
 *     eval()'d string, or from inside some allowed module's own internal
 *     machinery. Deliberately does NOT trust "already in sys.modules" as a
 *     reason to allow a name — `os`/`winreg` end up cached as legitimate
 *     priming plumbing (confirmed empirically), so a cache-based exception
 *     would have reopened exactly the hole this exists to close.
 *  3. Also installs a sys.meta_path finder at position 0 enforcing the
 *     identical allowlist, as a second, independent check — belt-and-braces
 *     in case some import path ever reaches the finder chain without going
 *     through builtins.__import__.
 *  4. Strips a short list of other dangerous builtins (eval, exec, compile,
 *     open, input, globals, locals, vars, getattr, setattr, delattr,
 *     breakpoint — NOT __import__, which stays present but now points at
 *     the guarded function, since the script's own `import` statements
 *     still need it) from the *executed script's own* `__builtins__`
 *     mapping. Empirically confirmed narrower than the import guard (see
 *     header comment) but real: it independently stops any future
 *     undiscovered mechanism that, like get_type_hints/annotationlib, calls
 *     eval()/exec() with the *script's own* globals/locals as an explicit
 *     argument — which is exactly the shape of the bug this round fixes.
 *
 * Built from ALLOWED_IMPORTS via pyStringSetLiteral so this doesn't become a
 * third hand-duplicated copy of the module list.
 */
const RUNTIME_IMPORT_GUARD_PREFIX = `
def _install_sandbox_runtime_guard():
    import builtins as _b
    import sys as _sys

    _allowed = {${pyStringSetLiteral(ALLOWED_IMPORTS)}}

    _real_import = _b.__import__

    # Prime sys.modules for every allowed module's own transitive internal
    # dependencies using the real/unguarded import machinery, BEFORE the
    # strict guard below activates. See this file's RUNTIME_IMPORT_GUARD_PREFIX
    # doc comment (TypeScript side) for why this is necessary on Windows.
    for _m in _allowed:
        try:
            _real_import(_m)
        except Exception:
            pass

    def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level and level > 0:
            raise ImportError("sandbox runtime guard: relative imports are not allowed")
        top = name.split(".", 1)[0] if name else ""
        if top not in _allowed:
            raise ImportError("sandbox runtime guard: import of %r is not allowed" % (name,))
        return _real_import(name, globals, locals, fromlist, level)

    _b.__import__ = _guarded_import

    class _DenySandboxFinder:
        @staticmethod
        def find_spec(fullname, path=None, target=None):
            top = fullname.split(".", 1)[0] if fullname else ""
            if top not in _allowed:
                raise ImportError("sandbox runtime guard: import of %r is not allowed" % (fullname,))
            return None

    _sys.meta_path.insert(0, _DenySandboxFinder())

    # Narrower, supplementary layer -- see doc comment point 4 above. Keeps
    # __import__ (now the guarded version) so the script's own top-level
    # import statements keep working.
    _strip_names = ("eval", "exec", "compile", "open", "input", "globals", "locals", "vars", "getattr", "setattr", "delattr", "breakpoint")
    _restricted_builtins = {k: v for k, v in vars(_b).items() if k not in _strip_names}
    globals()["__builtins__"] = _restricted_builtins


_install_sandbox_runtime_guard()
del _install_sandbox_runtime_guard
`

/**
 * Structural facts about a validated snippet, reported by the AST linter as
 * a byproduct of the same walk that does security validation. Used by
 * verification.ts to decide whether a VERIFIED-printing snippet did enough
 * real work to be trusted (see Finding 5 in this file's header comment).
 */
export type SnippetMeta = {
  hasComparison: boolean
  hasNonPrintCall: boolean
}

type AstLintResult =
  | { ok: true; hasComparison?: boolean; hasNonPrintCall?: boolean }
  | { ok: false; reason?: string }

export type ValidationResult = { ok: true; meta: SnippetMeta } | { ok: false; reason: string }

function spawnAstLinter(pythonPath: string, code: string) {
  return execa(pythonPath, ['-I', '-S', '-B', '-c', AST_LINTER_SCRIPT], {
    input: code,
    cwd: tmpdir(),
    env: buildMinimalEnv(pythonPath),
    extendEnv: false,
    shell: false,
    timeout: AST_LINTER_TIMEOUT_MS,
    forceKillAfterDelay: 2_000,
    maxBuffer: EXECA_MAX_BUFFER_BYTES,
    windowsHide: true,
    reject: false,
  })
}

async function runAstLinter(code: string, pythonPath: string): Promise<ValidationResult> {
  let result: Awaited<ReturnType<typeof spawnAstLinter>>
  try {
    result = await spawnAstLinter(pythonPath, code)
  } catch (error) {
    // Fail closed: if the linter itself couldn't even be spawned (e.g. a
    // bogus MATH_VERIFY_PYTHON_PATH override), the snippet is rejected
    // rather than silently skipping static validation and falling through
    // to execution.
    return { ok: false, reason: `static validation failed to run: ${String(error)}` }
  }

  if (result.timedOut) {
    return { ok: false, reason: 'static validation (ast parse) timed out' }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `static validation crashed unexpectedly: ${truncate(result.stderr ?? result.stdout ?? '')}`,
    }
  }

  let parsed: AstLintResult
  try {
    parsed = JSON.parse((result.stdout ?? '').trim()) as AstLintResult
  } catch {
    return { ok: false, reason: 'static validation produced unparseable output' }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'static validation produced an unexpected result' }
  }
  if (parsed.ok !== true) {
    return {
      ok: false,
      reason: !parsed.ok && parsed.reason ? parsed.reason : 'disallowed construct',
    }
  }
  return {
    ok: true,
    meta: {
      hasComparison: parsed.hasComparison === true,
      hasNonPrintCall: parsed.hasNonPrintCall === true,
    },
  }
}

/**
 * Static default-deny validation of a candidate verification snippet, via
 * real parsing of Python's own grammar (see "STATIC VALIDATION" above) —
 * spawns the resolved Python interpreter to run AST_LINTER_SCRIPT against
 * the snippet. Exported for unit testing independent of actually executing
 * the snippet for real.
 */
export async function validatePythonSnippet(code: string): Promise<ValidationResult> {
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { ok: false, reason: 'empty snippet' }
  }
  if (code.length > MAX_SNIPPET_CHARS) {
    return { ok: false, reason: `snippet exceeds ${MAX_SNIPPET_CHARS} characters` }
  }

  const pythonPath = await resolvePythonInterpreter()
  if (!pythonPath) {
    return { ok: false, reason: 'no Python interpreter found on PATH (cannot run static validation)' }
  }

  return runAstLinter(code, pythonPath)
}

export type PythonExecResult = {
  /** False if the snippet never ran at all (validation failure or no interpreter found). */
  executed: boolean
  rejectionReason?: string
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Only present when executed is true — structural facts from the AST
   * validation pass that ran immediately before execution. */
  snippetMeta?: SnippetMeta
}

function truncate(text: string): string {
  return text.length > MAX_CAPTURED_OUTPUT_CHARS
    ? `${text.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}…[truncated]`
    : text
}

let cachedPythonPath: string | null | undefined

/**
 * Resolves a Python interpreter on PATH. Deliberately independent of
 * python-bridge/venv (that venv is a different service's dependency graph —
 * heavy, torch/transformers-laden, and out of scope here per the task's own
 * instruction to keep this entirely on the TypeScript/tool side). Pure
 * stdlib verification code needs nothing that venv provides.
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
    // Just enough PATH for the interpreter's own directory — not the full
    // system PATH — since the executed script cannot spawn other programs
    // anyway (subprocess/os are import-denied), this is belt-and-braces,
    // not load-bearing.
    PATH: dirname(pythonPath),
    PYTHONDONTWRITEBYTECODE: '1',
  }
  if (getPlatform() === 'windows') {
    // Windows subprocesses commonly fail to start without SystemRoot present
    // (DLL search path / basic OS init) — well-documented Node/Windows
    // gotcha, unrelated to anything the executed script itself can see or
    // use.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  }
  return env
}

/**
 * Runs a single Python snippet under the layered defenses documented at the
 * top of this file — always validates via the real AST linter first
 * (validatePythonSnippet), then executes only if that passes. Never throws —
 * failures (validation rejection, missing interpreter, crash, timeout) are
 * all reported via the returned result so callers can distinguish "provably
 * failed the check" from "couldn't be checked at all".
 *
 * Validation runs against the raw, untrusted `code` only (unchanged from
 * before this file's round-2 fix). What's actually written to disk and
 * executed is RUNTIME_IMPORT_GUARD_PREFIX + the validated code — the guard
 * preamble is fixed, trusted source this file controls, never derived from
 * or influenced by the snippet, and runs first so it's active before a
 * single line of the untrusted snippet executes. See RUNTIME_IMPORT_GUARD_PREFIX's
 * own doc comment and this file's header comment ("RUNTIME ENFORCEMENT") for
 * what this closes and what it honestly doesn't.
 */
export async function runPythonSnippet(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PythonExecResult> {
  const validation = await validatePythonSnippet(code)
  if (!validation.ok) {
    return {
      executed: false,
      rejectionReason: validation.reason,
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
    }
  }

  return executeGuardedScript(code, opts, validation.meta)
}

/**
 * The actual spawn-and-run mechanics, factored out of runPythonSnippet so
 * the test-only bypass export below (_runPythonSnippetBypassingStaticValidationForTests)
 * can exercise RUNTIME_IMPORT_GUARD_PREFIX in isolation — i.e. simulate "the
 * static AST validator missed this payload" and confirm the runtime guard
 * alone still stops a non-allowlisted import when it actually executes, per
 * this file's "RUNTIME ENFORCEMENT" header comment. The real runPythonSnippet
 * call path above always validates first; this helper never does on its own.
 */
async function executeGuardedScript(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal },
  snippetMeta: SnippetMeta | undefined,
): Promise<PythonExecResult> {
  const pythonPath = await resolvePythonInterpreter()
  if (!pythonPath) {
    // Unreachable in practice via runPythonSnippet — validatePythonSnippet
    // already resolves the interpreter and fails closed if none is found.
    // Kept as an explicit, defensive branch rather than a non-null assertion
    // (and reachable directly via the test-only bypass export above).
    return {
      executed: false,
      rejectionReason: 'no Python interpreter found on PATH',
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
    }
  }

  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))

  // Fresh, uniquely-named temp dir per call, nested under this project's own
  // temp dir convention (falls back to the OS tmp dir if that's ever
  // unavailable for some reason — still unique and still cleaned up).
  let tempDirBase: string
  try {
    tempDirBase = getClaudeTempDir()
  } catch {
    tempDirBase = tmpdir()
  }
  const tempDir = await mkdtemp(join(tempDirBase, 'math-verify-'))
  const scriptPath = join(tempDir, 'verify.py')

  try {
    await writeFile(scriptPath, `${RUNTIME_IMPORT_GUARD_PREFIX}\n${code}`, 'utf8')

    const subprocess = execa(pythonPath, ['-I', '-S', '-B', scriptPath], {
      cwd: tempDir,
      env: buildMinimalEnv(pythonPath),
      extendEnv: false,
      shell: false,
      timeout: timeoutMs,
      forceKillAfterDelay: 2_000,
      cancelSignal: opts.signal,
      maxBuffer: EXECA_MAX_BUFFER_BYTES,
      stdin: 'ignore',
      windowsHide: true,
      reject: false,
    })
    // Captured before awaiting — `pid` is a sync property of the subprocess
    // handle itself, not of the resolved result.
    const pid = subprocess.pid
    const result = await subprocess

    // Belt-and-braces: guarantee the process (and any child it may have
    // spawned despite the import denylist) is actually gone, matching this
    // codebase's own ShellCommand.ts convention for hard-killing on timeout.
    if (result.timedOut && pid) {
      treeKill(pid, 'SIGKILL')
    }

    return {
      executed: true,
      stdout: truncate(result.stdout ?? ''),
      stderr: truncate(result.stderr ?? ''),
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      snippetMeta,
    }
  } catch (error) {
    // execa with reject:false shouldn't normally throw, but a spawn-level
    // failure (e.g. the resolved interpreter path vanished between which()
    // and now) can still reject — treat identically to "not executed".
    return {
      executed: false,
      rejectionReason: `failed to launch Python: ${String(error)}`,
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * TEST-ONLY: runs `code` through executeGuardedScript directly, skipping
 * validatePythonSnippet entirely. Exists to let tests verify
 * RUNTIME_IMPORT_GUARD_PREFIX stops a dangerous import on its own, simulating
 * a future static-analysis blind spot (i.e. "what if Part 1's bans didn't
 * exist for this payload") — this is exactly the defense-in-depth claim this
 * file's header comment makes, and it's verified here rather than asserted.
 * Never used by the real runPythonSnippet() call path.
 */
export async function _runPythonSnippetBypassingStaticValidationForTests(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PythonExecResult> {
  return executeGuardedScript(code, opts, undefined)
}
