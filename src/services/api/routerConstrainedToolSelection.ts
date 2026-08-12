import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { sanitizeSchemaForOpenAICompat } from './openaiSchemaSanitizer.js'
import { convertMessages, type OpenAIMessage } from './openaiShim.js'
import { isLocalProviderUrl } from './providerConfig.js'
import type { AnthropicStreamEvent } from './codexShim.js'

/**
 * Grammar-constrained router tool selection — `LOCAL_AI_MASTER_PLAN.md` §6
 * lever G, corrected form ("session 14" correction — see that section for
 * the full evidence trail). Session 13's routing-eval measurement of lever
 * F (few-shot examples, `routerFewShot.ts`) alone landed at 75-85% across
 * three runs, below the ~90% gate — this module is what session 15 built
 * next, per the master plan's own "try G if F alone doesn't clear the gate"
 * sequencing.
 *
 * **The problem this solves.** Ollama's native `tools` decoding path
 * renders tool schemas into the prompt as template text and samples
 * *unconstrained* — confirmed directly against Ollama's own issue tracker
 * (maintainer comment on ollama/ollama#17597, 2026-08-08: "`tools` path: ...
 * Ollama does not currently construct a corresponding GBNF grammar from the
 * `tools` parameter array, leaving sampling unconstrained"). A hallucinated
 * tool name or malformed argument is therefore always *possible* on that
 * path, no matter how good the prompt is — this is exactly the routing
 * eval's remaining wrong-tool-hallucination failures. The *only* part of
 * Ollama's OpenAI-compatible endpoint that is genuinely GBNF-grammar-
 * enforced is `response_format` (confirmed both by the same maintainer
 * comment and empirically, live against this project's own
 * `qwen3-router:1.7b` tag — see the routing-eval session notes in
 * `LOCAL_AI_STATUS.md`).
 *
 * **The fix.** Don't use `tools` for the router's tool-*selection* decision
 * at all. Build one JSON Schema representing "which tool (a closed enum of
 * the tools actually registered this turn, or the literal string `"none"`)
 * with which schema-valid arguments", send it via `response_format`
 * *instead of* `tools`, and decode the resulting JSON back into a normal
 * `tool_use` content block (or a plain text final answer for `"none"`)
 * before it re-enters the existing tool-execution/permission pipeline
 * completely unchanged — the same allowlist-not-denylist principle as
 * `AskMathModelTool/deepSolve/restrictedEvaluator.ts` (§11): a hallucinated
 * tool name becomes literally inexpressible in the grammar, not merely
 * discouraged by a prompt.
 *
 * **Hard rule, verified against the source, not just asserted**: never send
 * `response_format` on the same request as `tools`. The "Constraint Tax"
 * study (arxiv 2606.25605) measured that combining a JSON-schema output
 * constraint with `tools` on one request drives tool invocation to 0% across
 * every model size (the schema FSM masks the `<tool_call>` opening token to
 * -∞) — independently reproduced against this exact local endpoint while
 * researching this module (a `tools`+`response_format` request against
 * `qwen3-router:1.7b` hung past a 40s timeout with no output, matching the
 * paper's mechanism). This module's request body never sets `tools`; the
 * caller (`openaiShim.ts`'s `create()`) only ever invokes this function
 * *instead of* the normal `tools`-based request for a given turn, never
 * alongside it.
 *
 * **Gated local-only** — `shouldApplyRouterConstrainedSelection()` is the
 * single gate every caller must check first, identical in shape to
 * `routerFewShot.ts`'s and `toolPreFilter.ts`'s own gate functions (same
 * `isLocalProviderUrl()`-based pattern this project uses for every other
 * local-only behavior). Every cloud-provider path and every non-local
 * OpenAI-compatible endpoint is completely unaffected — this module is
 * never imported or reachable from any code path those requests take.
 *
 * **Off by default, not just local-only** (added after live measurement —
 * see `LOCAL_AI_STATUS.md`'s session notes for the full numbers). Two
 * independent full 20-case routing-eval runs against this project's own
 * `qwen3-router:1.7b`, including one after fixing a real bug found along
 * the way (tool descriptions were missing from the request entirely —
 * `buildToolCatalogText()` below), both landed at 35% — a regression
 * against both the untouched baseline (70%) and lever F alone (75-85%
 * across three runs). Root cause, as best understood without further
 * investigation: bypassing Ollama's native `tools` machinery for
 * `response_format` also bypasses whatever fine-tuned "tool-awareness"
 * training the base model has for recognizing *when* to call a tool at
 * all — grammar constraints make an invalid tool *name* inexpressible, but
 * they don't restore that judgment. This is a real, if not fully diagnosed
 * to the last detail, negative result, not a wiring bug — see the session
 * notes for what was tried (including a promising but incomplete
 * think-enabled experiment that fixed one failing case at 3-4x latency
 * cost while introducing a new `<think>`-trace-leak needing its own fix,
 * not pursued further within this session's time budget). Requires
 * `OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION` to be truthy, on top of
 * every other conjunct, before this module is ever reached — the module
 * itself is fully built, tested, and wired, kept available for a future
 * session to pick up (e.g. against a larger/different router model, or
 * after the think-enabled variant is finished), not deleted.
 *
 * **Scope note, verified not assumed** (same investigation as
 * `routerFewShot.ts` — see that file's header comment for the full trace):
 * this module is only ever reached from `openaiShim.ts`'s `create()`,
 * before the normal `tools`-based request is built. It is not on the path
 * any local-AI specialist uses to talk to its own model — `AskMathModelTool`
 * and `deepSolve/generateCandidates.ts` fetch VibeThinker directly with
 * their own bare completion payload, never through this shim's
 * `beta.messages.create()`; `DocumentQATool`/`ImageCaptionTool`/
 * `DataAnalyzeTool` call the Python bridge over plain HTTP, not Ollama chat
 * completions at all. The `isToolCallRecoveryModel` exclusion below is
 * defense in depth on top of that, not the only thing preventing overlap —
 * if a tool-call-recovery-listed model (VibeThinker) were ever pointed at
 * directly as the main model, this module must not intercept its turn,
 * since that model's own reasoning-heavy completions are exactly what
 * `toolCallRecovery.ts` exists to handle differently.
 *
 * **Fails open at every stage**, same discipline as `toolPreFilter.ts`/
 * `embeddingPreFilter.ts`: a network error, a non-200 response, malformed
 * JSON, or an output that (despite the grammar guarantee) doesn't decode to
 * a valid decision all return `null` from `runRouterConstrainedToolSelection`
 * rather than throwing — the caller falls back to the normal `tools`-based
 * request (where lever F's few-shot addendum may then apply) exactly as if
 * this module didn't exist. The one real cost of a fallback is one extra
 * HTTP round trip, never a broken or worse-than-baseline result.
 */

