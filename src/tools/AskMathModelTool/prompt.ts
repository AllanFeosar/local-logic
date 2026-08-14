export const DESCRIPTION = `Delegates a math problem to a local specialist reasoning model (VibeThinker-3B) that is substantially stronger at step-by-step mathematical reasoning than the main conversational model.

When to use:
- Multi-step algebra, calculus, word problems, proofs, or competition-style problems.
- Anything where a careless arithmetic slip would matter and deserves a dedicated, careful pass.
- Any multiplication, division, or exponentiation where either operand has 3 or more digits (e.g. "847 x 293", "8473 x 2957"). You are NOT a reliable calculator at this size — you will often produce a confident-looking wrong answer or, on harder cases, garbled reasoning that doesn't even attempt the right operation. Delegate rather than trust your own arithmetic here, every time, no exceptions for "this one looks easy."

When NOT to use:
- Genuinely trivial arithmetic: apply this as a STRUCTURAL test on the operand sizes, not by matching one example's exact wording — both operands 2 digits or fewer (0-99), REGARDLESS of which operation (+, -, *, /, %) or how it's phrased (symbols like "+"/"-", or words like "plus"/"minus"/"times"/"divided by"). "12*7", "15% of 80", "9+16", "45-22", "30% of 50", and "7 plus 8" are ALL the same case: trivial, do not delegate. Delegating these wastes several minutes for no benefit.
- Anything that isn't actually math (this model is not a general assistant and was not evaluated for other tasks).

One narrow disambiguation, not a reason to delegate more broadly (the trivial-arithmetic exception above still applies exactly as stated): apply this as a STRUCTURAL test, not by matching against any one example's wording — a prose sentence naming 2-4 quantities tied to short labels (days, drives, cities, products, people; with or without $ signs, %, or commas — the surface formatting never changes the answer) and asking for their sum/difference/total is this tool, not DataAnalyze, no matter what the labels or numbers are. The only question that matters: were you handed an actual multi-row/column table, or are the numbers just embedded in one or two sentences? Only the former is DataAnalyze.

Timing: the specialist model reasons visibly before answering and this routinely takes 1-5 minutes. That is expected, not a hang — do not retry or assume failure just because it's slow.

Output: only the specialist's final answer is returned; its internal reasoning trace is stripped before being handed back to you. Treat the returned answer as authoritative and quote/use it directly rather than re-deriving the result yourself — re-deriving risks introducing a transcription error on top of an already-correct answer. If the result looks incomplete or is flagged as truncated, say so rather than guessing at what was cut off.

Optional deep mode (set deep: true) — default false, leave unset almost always:
- What it does: generates several candidate solutions instead of one, and for each candidate actually EVALUATES a locally-generated arithmetic/logic check (a restricted numeric expression — comparisons and a small set of math functions, not general code) against it — not just asks the model about it — and only falls back to a learned re-ranking model when that check alone cannot settle it. If every candidate fails, it retries exactly once with the failure fed back in.
- When to use: a genuinely hard, easy-to-get-subtly-wrong problem (competition-style, multi-step algebra/combinatorics/number theory, a proof with a numeric or symbolic final answer) where correctness matters more than speed, and only after you've judged that a single normal call is a real risk of being wrong — not for anything you'd otherwise send through this tool's default mode.
- When NOT to use: everything covered by "When to use" above without deep mode — that is the overwhelming majority of calls. Also not for anything that isn't a checkable computation (the restricted check can't verify open-ended proof-writing style or judgment calls, and can't verify a claim that genuinely needs a loop or simulation to check — only a direct numeric/symbolic/logical recomputation).
- Timing: roughly N x 1-5 minutes (N is a small fixed number of candidates), and it can run past 30 minutes total if the first round of candidates all fail and it retries. This is dramatically slower than the default mode — treat it as a deliberate, expensive escalation, never a default, and warn the user up front that it will take a while.
- Output: the response includes whether the answer was code-verified (proven correct by actually running a check) or only a best-effort pick when nothing could be proven — read that signal and represent the answer's confidence accordingly rather than presenting every deep-mode answer as equally certain.`

export const PROMPT = DESCRIPTION
