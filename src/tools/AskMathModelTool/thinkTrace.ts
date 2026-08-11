/**
 * Strips a leading `<think>...</think>` reasoning trace from a reasoning
 * model's raw completion, returning just the final answer. Handles the
 * common variants: a clean trace followed by prose, no trace at all, and a
 * truncated/never-closed trace (generation hit max_tokens mid-thought) —
 * the last case is reported via `truncated: true` rather than silently
 * discarded, since returning an empty answer would be worse than returning
 * the raw (unfinished) reasoning with a warning attached.
 */
export interface StrippedAnswer {
  answer: string
  truncated: boolean
}

const THINK_CLOSE_TAG = '</think>'

export function stripThinkTrace(rawText: string): StrippedAnswer {
  const text = rawText ?? ''
  const closeIdx = text.indexOf(THINK_CLOSE_TAG)

  if (closeIdx === -1) {
    // No closing tag found at all: either the model never used <think>
    // (unlikely for this model, but don't assume), or generation was cut
    // off mid-thought. Either way there's no reliable "answer" substring to
    // extract, so return the raw text and flag it.
    return { answer: text.trim(), truncated: text.length > 0 }
  }

  const after = text.slice(closeIdx + THINK_CLOSE_TAG.length).trim()
  if (after.length === 0) {
    // Trace closed cleanly but nothing follows — the model ran out of
    // budget right at the boundary. Fall back to the trace itself rather
    // than returning empty, so there's still something to inspect.
    return { answer: text.trim(), truncated: true }
  }

  return { answer: after, truncated: false }
}
