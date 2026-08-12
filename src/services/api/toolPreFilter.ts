import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { ASK_MATH_MODEL_TOOL_NAME } from '../../tools/AskMathModelTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import type { Tool, ToolPermissionContext, Tools } from '../../Tool.js'
import { cosineSimilarity, embedTexts } from '../../memdir/embeddingClient.js'
import { logForDebugging } from '../../utils/debug.js'
import type { APIProvider } from '../../utils/model/providers.js'
import { isLocalProviderUrl } from './providerConfig.js'

/**
 * Semantic tool pre-filtering — LOCAL_AI_MASTER_PLAN.md §6 mitigation 3.
 *
 * A small local router (qwen3:1.7b via Ollama, this project's `ollama`
 * profile) degrades on tool selection once its visible menu grows past
 * roughly 10 tools — measured directly, not theoretical (see
 * LOCAL_AI_STATUS.md's routing eval: 70% at ~13 visible tools, with the
 * remaining failures matching a tool-count-driven wrong-tool/
 * over-delegation pattern). This narrows the tool list handed to the model
 * for a single turn: a fixed "core" set (the built-ins this app needs to
 * function, plus this project's own local-AI specialists — see
 * CORE_TOOL_NAMES below) always stays visible; the discretionary tail
 * (whatever else survives upstream deferral/MCP-scoping — mostly the
 * Agent/Skill built-ins today, MCP tools if that scoping is ever relaxed)
 * is ranked by all-minilm embedding similarity between each tool's own
 * description and the current turn's user query, keeping only the top K.
 *
 * Reuses memdir/embeddingClient.ts closely (same Ollama /api/embed
 * endpoint, same all-minilm model, same fail-open discipline): if the
 * embedding call is unavailable for any reason (Ollama down, all-minilm
 * not pulled, timeout, malformed response), this returns the input tool
 * list completely unchanged rather than throwing or guessing — the visible
 * menu must never get *worse* than before this feature existed. A router
 * that can't reach Ollama for embeddings can't reach it for the actual
 * chat completion either, so this fallback is inert in practice, not a
 * silent failure mode users would hit while everything else works.
 *
 * **Provider/profile-conditional, not global** — shouldApplyToolPreFilter()
 * below is the single gate every caller must check first, and it mirrors
 * the exact isLocalProviderUrl-gated pattern openaiShim.ts already uses for
 * reasoning_effort: only ever true for the OpenAI-compatible transport
 * (`getAPIProvider() === 'openai'`, which is what the `ollama` profile
 * sets `CLAUDE_CODE_USE_OPENAI=1` into) talking to a local endpoint
 * (Ollama, LM Studio, etc.). Every other provider — Anthropic first-party,
 * Bedrock, Vertex, Foundry, Gemini, GitHub Models, Codex, or even a
 * *non-local* OpenAI-compatible endpoint — is completely unaffected: the
 * caller in claude.ts never calls applySemanticToolPreFilter() at all in
 * that case, so the tool list construction path is byte-for-byte identical
 * to before this feature existed.
 */

/**
 * Fixed set of "core" tools that stay visible no matter what — the
 * built-ins this app needs to function, plus this project's own local-AI
 * specialists. Deliberately generous per the master plan's own guidance:
 * err toward including rather than excluding a local-AI specialist, since
 * hiding one entirely would be worse than a slightly longer menu.
 *
 * This is a subset filter, not an inclusion guarantee: a core tool that
 * isn't already present in this turn's `tools` (e.g. TodoWrite/
 * AskUserQuestion, which this app's own ToolSearch deferral machinery
 * hides by default until discovered — see ToolSearchTool/prompt.ts's
 * isDeferredTool) simply isn't a filtering candidate at all.
 * applySemanticToolPreFilter() never adds a tool that upstream deferral
 * logic already decided to hide; it only ever narrows what's already
 * there.
 *
 * DocumentQA/ImageCaption/DataAnalyze don't export a *_TOOL_NAME constant
 * the way this app's own built-ins do — their literal names match the
 * private TOOL_NAME const each tool file defines
 * (DocumentQATool.ts/ImageCaptionTool.ts/DataAnalyzeTool.ts), the same
 * convention scripts/eval/routingCases.ts already uses for these three.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  BASH_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_MATH_MODEL_TOOL_NAME,
  'DocumentQA',
  'ImageCaption',
  'DataAnalyze',
])

/**
 * Always exempt from ranking/trimming, in addition to CORE_TOOL_NAMES —
 * matches this codebase's own pre-existing rule in
 * ToolSearchTool/prompt.ts's isDeferredTool ("Never defer ToolSearch
 * itself — the model needs it to load everything else"). Without this,
 * once the discretionary tail grows past TOOL_PREFILTER_TOP_K, ToolSearch
 * itself could get ranked out, permanently blocking access to every
 * deferred tool for that turn.
 */
