export const ASK_MATH_MODEL_TOOL_NAME = 'AskMathModel'

/**
 * Local Ollama endpoint + model used for math delegation. Overridable via env
 * for anyone running Ollama on a different host/port or swapping the
 * specialist model, without touching code.
 */
export const MATH_MODEL_BASE_URL =
  process.env.MATH_MODEL_BASE_URL ?? 'http://127.0.0.1:11434/v1'
export const MATH_MODEL_NAME =
  process.env.MATH_MODEL_NAME ?? 'hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M'

/**
 * VibeThinker's visible <think> reasoning trace runs long (observed 195s-300s+
 * for tool-shaped prompts in this project's own testing; plain math questions
 * are typically faster but not reliably so). This was originally set to
 * 600_000 (10 minutes) to match the sane outer ceiling used elsewhere in this
 * codebase for slow non-streaming requests (see
 * getNonstreamingFallbackTimeoutMs in services/api/claude.ts) — but that
 * value is UNREACHABLE in practice for this specific call: session 29 found,
 * via a live diagnostic (a hard-timing-out DeepSolve candidate on a genuinely
 * slow problem), that Bun hardcodes fetch() to a ~300s internal timeout that
 * fires below the AbortSignal layer entirely — confirmed against Bun's own
 * tracked issues (oven-sh/bun#16682, #13302). `createCombinedAbortSignal`
 * (used at every call site of this constant) fixes a *different* problem
 * (native-memory accumulation from `AbortSignal.timeout`'s lazy
 * finalization) and does not and cannot override Bun's own internal ceiling
 * — the two are unrelated bugs that happen to share a "fetch timeout"
 * description. Set below that real ceiling (not at the old 600s) so THIS
 * codebase's own timeout fires first, predictably, with the clean
 * AbortError/`truncated` handling this pipeline already has — instead of an
 * opaque `TimeoutError` racing an undocumented runtime limit. Single-shot
 * hard cases were live-verified completing in 221-228s, comfortably under
 * this value.
 */
export const MATH_MODEL_TIMEOUT_MS = 280_000

/**
 * Generous ceiling so a long think-trace doesn't get cut off before the
 * model reaches its final answer (observed 3900+ tokens of reasoning alone
 * in earlier manual testing of this same model).
 */
export const MATH_MODEL_MAX_TOKENS = 8192
