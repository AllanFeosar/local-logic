import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  buildDecisionMessage,
  messageToStreamEvents,
  type DecodedToolDecision,
} from './routerConstrainedToolSelection.js'
import {
  insertRouterFewShotMessages,
  shouldApplyRouterFewShot,
} from './routerFewShot.js'
import { convertMessages, convertTools, type OpenAIMessage, type OpenAITool } from './openaiShim.js'
import { isLocalProviderUrl } from './providerConfig.js'

/**
 * Self-consistency majority-vote routing — `LOCAL_AI_MASTER_PLAN.md` §6
 * lever H, added session 17 (research-driven reframe after lever F landed a
 * real but insufficient gain and lever G regressed and shipped off). Full
 * evidence trail lives in that section; summary of what this module targets:
 *
 * **The problem this solves is variance, not bias.** The routing eval's own
 * numbers (best single run 85%, average ~79% on the original 20-case set)
 * are a *variance* signature — at 20 cases each result is worth 5 points, so
 * the score swings 1-2 cases run-to-run purely on sampling temperature. This
 * project's own live investigation reproduced that directly: the same
 * `routing-math-3` prompt, re-run through the real production request twice
 * in immediate succession, returned two different wrong-tool decisions
 * (`Grep` referencing this repo's own eval-tooling paths in one run,
 * `DataAnalyze` on a fabricated 2-row table in another) — genuine sampling
 * noise on the *same* input, not a deterministic capability wall. Standard
 * self-consistency (majority vote over N samples) is the textbook fix for
 * exactly this symptom: it reduces variance, not bias, so it pulls the
 * *average* run up toward the *best* run, it does not raise the ceiling
 * above the model's best already-observed behavior. See the sources cited
 * in the master plan (self-consistency variance reduction writeups,
 * arxiv 2509.19489) for the general result this module implements.
 *
 * **Mechanism.** Fire the router's normal tools-based chat-completion
 * request N times (default 5) at a fixed sampling temperature (default 0.6,
 * inside the master plan's recommended 0.5-0.7 band), decode each response
 * into a `(tool, roughly-similar-arguments)` candidate via
 * `tallyVotes()`/`canonicalizeVoteKey()` below, and return the plurality
 * winner reconstructed as a normal Anthropic `tool_use` (or plain-text
 * `end_turn`) message — the same "decode into a message and hand it back
 * unchanged to the existing tool-execution/permission pipeline" shape as
 * lever G, reusing G's own `buildDecisionMessage()`/`messageToStreamEvents()`
 * rather than reimplementing them (this module's own decision shape,
 * `DecodedToolDecision`, is literally G's exported type — see
 * `routerConstrainedToolSelection.ts`). Confidence-weighted early stopping
 * (`hasUnbeatableLead()`) stops sampling the moment the current leader's
 * vote lead is mathematically unbeatable by whatever samples remain (e.g.
 * 3-of-5 already agreeing means the other 2 samples can't change the
 * outcome) — this is what bounds the N x latency cost the plan calls out.
 *
 * **Per-request temperature override, confirmed live before building this**
 * (matching how session 11 confirmed Ollama honors per-request `temperature`
 * for VibeThinker before DeepSolve's best-of-N was built) — this module's
 * own investigation ran the SAME prompt against `qwen3-router:1.7b` at
 * `temperature: 0.0` three times (identical output every time: "732") and
 * at `temperature: 1.2` four times (varied output: "732, 573, 573, 732") —
 * confirming Ollama's OpenAI-compat endpoint genuinely honors a per-request
 * `temperature` override for this exact router model/tag, unlike `num_ctx`
 * and the native `think` field on this same endpoint (both previously found
 * silently ignored — see `LOCAL_AI_STATUS.md` Session 5 / this file's own
 * sibling modules' comments).
 *
 * **Same wire shape as the normal single-shot request, unlike lever G.**
 * Where G *replaces* the `tools`-based request with a `response_format`
 * one (deliberately, to get real grammar constraints — see that module's
 * header comment), H keeps using the native `tools` path exactly as the
 * normal single-shot request would, just resampled N times at a sampling
 * temperature. This also means H's messages include lever F's few-shot
 * addendum (`routerFewShot.ts`) exactly as the normal path would — H is
 * additive on top of F, not a replacement for it, matching the master
 * plan's own "F+H" combined-configuration framing for Phase 4's
 * measurement. `convertTools()`/`convertMessages()` are the exact same
 * exported helpers `openaiShim.ts`'s own normal request path uses — this
 * module's requests are faithful resamples of the real request, not a
 * parallel reimplementation that could silently drift out of sync with it.
 *
 * **Gated local-only** — `shouldApplyRouterSelfConsistency()` is the single
 * gate every caller must check first, identical in shape (and identical in
 * its first three conjuncts) to `shouldApplyRouterFewShot()` and
 * `shouldApplyRouterConstrainedSelection()`: the same `isLocalProviderUrl()`
 * -based pattern this project uses for every other local-only behavior.
 * `enabled` is this module's own explicit opt-in conjunct — see
 * `LOCAL_AI_STATUS.md`'s session notes for whether/how this ships on by
 * default after Phase 4's measurement (the master plan's own "measure
 * before defaulting on" discipline, same as lever G).
 *
 * **Fails open at every stage**, identical discipline to `routerFewShot.ts`/
 * `routerConstrainedToolSelection.ts`: a network error, a non-200 response,
 * malformed JSON, an empty completion, or a winning decision that (despite
 * having been checked at decode time) doesn't name a registered tool all
 * fail that *one sample* without throwing; if literally every sample fails
 * this way, `runRouterSelfConsistency()` returns `null` and the caller falls
 * back to the unchanged normal single-shot path exactly as if this module
 * didn't exist. The one real cost of a fallback is the HTTP round trips
 * already spent on failed samples, never a broken or worse-than-baseline
 * result.
 *
 * **Scope note, verified not assumed** (same investigation as
 * `routerFewShot.ts`/`routerConstrainedToolSelection.ts` — see either
 * file's header comment for the full trace): this module is only ever
 * reached from `openaiShim.ts`'s `create()`, before the normal tools-based
 * request is built. It is not on the path any local-AI specialist uses to
 * talk to its own model.
 */

