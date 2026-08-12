import type { OpenAIMessage } from './openaiShim.js'
import { isLocalProviderUrl } from './providerConfig.js'

/**
 * Few-shot tool-selection examples for the local router model —
 * `LOCAL_AI_MASTER_PLAN.md` §6 lever F ("Few-shot examples in the router
 * prompt", added session 13). Evidence: a controlled small-model ablation
 * (Meta-Tool, arxiv 2604.20148, Llama-3.2-3B backbone) measured few-shot
 * examples +21.5% vs documentation +5.0% vs LoRA-style adaptation +0.0% on
 * tool-selection accuracy. Prompt-only, no new model, no fine-tuning.
 *
 * Mechanism: inject a small, fixed set of illustrative *prior turns* — a
 * real user message followed by the router's own tool_use decision, or a
 * plain no-tool-needed final answer — directly into the outgoing
 * OpenAI-format message array, immediately after the system message and
 * before the real conversation. This is deliberately shaped as real
 * message-role turns (not prose appended to the system prompt) because
 * that's what actually demonstrates the tool-calling wire format to the
 * model, and it's what the Meta-Tool ablation's "few-shot examples" arm
 * means concretely.
 *
 * Three examples, chosen to target this project's own measured routing-eval
 * failure modes (`LOCAL_AI_STATUS.md` Session 5/7 — 3 wrong-tool
 * hallucinations, 3 over-delegations on trivial/no-tool-needed prompts,
 * confirmed to be a reliability ceiling independent of tool count): one math
 * delegation, one table→DataAnalyze, and one "no tool needed" (trivial
 * arithmetic below AskMathModelTool's own 2-digit-operand delegation
 * threshold — this is the exact shape of `routing-distractor-1`/`-3` in
 * `scripts/eval/routingCases.ts`). Ordered least-similar → most-similar to
 * a typical incoming router query, per the master plan's own guidance to
 * exploit in-context recency bias: since this is a fixed, static addendum
 * (not re-ranked per turn), "most similar to a typical query" is
 * interpreted here as "most directly targets the plurality failure mode" —
 * the no-tool-needed example is placed last, closest to the real
 * conversation that follows, since 3 of the 6 known remaining failures are
 * over-delegation and recency bias should weight that example the most.
 *
 * **Gated local-only** — `shouldApplyRouterFewShot()` below is the single
 * gate every caller must check first, mirroring `toolPreFilter.ts`'s own
 * gate-function-plus-apply-function shape and the same
 * `isLocalProviderUrl()`-based pattern every other local-only behavior in
 * this project uses (the `reasoning_effort`/`think` handling in
 * `openaiShim.ts`'s `_doOpenAIRequest`, the semantic tool pre-filter in
 * `toolPreFilter.ts`). Every cloud-provider path and every non-local
 * OpenAI-compatible endpoint is completely unaffected.
 *
 * **Scope note, verified not assumed**: this module is only ever reached
 * from `openaiShim.ts`'s `_doOpenAIRequest()` — the HTTP path the running
 * agent's own top-level chat-completion turn takes (system prompt + tool
 * list). It is NOT on the path any local-AI specialist uses to talk to its
 * own model: `AskMathModelTool`'s single-shot and deep modes both `fetch`
 * `$MATH_MODEL_BASE_URL/chat/completions` directly
 * (`AskMathModelTool.ts`, `deepSolve/generateCandidates.ts`) with their own
 * bare `messages: [{role:'user', content: problem}]` payload, never through
 * this shim's `beta.messages.create()`; `DocumentQATool`/`ImageCaptionTool`/
 * `DataAnalyzeTool` all call the Python bridge
 * (`$MODEL_BRIDGE_BASE_URL`, see `tools/shared/localModelBridge.ts`) over
 * plain HTTP, not Ollama chat completions at all. So even though VibeThinker
 * (the tool-call-recovery-listed math specialist) shares the same local
 * Ollama instance the router uses, its calls never pass through
 * `_doOpenAIRequest` and never see this addendum — the
 * `isToolCallRecoveryModel` exclusion below is defense in depth, not the
 * only thing preventing overlap. The `hasTools` gate is the other half of
 * that defense in depth: it's what actually distinguishes the router's own
 * tool-selection turn from any other plain (no-`tools`) completion this
 * shim might ever issue against the same local endpoint (e.g. a
 * summarization/compaction call reusing the active model) — injecting a
 * fake tool_use example into a turn where no tools are even offered would
 * be nonsensical noise, not a beneficial example.
 */

/** Prefix for the synthetic tool_call ids used in the few-shot examples below — never collide with a real request's ids, which this project generates via makeMessageId()/similar, not this fixed literal prefix. */
const FEWSHOT_CALL_ID_PREFIX = 'fewshot_example_call_'

/**
 * Whether the router few-shot addendum should be applied to this request.
 * The one gate every caller must check before calling
 * `insertRouterFewShotMessages()` — see this module's own top comment for
 * why all three conjuncts matter.
 */
export function shouldApplyRouterFewShot(
  baseUrl: string | undefined,
  isToolCallRecoveryModel: boolean,
  hasTools: boolean,
): boolean {
  return hasTools && isLocalProviderUrl(baseUrl) && !isToolCallRecoveryModel
}

function toolCallMessage(
  toolName: string,
  args: Record<string, unknown>,
  id: string,
): OpenAIMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `${FEWSHOT_CALL_ID_PREFIX}${id}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args) },
      },
    ],
  }
}

/**
 * Builds the fixed few-shot message sequence. Exported (not just used
 * internally) so tests can assert on its exact shape without going through
 * the full request-building path.
 */
export function buildRouterFewShotMessages(): OpenAIMessage[] {
  return [
    // Example 1 — table question → DataAnalyze.
    {
      role: 'user',
      content:
        'Here is a small table:\nName, Score\nAlice, 92\nBob, 77\nCarol, 85\nQuestion: Who has the highest score?',
    },
    toolCallMessage(
      'DataAnalyze',
      {
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
      '1',
    ),

    // Example 2 — multi-digit math → AskMathModel.
    { role: 'user', content: 'What is 734 x 851?' },
    toolCallMessage('AskMathModel', { problem: '734 x 851' }, '2'),

    // Example 3 — trivial arithmetic, no tool needed. Placed last
    // (closest to the real conversation) to weight this behavior the most
    // via in-context recency bias — this is the exact shape of the
    // over-delegation failures (`routing-distractor-1`/`-3`) this lever
    // targets directly.
    { role: 'user', content: 'What is 12 * 7?' },
    { role: 'assistant', content: '12 * 7 = 84.' },
  ]
}

/**
 * Returns a new message array with the few-shot examples spliced in right
 * after the system message (or at the start, if there is none — a
 * defensive fallback, not an expected case in this codebase's own request
 * construction). Never mutates the input array. Callers must already have
 * checked `shouldApplyRouterFewShot()` — this function does no gating
 * itself.
 */
export function insertRouterFewShotMessages(
  messages: OpenAIMessage[],
): OpenAIMessage[] {
  const insertAt = messages.length > 0 && messages[0]?.role === 'system' ? 1 : 0
  return [
    ...messages.slice(0, insertAt),
    ...buildRouterFewShotMessages(),
    ...messages.slice(insertAt),
  ]
}