/** The JSON value the model emits when it decides no tool is needed. */
const NO_TOOL_SENTINEL = 'none'

/** Matches `openaiShim.ts`'s own local-only request timeout philosophy — generous relative to this project's own observed 8-31s router latencies (see LOCAL_AI_STATUS.md's routing-eval session notes), but bounded so a stuck local server falls back instead of hanging the turn indefinitely. */
const ROUTER_CONSTRAINED_TIMEOUT_MS = 60_000

export interface RouterToolDefinition {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

/**
 * Whether the grammar-constrained tool-selection path should be used for
 * this request, instead of the normal `tools`-based one. The one gate every
 * caller must check first — the first three conjuncts mirror
 * `routerFewShot.ts`'s `shouldApplyRouterFewShot()` exactly (same
 * rationale, since both target the identical "router's own top-level
 * tool-selection turn" scope). `enabled` is the additional, explicit
 * opt-in this module requires on top of that scope — see this module's own
 * header comment ("Off by default, not just local-only") for why: live
 * routing-eval measurement found this regresses accuracy versus both the
 * untouched baseline and lever F alone, so it must not silently become the
 * new default behavior for the local `ollama` profile just by being built.
 * Callers should compute `enabled` via
 * `isEnvTruthy(process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION)`.
 * When this returns true, the caller should attempt
 * `runRouterConstrainedToolSelection()` first and only fall back to the
 * normal path if it returns `null`.
 */
export function shouldApplyRouterConstrainedSelection(
  baseUrl: string | undefined,
  isToolCallRecoveryModel: boolean,
  hasTools: boolean,
  enabled: boolean,
): boolean {
  return enabled && hasTools && isLocalProviderUrl(baseUrl) && !isToolCallRecoveryModel
}

/**
 * Builds the closed-enum discriminated-union JSON Schema: one branch per
 * registered tool (`{tool: <const tool name>, arguments: <that tool's own
 * sanitized input_schema>}`), plus one `"none"` branch (`{tool: "none",
 * answer: <string>}`) for "no tool needed". A tool name outside this exact
 * set is not merely discouraged — the grammar has no branch that can
 * produce it, so it is inexpressible.
 *
 * Pure and side-effect-free (no network) — exported so encode-direction
 * behavior can be tested directly without mocking HTTP.
 */
export function buildToolDecisionSchema(
  tools: readonly RouterToolDefinition[],
): Record<string, unknown> {
  const toolVariants = tools
    .filter(t => typeof t.name === 'string' && t.name.length > 0)
    .map(t => ({
      type: 'object',
      properties: {
        tool: { const: t.name },
        arguments: sanitizeSchemaForOpenAICompat(
          t.input_schema ?? { type: 'object', properties: {} },
        ),
      },
      required: ['tool', 'arguments'],
      additionalProperties: false,
    }))

  const noneVariant = {
    type: 'object',
    properties: {
      tool: { const: NO_TOOL_SENTINEL },
      answer: {
        type: 'string',
        description: 'The final reply to show the user directly, since no tool is needed for this request.',
      },
    },
    required: ['tool', 'answer'],
    additionalProperties: false,
  }

  return { oneOf: [...toolVariants, noneVariant] }
}

export type DecodedToolDecision =
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'none'; answer: string }
  | { kind: 'invalid'; reason: string }