/** Self-consistency literature samples repeatedly at one fixed, moderate temperature (not a varied schedule like DeepSolve's best-of-N) — this is deliberately different from `deepSolve/generateCandidates.ts`'s temperature-varied schedule, which targets solution *diversity* for a generation task, not decision *stability* for a classification-shaped one. */
const DEFAULT_SAMPLE_COUNT = 5
const DEFAULT_TEMPERATURE = 0.6
/** Matches `routerConstrainedToolSelection.ts`'s own per-request timeout philosophy — generous relative to this project's observed 8-31s router latencies, bounded so one stuck sample can't hang the whole voting round indefinitely (a stuck sample still fails open, same as any other per-sample failure). */
const ROUTER_SELF_CONSISTENCY_SAMPLE_TIMEOUT_MS = 60_000

export type VotableDecision = Extract<DecodedToolDecision, { kind: 'tool' | 'none' }>

/**
 * Whether self-consistency majority-vote routing should be used for this
 * request, instead of (or, when it fails open, immediately before falling
 * back to) the normal single-shot `tools`-based one. Mirrors
 * `shouldApplyRouterConstrainedSelection()`'s shape exactly — see that
 * function's own doc comment for why each of the first three conjuncts
 * matters; `enabled` is this module's own additional opt-in conjunct.
 * Callers should compute `enabled` via
 * `isEnvTruthy(process.env.OPENCLAUDE_ENABLE_ROUTER_SELF_CONSISTENCY)`.
 */
export function shouldApplyRouterSelfConsistency(
  baseUrl: string | undefined,
  isToolCallRecoveryModel: boolean,
  hasTools: boolean,
  enabled: boolean,
): boolean {
  return enabled && hasTools && isLocalProviderUrl(baseUrl) && !isToolCallRecoveryModel
}

