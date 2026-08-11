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
 * are typically faster but not reliably so). 10 minutes matches the sane
 * outer ceiling used elsewhere in this codebase for slow non-streaming
 * requests (see getNonstreamingFallbackTimeoutMs in services/api/claude.ts,
 * which notes the API's own 10-minute non-streaming boundary).
 */
export const MATH_MODEL_TIMEOUT_MS = 600_000

/**
 * Generous ceiling so a long think-trace doesn't get cut off before the
 * model reaches its final answer (observed 3900+ tokens of reasoning alone
 * in earlier manual testing of this same model).
 */
export const MATH_MODEL_MAX_TOKENS = 8192
