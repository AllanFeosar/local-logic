/**
 * Recovers tool-call intent from models that understand *what* tool to call
 * and produce a well-formed JSON payload, but don't reliably follow the
 * `<tool_call>` protocol tag their own chat template specifies — so the
 * inference engine never populates the native `tool_calls` field and the
 * intent would otherwise be lost as inert text.
 *
 * Empirically verified failure mode (VibeThinker-3B via Ollama): given a
 * tool definition and a prompt that clearly needs it, the model reasoned
 * correctly, decided to call the right tool with the right arguments, and
 * emitted `{"name": "get_stock_price", "arguments": {"symbol": "AAPL"}}` —
 * but wrapped it in a self-invented `<advice>` tag instead of the
 * `<tool_call>` tag its own system prompt specified, after visibly
 * confusing itself about which tag to use. Ollama's parser looks
 * specifically for `<tool_call>`, so `tool_calls` came back empty despite
 * the model's reasoning being entirely correct.
 *
 * This does not replace native tool-calling — it only activates when the
 * native `tool_calls` field is empty, and only recognizes calls to tools
 * that were actually offered in this request. It will not match arbitrary
 * JSON the model outputs while discussing an example — the `name` field
 * must exactly match an available tool.
 */

export interface RecoveredToolCall {
  name: string
  arguments: unknown
}

/**
 * Scan `text` for JSON objects shaped like `{"name": string, "arguments":
 * object}` where `name` matches one of `availableToolNames`. Returns the
 * LAST such match (the model's final decision, after any "thinking out
 * loud" that may also mention tool names/JSON earlier in the text) — a
 * generic bracket-depth scan is used rather than a fixed-tag regex,
 * since the whole point is that the wrapping tag is unreliable.
 */
export function recoverToolCallFromText(
  text: string,
  availableToolNames: readonly string[],
): RecoveredToolCall | null {
  if (!text || availableToolNames.length === 0) return null

  const toolNameSet = new Set(availableToolNames)
  const candidates = findJsonObjects(text)

  let lastMatch: RecoveredToolCall | null = null
  for (const candidate of candidates) {
    const parsed = tryParseToolCall(candidate, toolNameSet)
    if (parsed) lastMatch = parsed
  }
  return lastMatch
}

function tryParseToolCall(
  jsonText: string,
  toolNameSet: ReadonlySet<string>,
): RecoveredToolCall | null {
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const obj = value as Record<string, unknown>
  if (typeof obj.name !== 'string' || !toolNameSet.has(obj.name)) return null
  if (!('arguments' in obj)) return null

  return { name: obj.name, arguments: obj.arguments }
}

/**
 * Find every substring of `text` that is a syntactically complete JSON
 * object (balanced braces, respecting strings/escapes so braces inside
 * string values don't throw off the depth count). Returns them in the
 * order they appear; outer objects are returned rather than objects
 * nested inside them (a nested candidate can't itself satisfy the
 * top-level `name`/`arguments` shape we're looking for here).
 */
function findJsonObjects(text: string): string[] {
  const results: string[] = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue

    const end = findMatchingBrace(text, i)
    if (end === -1) continue

    results.push(text.slice(i, end + 1))
    i = end // skip past this object; don't re-scan its interior as a new start
  }

  return results
}

/** Returns the index of the `}` matching the `{` at `startIndex`, or -1. */
function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