/**
 * Recursively normalizes a value for vote-grouping purposes — same light
 * normalization philosophy as `deepSolve/rerankCandidates.ts`'s
 * `normalizeAnswerForVote()` (lowercase, strip thousands-separator commas,
 * collapse whitespace), applied to every string leaf of a tool-call
 * arguments object (not just a single top-level answer string) plus
 * key-sorting so two functionally-identical argument objects with different
 * key order or incidental formatting differences (e.g. "3,842" vs "3842",
 * differing only in a comma this project's own math-3 case is known to
 * trip small models up on) still vote together.
 */
function normalizeForVote(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim()
  }
  if (Array.isArray(value)) return value.map(normalizeForVote)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeForVote((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * The "(tool, roughly-similar-arguments)" grouping key the master plan
 * describes: two `'tool'` decisions vote together only if they name the
 * same tool AND their arguments are identical after light normalization;
 * every `'none'` decision votes together regardless of its free-text
 * answer (the *decision* being voted on is "no tool needed", not the exact
 * wording of the explanation). Exported so grouping behavior can be tested
 * directly without going through the full vote tally.
 */
export function canonicalizeVoteKey(decision: VotableDecision): string {
  if (decision.kind === 'none') return 'none'
  return `tool:${decision.name}:${JSON.stringify(normalizeForVote(decision.input))}`
}

export interface VoteTally {
  winner: VotableDecision
  /** Index into the array passed to `tallyVotes()` of the first (earliest-sampled) decision belonging to the winning group — used by the caller to look up that sample's own response metadata (id/model/usage) for building the final message, and as this function's own deterministic tie-break rule (matches `rerankCandidates.ts`'s `selfConsistencyVote()`: "first candidate from the largest group", not an arbitrary pick). */
  winnerIndex: number
  voteCount: number
  totalValidSamples: number
}

/**
 * Groups valid (already-decoded, non-`'invalid'`) decisions by
 * `canonicalizeVoteKey()` and returns the plurality winner. Ties are broken
 * by earliest sample index — deterministic, not random, same convention as
 * `rerankCandidates.ts`'s `selfConsistencyVote()`. Returns `null` only for
 * an empty input (the caller is expected to have already filtered out
 * `'invalid'` samples before calling this).
 *
 * Pure and side-effect-free — exported so majority-vote logic can be tested
 * in isolation against synthetic candidate sets (ties, near-ties, etc.)
 * without mocking any HTTP calls.
 */
export function tallyVotes(decisions: readonly VotableDecision[]): VoteTally | null {
  if (decisions.length === 0) return null

  const groups = new Map<string, number[]>()
  decisions.forEach((decision, index) => {
    const key = canonicalizeVoteKey(decision)
    const indices = groups.get(key)
    if (indices) indices.push(index)
    else groups.set(key, [index])
  })

  let bestIndices: number[] | null = null
  for (const indices of groups.values()) {
    if (!bestIndices || indices.length > bestIndices.length) bestIndices = indices
  }

  const winnerIndex = bestIndices![0]!
  return {
    winner: decisions[winnerIndex]!,
    winnerIndex,
    voteCount: bestIndices!.length,
    totalValidSamples: decisions.length,
  }
}

/**
 * Confidence-weighted early-stop check: given the valid decisions gathered
 * so far and how many samples remain to be drawn, is the current leader's
 * vote lead mathematically unbeatable — i.e. even if every remaining sample
 * voted for the current second-place group, could the leader still be
 * caught? This is the exact "3-of-5 agreeing" example from the master plan:
 * with N=5 and 2 remaining, a 3-0 leader has `3 > 0 + 2`, so it's
 * unbeatable and sampling can stop immediately, saving the 2 remaining
 * round trips. A 1-1 split with 3 remaining is NOT unbeatable
 * (`1 > 1 + 3` is false) — correctly keeps sampling.
 *
 * Pure and side-effect-free — exported so early-stop behavior (including
 * near-tie cases that must NOT stop early) can be tested directly.
 */
export function hasUnbeatableLead(
  decisions: readonly VotableDecision[],
  remaining: number,
): boolean {
  if (decisions.length === 0) return false

  const counts = new Map<string, number>()
  for (const decision of decisions) {
    const key = canonicalizeVoteKey(decision)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const sorted = [...counts.values()].sort((a, b) => b - a)
  const leader = sorted[0] ?? 0
  const secondPlace = sorted[1] ?? 0
  return leader > secondPlace + remaining
}

type SampleUsage = {
  id?: string
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/**
 * Decodes one raw OpenAI-shaped chat-completion response into a
 * `DecodedToolDecision`. Mirrors `routerConstrainedToolSelection.ts`'s
 * `decodeToolDecision()` in spirit (defensive, never throws, `'invalid'`
 * rather than trusting blindly) but operates on the native `tool_calls`
 * response shape this module's requests actually use, not on a
 * `response_format`-encoded JSON string. Only the *first* tool call is
 * considered — the router's own top-level tool-selection turn is expected
 * to make at most one delegation decision, same assumption
 * `routerConstrainedToolSelection.ts` makes.
 */
function decodeSampleResponse(
  data: {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      }
    }>
  },
  registeredToolNames: ReadonlySet<string>,
): DecodedToolDecision {
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0]
  if (toolCall) {
    const name = toolCall.function?.name
    if (typeof name !== 'string' || name.length === 0) {
      return { kind: 'invalid', reason: 'tool_call had no function name' }
    }
    if (!registeredToolNames.has(name)) {
      return { kind: 'invalid', reason: `"${name}" is not a registered tool name` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(toolCall.function?.arguments ?? '{}')
    } catch {
      return { kind: 'invalid', reason: 'tool_call arguments were not valid JSON' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'invalid', reason: 'tool_call arguments did not decode to an object' }
    }
    return { kind: 'tool', name, input: parsed as Record<string, unknown> }
  }

  const content = data.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return { kind: 'none', answer: content }
  }

  // Empty completion (no tool_calls, no text) — historically the
  // silent-zero-token-completion bug (LOCAL_AI_STATUS.md Session 5, now
  // root-caused/fixed at the num_ctx level), kept as its own defensive
  // 'invalid' case rather than being mistaken for a legitimate "no tool
  // needed, nothing to say" decision.
  return { kind: 'invalid', reason: 'empty response: no tool_calls and no text content' }
}

export interface RouterSelfConsistencyOptions {
  baseUrl: string
  resolvedModel: string
  messages: Array<{
    role: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>
  system: unknown
  tools: readonly { name: string; description?: string; input_schema?: Record<string, unknown> }[]
  max_tokens?: number
  top_p?: number
  apiKey?: string
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
  /** Defaults to `DEFAULT_SAMPLE_COUNT` (5). */
  sampleCount?: number
  /** Defaults to `DEFAULT_TEMPERATURE` (0.6). */
  temperature?: number
}

/** Fires exactly one sample request. Never throws — returns `null` on any failure (network error, non-200, empty/invalid decision), which the caller treats as one "attempted but uncounted" sample toward the early-stop budget. */
async function fetchOneSample(
  opts: RouterSelfConsistencyOptions,
  messages: OpenAIMessage[],
  convertedTools: OpenAITool[],
  temperature: number,
  registeredToolNames: ReadonlySet<string>,
): Promise<{ decision: VotableDecision; raw: SampleUsage } | null> {
  try {
    const body: Record<string, unknown> = {
      model: opts.resolvedModel,
      messages,
      stream: false,
      // Same local-only rationale as the normal request path (openaiShim.ts)
      // and lever G: a tool-selection decision doesn't need deep reasoning,
      // and Ollama's OpenAI-compat endpoint only honors reasoning_effort.
      think: false,
      reasoning_effort: 'none',
      tools: convertedTools,
      temperature,
    }
    if (typeof opts.max_tokens === 'number' && opts.max_tokens > 0) {
      body.max_completion_tokens = opts.max_tokens
    }
    if (opts.top_p !== undefined) body.top_p = opts.top_p

    const { signal, cleanup } = createCombinedAbortSignal(opts.signal, {
      timeoutMs: ROUTER_SELF_CONSISTENCY_SAMPLE_TIMEOUT_MS,
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
          `[routerSelfConsistency] sample request failed with HTTP ${response.status} — treating as an uncounted sample`,
        )
        return null
      }

      const data = (await response.json()) as {
        id?: string
        model?: string
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
          }
        }>
        usage?: SampleUsage['usage']
      }

      const decision = decodeSampleResponse(data, registeredToolNames)
      if (decision.kind === 'invalid') {
        logForDebugging(`[routerSelfConsistency] ${decision.reason} — treating as an uncounted sample`)
        return null
      }

      return { decision, raw: { id: data.id, model: data.model, usage: data.usage } }
    } finally {
      cleanup()
    }
  } catch (e) {
    logForDebugging(`[routerSelfConsistency] sample request threw, treating as an uncounted sample: ${errorMessage(e)}`)
    return null
  }
}