/**
 * Parses and validates the model's raw JSON response text against the
 * decision it's supposed to represent. Defends the decode direction even
 * though the grammar should already guarantee schema-valid output —
 * "should" is not "must": this handles malformed JSON, a non-object
 * response, a tool name that (despite the grammar guarantee) isn't
 * actually in `registeredToolNames`, and missing/malformed `arguments`,
 * all as `{kind: 'invalid'}` rather than throwing or trusting blindly.
 *
 * Pure and side-effect-free — exported so decode-direction behavior can be
 * tested directly without mocking HTTP.
 */
export function decodeToolDecision(
  rawContent: string,
  registeredToolNames: ReadonlySet<string>,
): DecodedToolDecision {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { kind: 'invalid', reason: 'response was not valid JSON' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'response was not a JSON object' }
  }

  const obj = parsed as Record<string, unknown>
  const tool = obj.tool

  if (typeof tool !== 'string' || tool.length === 0) {
    return { kind: 'invalid', reason: 'missing or non-string "tool" field' }
  }

  if (tool === NO_TOOL_SENTINEL) {
    const answer = typeof obj.answer === 'string' ? obj.answer : ''
    return { kind: 'none', answer }
  }

  // Defense in depth — the grammar's oneOf/const should make any other
  // value inexpressible, but this must never be trusted blindly (see this
  // module's own header comment).
  if (!registeredToolNames.has(tool)) {
    return { kind: 'invalid', reason: `"${tool}" is not a registered tool name` }
  }

  const args = obj.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      kind: 'invalid',
      reason: `missing or non-object "arguments" for tool "${tool}"`,
    }
  }

  return { kind: 'tool', name: tool, input: args as Record<string, unknown> }
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

