export const DESCRIPTION = `Delegates a math problem to a local specialist reasoning model (VibeThinker-3B) that is substantially stronger at step-by-step mathematical reasoning than the main conversational model.

When to use:
- Multi-step algebra, calculus, word problems, proofs, or competition-style problems.
- Anything where a careless arithmetic slip would matter and deserves a dedicated, careful pass.
- Any multiplication, division, or exponentiation where either operand has 3 or more digits (e.g. "847 x 293", "8473 x 2957"). You are NOT a reliable calculator at this size — you will often produce a confident-looking wrong answer or, on harder cases, garbled reasoning that doesn't even attempt the right operation. Delegate rather than trust your own arithmetic here, every time, no exceptions for "this one looks easy."

When NOT to use:
- Genuinely trivial arithmetic: both operands 2 digits or fewer (e.g. "12*7", "15% of 80", "9+16"). Delegating these wastes several minutes for no benefit.
- Anything that isn't actually math (this model is not a general assistant and was not evaluated for other tasks).

Timing: the specialist model reasons visibly before answering and this routinely takes 1-5 minutes. That is expected, not a hang — do not retry or assume failure just because it's slow.

Output: only the specialist's final answer is returned; its internal reasoning trace is stripped before being handed back to you. Treat the returned answer as authoritative and quote/use it directly rather than re-deriving the result yourself — re-deriving risks introducing a transcription error on top of an already-correct answer. If the result looks incomplete or is flagged as truncated, say so rather than guessing at what was cut off.`

export const PROMPT = DESCRIPTION
