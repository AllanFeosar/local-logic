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
 * Four examples, chosen to target this project's own measured routing-eval
 * failure modes (`LOCAL_AI_STATUS.md` Session 5/7 — 3 wrong-tool
 * hallucinations, 3 over-delegations on trivial/no-tool-needed prompts,
 * confirmed to be a reliability ceiling independent of tool count): one math
 * delegation, one table→DataAnalyze, one "no tool needed" trivial-arithmetic
 * case (below AskMathModelTool's own 2-digit-operand delegation threshold —
 * the exact shape of `routing-distractor-1`/`-3` in
 * `scripts/eval/routingCases.ts`), and one "no tool needed" bare greeting
 * (added session 29 after a live REPL session showed a plain "hi" producing
 * three consecutive malformed `Skill` tool calls — the same
 * hallucinated-Skill shape Session 2 first recorded; this is the
 * conversational-opener flavor of the same over-delegation mode
 * `routing-distractor-2` measures). Ordered least-similar → most-similar to
 * a typical incoming router query, per the master plan's own guidance to
 * exploit in-context recency bias: since this is a fixed, static addendum
 * (not re-ranked per turn), "most similar to a typical query" is
 * interpreted here as "most directly targets the plurality failure mode" —
 * the two no-tool-needed examples are placed last, closest to the real
 * conversation that follows, since over-delegation is the plurality of
 * known remaining failures and recency bias should weight them the most.
 * Neither no-tool example reuses a holdout case's literal prompt text
 * (`routingCases.ts` holdout split) — the eval's own context-leak lesson
 * (Session 17, math-3).
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

    // Example 3 — read a specific file → Read (file_path). Added session 29
    // after a live REPL run ("<path> explain how this project is created")
    // showed the router NOT retrieving the file at all: it either fabricated
    // file contents outright (a hallucinated answer with an invented
    // confidence score) or mis-routed a "read this file" request to Grep with
    // its required `pattern` arg missing entirely — the same wrong-tool-plus-
    // malformed-args shape the greeting hit with Skill. The file-read plumbing
    // (FileReadTool) is the same code the cloud parent uses; the 1.7B router
    // just has zero few-shot coverage for the read-a-file wire format, so it
    // guesses. This demonstrates it once: user names a path to read → emit
    // Read with the absolute path as file_path, nothing else.
    {
      role: 'user',
      content: 'Read the file C:\\Users\\me\\notes.txt and tell me what it says.',
    },
    toolCallMessage('Read', { file_path: 'C:\\Users\\me\\notes.txt' }, '3'),

    // Example 4 — trivial arithmetic, no tool needed. This is the exact
    // shape of the over-delegation failures (`routing-distractor-1`/`-3`)
    // this lever targets directly.
    { role: 'user', content: 'What is 12 * 7?' },
    { role: 'assistant', content: '12 * 7 = 84.' },

    // Example 5 — bare conversational greeting, no tool needed. Placed
    // last (closest to the real conversation) to weight this behavior the
    // most via in-context recency bias: a session opener is, by
    // construction, the very next thing after this example in a fresh
    // conversation. Added session 29 — a live REPL "hi" produced three
    // consecutive malformed `Skill` calls (args-as-object, then missing
    // `skill` twice) before this example existed. Deliberately NOT the
    // literal text of `routing-distractor-2` or `holdout-distractor-2`, so
    // the eval keeps measuring generalization rather than recall.
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'Hi! What would you like to work on?',
    },
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