/**
 * The three illustrative examples also used by `routerFewShot.ts`
 * (LOCAL_AI_MASTER_PLAN.md §6 lever F), reshaped into this module's own
 * `{tool, arguments}` / `{tool: "none", answer}` JSON decision format
 * rather than OpenAI `tool_calls` — G replaces the `tools`-based request
 * entirely for a turn it handles, so F's own tool_calls-shaped few-shot
 * messages (built for the `tools` wire format) don't apply here; grammar
 * constraints alone make hallucinated tool *names* inexpressible but don't
 * by themselves make the model pick "none" correctly for a trivial
 * prompt — that's a semantic judgment, not a grammar one, so the same
 * few-shot signal is still worth including in this module's own shape.
 * Each example is only included when its referenced tool is actually
 * registered this turn (defensive — a stale reference to a tool that isn't
 * in the current turn's oneOf would be confusing conversation history, even
 * though it's not re-validated against the current grammar).
 */
function buildDecisionFewShotMessages(
  registeredToolNames: ReadonlySet<string>,
): OpenAIMessage[] {
  const examples: OpenAIMessage[] = []

  if (registeredToolNames.has('DataAnalyze')) {
    examples.push(
      {
        role: 'user',
        content:
          'Here is a small table:\nName, Score\nAlice, 92\nBob, 77\nCarol, 85\nQuestion: Who has the highest score?',
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          tool: 'DataAnalyze',
          arguments: {
            operation: 'question',
            table: {
              columns: ['Name', 'Score'],
              rows: [
                ['Alice', '92'],
                ['Bob', '77'],
                ['Carol', '85'],
              ],
            },
            question: 'Who has the highest score?',
          },
        }),
      },
    )
  }

  if (registeredToolNames.has('AskMathModel')) {
    examples.push(
      { role: 'user', content: 'What is 734 x 851?' },
      {
        role: 'assistant',
        content: JSON.stringify({
          tool: 'AskMathModel',
          arguments: { problem: '734 x 851' },
        }),
      },
    )
  }

  // Always safe — references no specific tool name, and is the example
  // that most directly targets the over-delegation failure mode (placed
  // last, closest to the real conversation, for the same in-context
  // recency-bias reasoning as routerFewShot.ts).
  examples.push(
    { role: 'user', content: 'What is 12 * 7?' },
    {
      role: 'assistant',
      content: JSON.stringify({ tool: NO_TOOL_SENTINEL, answer: '12 * 7 = 84.' }),
    },
  )

  return examples
}

function insertDecisionFewShotMessages(
  messages: OpenAIMessage[],
  registeredToolNames: ReadonlySet<string>,
): OpenAIMessage[] {
  const fewShot = buildDecisionFewShotMessages(registeredToolNames)
  const insertAt = messages.length > 0 && messages[0]?.role === 'system' ? 1 : 0
  return [...messages.slice(0, insertAt), ...fewShot, ...messages.slice(insertAt)]
}

/**
 * Builds a plain-text "what does each tool do" catalog from each tool's own
 * `description` — necessary, not cosmetic. Native `tools`-based calling
 * gets a model's fine-tuned tool-awareness "for free": Ollama's chat
 * template renders each tool's name AND description into the prompt in a
 * format the model was specifically trained to recognize as "here is a
 * capability you can invoke." This module's schema
 * (`buildToolDecisionSchema`) only conveys tool *names* and *argument
 * shapes* — deliberately, since JSON Schema has no natural place for
 * free-text tool-selection guidance — so without this, the model has
 * literally no semantic information about what "ImageCaption" or
 * "DataAnalyze" even mean, only their argument shapes. Confirmed by direct
 * live testing during this module's development: omitting this produced a
 * router that fabricated a plausible-sounding but entirely made-up "none"
 * answer for an unambiguous image-captioning request instead of delegating
 * to `ImageCaption`, and over-attracted to `DataAnalyze` for
 * passage-and-question prompts that should have gone to `DocumentQA` — both
 * resolved once each tool's real description was surfaced here.
 */