/**
 * Runs the self-consistency majority-vote routing decision: samples the
 * router's normal tools-based request up to `sampleCount` times (default
 * 5) at `temperature` (default 0.6), stopping early once the leading
 * candidate has an unbeatable vote lead, and returns the plurality winner
 * as a plain Anthropic-shaped message object — same return shape as
 * `runRouterConstrainedToolSelection()`. Returns `null` on total failure
 * (every sample failed, or no votes could be tallied), in which case the
 * caller falls back to the normal single-shot path exactly as if this
 * module didn't exist. See this module's own header comment for the full
 * mechanism and fail-open discipline.
 */
export async function runRouterSelfConsistency(
  opts: RouterSelfConsistencyOptions,
): Promise<{ message: Record<string, unknown> } | null> {
  try {
    if (opts.tools.length === 0) return null

    const sampleCount = opts.sampleCount ?? DEFAULT_SAMPLE_COUNT
    if (sampleCount <= 0) return null
    const temperature = opts.temperature ?? DEFAULT_TEMPERATURE

    const registeredToolNames = new Set(opts.tools.map(t => t.name))
    const convertedTools = convertTools(
      opts.tools as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
    )
    if (convertedTools.length === 0) return null

    let messages = convertMessages(opts.messages, opts.system)
    // Same three conjuncts as this module's own gate — always true here
    // since shouldApplyRouterSelfConsistency() already checked them before
    // this function was ever called, but computed via the real gate
    // function rather than assumed, so a future drift between the two
    // gates' conjuncts can't silently skip (or wrongly apply) the few-shot
    // addendum here.
    if (shouldApplyRouterFewShot(opts.baseUrl, false, true)) {
      messages = insertRouterFewShotMessages(messages)
    }

    const samples: Array<{ decision: VotableDecision; raw: SampleUsage }> = []
    let attempted = 0

    while (attempted < sampleCount) {
      const sample = await fetchOneSample(opts, messages, convertedTools, temperature, registeredToolNames)
      attempted++
      if (sample) samples.push(sample)

      const remaining = sampleCount - attempted
      if (samples.length > 0 && hasUnbeatableLead(samples.map(s => s.decision), remaining)) {
        break
      }
    }

    if (samples.length === 0) return null // every sample failed — full fail-open

    const tally = tallyVotes(samples.map(s => s.decision))
    if (!tally) return null // unreachable given the length check above, defensive only

    // Defense in depth — same discipline as decodeToolDecision(): a tool
    // name was already validated against registeredToolNames at decode
    // time for every individual sample, but never trust a derived result
    // blindly.
    if (tally.winner.kind === 'tool' && !registeredToolNames.has(tally.winner.name)) {
      return null
    }

    const winningSample = samples[tally.winnerIndex]!
    return {
      message: buildDecisionMessage(tally.winner, winningSample.raw, opts.resolvedModel),
    }
  } catch (e) {
    logForDebugging(`[routerSelfConsistency] request threw, falling back to normal tool-calling: ${errorMessage(e)}`)
    return null
  }
}

/**
 * Re-exported for callers/tests that only import this module, rather than
 * `routerConstrainedToolSelection.ts` directly, when they need to render a
 * decision built by this module into a synthetic stream (mirrors
 * `openaiShim.ts`'s own usage of `messageToStreamEvents` for lever G).
 */
export { messageToStreamEvents }