const ALWAYS_VISIBLE_NAMES: ReadonlySet<string> = new Set([
  ...CORE_TOOL_NAMES,
  TOOL_SEARCH_TOOL_NAME,
])

/**
 * How many discretionary (non-core) tools survive the semantic rank, on
 * top of whatever core tools happen to be present this turn. Kept small —
 * CORE_TOOL_NAMES alone can be up to 12 entries, and the master plan's own
 * guidance targets keeping the total visible menu under ~10-12 — so a
 * small discretionary allowance keeps the common case close to that target
 * while still capping runaway growth (e.g. if MCP scoping is ever relaxed
 * for the `ollama` profile) far below "every tool".
 */
export const TOOL_PREFILTER_TOP_K = 4

export type ToolPromptOptions = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  tools: Tools
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
}

/**
 * Whether the local-AI semantic tool pre-filter should run at all for this
 * request. The one gate every caller must check before doing any embedding
 * work — see this module's own top comment for why both conjuncts matter
 * (baseUrl alone isn't enough: a firstParty/Bedrock/Vertex session could
 * have an unrelated, stale OPENAI_BASE_URL pointed at localhost from other
 * tooling, and resolveProviderRequest() reads that env var unconditionally
 * regardless of which provider is actually driving the request).
 */
export function shouldApplyToolPreFilter(
  provider: APIProvider,
  baseUrl: string | undefined,
): boolean {
  return provider === 'openai' && isLocalProviderUrl(baseUrl)
}

async function toolEmbeddingText(
  tool: Tool,
  promptOptions: ToolPromptOptions,
): Promise<string> {
  try {
    const description = await tool.prompt(promptOptions)
    return description ? `${tool.name}: ${description}` : tool.name
  } catch {
    // A single tool's prompt() throwing must never break ranking for every
    // other tool — fall back to just its name for this one candidate.
    return tool.name
  }
}

/**
 * Narrows `tools` down to the always-visible core/ToolSearch set plus the
 * top-K discretionary tools most semantically similar to `query`.
 *
 * Fails open at every stage, same discipline as
 * memdir/embeddingPreFilter.ts: no query text, embedding unavailable, or a
 * malformed/short response all return `tools` completely unchanged. Callers
 * must already have checked shouldApplyToolPreFilter() before calling this
 * — it does no provider/URL gating itself.
 */
export async function applySemanticToolPreFilter(
  tools: Tools,
  query: string,
  promptOptions: ToolPromptOptions,
  signal: AbortSignal,
): Promise<Tools> {
  const core: Tool[] = []
  const discretionary: Tool[] = []
  for (const tool of tools) {
    ;(ALWAYS_VISIBLE_NAMES.has(tool.name) ? core : discretionary).push(tool)
  }

  // Nothing to trim — the discretionary tail already fits under the budget
  // on its own. No network call, same as embeddingPreFilter.ts's own
  // `memories.length <= topK` short-circuit.
  if (discretionary.length <= TOOL_PREFILTER_TOP_K) {
    return tools
  }

  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    // No real user-turn text to rank against (e.g. a tool-result-only
    // continuation turn) — keep the input unchanged rather than ranking on
    // nothing.
    return tools
  }

  const discretionaryTexts = await Promise.all(
    discretionary.map(tool => toolEmbeddingText(tool, promptOptions)),
  )
  const embeddings = await embedTexts([trimmedQuery, ...discretionaryTexts], signal)
  if (!embeddings || embeddings.length !== discretionary.length + 1) {
    logForDebugging(
      '[toolPreFilter] embedding unavailable/malformed — showing the full tool list unchanged',
    )
    return tools
  }

  const [queryEmbedding, ...toolEmbeddings] = embeddings as [
    number[],
    ...number[][],
  ]
  const scored = discretionary.map((tool, i) => ({
    tool,
    score: cosineSimilarity(queryEmbedding, toolEmbeddings[i]!),
  }))
  scored.sort((a, b) => b.score - a.score)
  const keptNames = new Set(scored.slice(0, TOOL_PREFILTER_TOP_K).map(s => s.tool.name))

  logForDebugging(
    `[toolPreFilter] discretionary tail ${discretionary.length} -> ${keptNames.size} (core: ${core.length}): kept ${[...keptNames].join(', ')}`,
  )

  // Preserve the input array's original relative order among survivors
  // rather than re-sorting by rank — this function's only job is which
  // tools survive, not their order (downstream cache-stability sorting in
  // tools.ts/claude.ts already owns ordering).
  return tools.filter(tool => ALWAYS_VISIBLE_NAMES.has(tool.name) || keptNames.has(tool.name))
}