function buildToolCatalogText(tools: readonly RouterToolDefinition[]): string {
  const lines = tools
    .filter(t => typeof t.name === 'string' && t.name.length > 0)
    .map(t => `- ${t.name}: ${t.description?.trim() || '(no description provided)'}`)
  if (lines.length === 0) return ''
  return [
    'Available tools for the "tool" field (pick the single best match, or "none" if no tool is needed):',
    ...lines,
  ].join('\n')
}

/**
 * Appends the tool catalog to the existing system message's content (or
 * inserts a new system message if there wasn't one) — kept as a single
 * system message rather than two, since not every chat template handles
 * multiple system-role messages predictably.
 */
function appendToolCatalogToSystemMessage(
  messages: OpenAIMessage[],
  catalogText: string,
): OpenAIMessage[] {
  if (!catalogText) return messages
  if (messages.length > 0 && messages[0]?.role === 'system') {
    const existing = messages[0]
    const existingText = typeof existing.content === 'string' ? existing.content : ''
    return [
      { ...existing, content: `${existingText}\n\n${catalogText}` },
      ...messages.slice(1),
    ]
  }
  return [{ role: 'system', content: catalogText }, ...messages]
}

function buildDecisionMessage(
  decision: Extract<DecodedToolDecision, { kind: 'tool' | 'none' }>,
  data: {
    id?: string
    model?: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  },
  fallbackModel: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  let stopReason: string

  if (decision.kind === 'tool') {
    content.push({
      type: 'tool_use',
      id: makeId('constrained_call'),
      name: decision.name,
      input: decision.input,
    })
    stopReason = 'tool_use'
  } else {
    if (decision.answer) {
      content.push({ type: 'text', text: decision.answer })
    }
    stopReason = 'end_turn'
  }

  return {
    id: data.id ?? makeId('msg'),
    type: 'message',
    role: 'assistant',
    content,
    model: data.model ?? fallbackModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  }
}

/**
 * Converts an already-fully-known Anthropic-shaped message (as built by
 * `buildDecisionMessage()` above, or any message of the same shape) into
 * the same `AnthropicStreamEvent` sequence `openaiShim.ts`'s own
 * `openaiStreamToAnthropic()` produces for a real streamed response
 * (`message_start` → `content_block_start`/`content_block_delta`/
 * `content_block_stop` per block → `message_delta` → `message_stop`) —
 * this module never reuses or modifies that function; it's a separate,
 * much simpler generator specific to this module's always-already-complete
 * (never partial) result, since the underlying HTTP call this module makes
 * is always non-streaming (see `runRouterConstrainedToolSelection`'s own
 * comment for why). A single `content_block_delta` per block carrying the
 * *complete* text/JSON is a legitimate degenerate case of streaming — the
 * real streaming path already produces exactly this shape whenever a tool
 * call's entire arguments arrive in one SSE chunk.
 *
 * Exported so this direction can be tested directly against hand-built
 * message fixtures, without mocking HTTP or streaming at all.
 */
export async function* messageToStreamEvents(
  message: Record<string, unknown>,
): AsyncGenerator<AnthropicStreamEvent> {
  const content = (message.content ?? []) as Array<Record<string, unknown>>

  yield {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null },
  }

  let index = 0
  for (const block of content) {
    if (block.type === 'text') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: (block.text as string) ?? '' },
      }
      yield { type: 'content_block_stop', index }
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      }
      yield {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      }
      yield { type: 'content_block_stop', index }
    }
    index++
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: message.usage as AnthropicStreamEvent['usage'],
  }
  yield { type: 'message_stop' }
}

export interface RouterConstrainedSelectionOptions {
  baseUrl: string
  resolvedModel: string
  messages: Array<{
    role: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>
  system: unknown
  tools: readonly RouterToolDefinition[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  apiKey?: string
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
}

/**
 * Runs the grammar-constrained tool-selection request against a local
 * OpenAI-compatible endpoint (Ollama's `/v1/chat/completions`) and, on
 * success, returns the decoded result as a plain Anthropic-shaped message
 * object. Returns `null` on any failure — see this module's own header
 * comment for the full fail-open discipline and why.
 *
 * Deliberately always sends `stream: false` to the local endpoint,
 * regardless of what the *original* caller wanted, for two independent
 * reasons verified before choosing this shape: (1) Ollama's SSE deltas for
 * a `response_format`-constrained completion stream plain `delta.content`
 * text chunks, not `delta.tool_calls` — reusing this file's real streaming
 * parser (`openaiShim.ts`'s `openaiStreamToAnthropic`) would surface the
 * raw JSON decision text to the user as if it were a spoken reply, and
 * nothing downstream would recognize it as a tool call; teaching that
 * parser to special-case this module's own schema would mean modifying the
 * single most sensitive, most-relied-on code path in this file, which is
 * exactly the risk this task was warned to avoid taking on unnecessarily.
 * (2) it produces the *complete* decision in one shot, which is what this
 * module's decode step needs anyway (a schema-valid decision is a fully
 * assembled JSON object, not something safely interpretable half-formed).
 * The caller (`openaiShim.ts`'s `create()`) decides whether to hand its own
 * caller a synthetic stream (`messageToStreamEvents()`) or the plain
 * message object directly, based on what *that* caller actually asked for
 * — this function's own HTTP behavior is independent of that.
 */
export async function runRouterConstrainedToolSelection(
  opts: RouterConstrainedSelectionOptions,
): Promise<{ message: Record<string, unknown> } | null> {
  try {
    if (opts.tools.length === 0) return null

    const registeredToolNames = new Set(opts.tools.map(t => t.name))
    const schema = buildToolDecisionSchema(opts.tools)

    const baseMessages = appendToolCatalogToSystemMessage(
      convertMessages(opts.messages, opts.system),
      buildToolCatalogText(opts.tools),
    )
    const messages = insertDecisionFewShotMessages(baseMessages, registeredToolNames)

    const body: Record<string, unknown> = {
      model: opts.resolvedModel,
      messages,
      stream: false,
      // Same rationale as openaiShim.ts's own local-only think/reasoning_effort
      // handling: a tool-selection decision doesn't need deep reasoning, and
      // Ollama's OpenAI-compat endpoint only honors reasoning_effort (think is
      // silently ignored there — see openaiShim.ts's own comment for the two
      // linked Ollama issues this was confirmed against).
      think: false,
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'router_tool_decision', schema },
      },
    }

    if (typeof opts.max_tokens === 'number' && opts.max_tokens > 0) {
      body.max_completion_tokens = opts.max_tokens
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.top_p !== undefined) body.top_p = opts.top_p

    const { signal, cleanup } = createCombinedAbortSignal(opts.signal, {
      timeoutMs: ROUTER_CONSTRAINED_TIMEOUT_MS,
    })

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(opts.extraHeaders ?? {}),
      }
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

      const response = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })

      if (!response.ok) {
        logForDebugging(
          `[routerConstrainedToolSelection] request failed with HTTP ${response.status} — falling back to normal tool-calling`,
        )
        return null
      }

      const data = (await response.json()) as {
        id?: string
        model?: string
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
      }

      const rawContent = data.choices?.[0]?.message?.content
      if (typeof rawContent !== 'string' || !rawContent) {
        logForDebugging(
          '[routerConstrainedToolSelection] empty response content — falling back to normal tool-calling',
        )
        return null
      }

      const decision = decodeToolDecision(rawContent, registeredToolNames)
      if (decision.kind === 'invalid') {
        logForDebugging(
          `[routerConstrainedToolSelection] ${decision.reason} — falling back to normal tool-calling`,
        )
        return null
      }

      return { message: buildDecisionMessage(decision, data, opts.resolvedModel) }
    } finally {
      cleanup()
    }
  } catch (e) {
    logForDebugging(
      `[routerConstrainedToolSelection] request threw, falling back to normal tool-calling: ${errorMessage(e)}`,
    )
    return null
  }
}
