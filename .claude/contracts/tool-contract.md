# Tool Contract — OpenClaude

> Maintained by **tools-execution-agent**. Read by **provider-router-agent**
> (how tool-call results flow back into the query engine),
> **commands-skills-agent** (what a slash command can invoke), and
> **security-audit-agent** (read-only — the permission/security surface).
> Format: the `Tool` interface shape, the permission-check contract, and the
> currently-registered tool inventory. Overwritten in place as the tool
> surface changes — this is a living document, not a changelog. Point-in-time
> handoffs belong in `.claude/contracts/handoffs/`, not here.

---

## 1. The `Tool` interface (`src/Tool.ts`)

Every tool in `src/tools/` implements this shape (trimmed to the
load-bearing members — see `src/Tool.ts` for the full ~700-line definition
including all the optional rendering/UI hooks):

```typescript
export type Tool<Input extends AnyObject = AnyObject, Output = unknown> = {
  readonly name: string
  aliases?: string[]
  readonly inputSchema: Input          // Zod schema
  readonly inputJSONSchema?: ToolInputJSONSchema  // for MCP tools that skip Zod
  outputSchema?: z.ZodType<unknown>

  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress,
  ): Promise<ToolResult<Output>>

  description(input: z.infer<Input>, options: {...}): Promise<string>

  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean       // default false
  isConcurrencySafe(input: z.infer<Input>): boolean     // default false

  // Permission gate — called AFTER validateInput() passes, BEFORE call()
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  validateInput?(input: z.infer<Input>, context: ToolUseContext): Promise<ValidationResult>

  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string): ToolResultBlockParam
  renderToolUseMessage(input: Partial<z.infer<Input>>, options: {...}): React.ReactNode
}
```

`buildTool(def: ToolDef)` in `src/Tool.ts` fills in safe, **fail-closed**
defaults for the commonly-stubbed methods — every tool export should go
through it:
```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,   // assume NOT safe
  isReadOnly: () => false,           // assume writes
  isDestructive: () => false,
  checkPermissions: (input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',
  userFacingName: () => '',
}
```

### The permission-check ordering guarantee
`validateInput()` → `checkPermissions()` → `call()`. **`checkPermissions`
must resolve, and its `behavior` must be honored, strictly before `call()`
runs any side effect.** This is the single most important invariant in the
codebase's security model — `security-audit-agent` checks every tool
against it.

### `ToolResult<Output>` shape
```typescript
export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> }
}
```

### `ToolPermissionContext` (from `src/utils/permissions/`)
```typescript
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean   // true for background agents that can't show UI
  prePlanMode?: PermissionMode
}>
```

---

## 2. Registered tool inventory (`src/tools.ts`)

40+ tools registered as of this scaffold — non-exhaustive list of the ones
most agents will touch:

| Tool | Directory | Notes |
|---|---|---|
| `Bash` | `src/tools/BashTool/` | Shell execution via `execa`; permission-gated |
| `FileRead` / `FileEdit` / `FileWrite` | `src/tools/File*Tool/` | `isDestructive: true` for Write/Edit |
| `Glob` / `Grep` | `src/tools/GlobTool/`, `GrepTool/` | Read-only, concurrency-safe |
| `Agent` | `src/tools/AgentTool/` | Spawns sub-agents; coordinates with `coordinatorMode.ts`'s `ASYNC_AGENT_ALLOWED_TOOLS` |
| `WebBrowser` | `src/tools/WebBrowserTool/` | Browser automation |
| `MCP` (dynamic) | `src/tools/MCPTool/` | One tool instance per MCP server capability, name-prefixed `mcp__server__tool` |
| `AskMathModel` | `src/tools/AskMathModelTool/` | Calls a local Ollama math specialist — raw completion, not native tool-calling |
| `DocumentQA` / `ImageCaption` | `src/tools/{DocumentQA,ImageCaption}Tool/` | Call the Python bridge (`python-bridge/`) over local HTTP |
| `DataAnalyze` | `src/tools/DataAnalyzeTool/` | First domain **gateway tool** per `LOCAL_AI_MASTER_PLAN.md` §6 mitigation 2 — one tool, `operation: "question" \| "predict" \| "forecast"`, dispatching deterministically (no model choice below the gateway) to `/table-qa`, `/tabular-predict`, `/forecast` on the Python bridge. Tool-facing `inputSchema`/`outputSchema` are deliberately flat `ZodObject`s with every per-operation field optional, not a top-level `z.discriminatedUnion` — see `DataAnalyzeTool/schemas.ts`'s comment (mirrors the existing `LSPTool/schemas.ts` pattern: a discriminated union is used internally, in `validateInput()`/`call()`, purely for precise per-operation error messages). Future Vision/Audio gateway tools (§6) should follow this same shape. |
| `TeamCreate` / `TeamDelete` / `SendMessage` | `src/tools/Team*Tool/`, `SendMessageTool/` | Swarm/teammate orchestration |
| `EnterPlanMode` / `ExitPlanMode` | `src/tools/*PlanModeTool/` | Permission-mode transitions |

A new tool is only reachable by the model once it's registered in
`src/tools.ts` — an implemented-but-unregistered tool is dead code.

---

## 3. Python bridge routes (backing `DocumentQA`/`ImageCaption`)

Owned by `python-bridge-agent`; called by `tools-execution-agent`'s tools
over local HTTP (loopback only, no auth — not internet-facing by design).

| Route | Backing tool | Request | Response |
|---|---|---|---|
| `POST /document-qa` (exact path: see `python-bridge/server.py`) | `DocumentQATool` | `{ question: string, context: string }` | `{ answer: string, score: number }` |
| `POST /image-caption` | `ImageCaptionTool` | `{ image_path: string }` (corrected 2026-08-12 — was documented as `image`, actual field has always been `image_path`; see `ImageCaptionRequest` in `server.py`) | `{ caption: string }` |
| `GET /status` | none yet — debugging/eval-harness only | (no body) | `{ budget_mb: number, committed_mb_estimated: number, process_rss_mb: number \| null, rss_source: "windows_working_set" \| "posix_rusage" \| "unavailable", loaded: Array<{ name, estimated_mb, heavy, device, declared_device, fp16, in_use, loaded_at, resident_seconds }>, registered: string[] }` (updated 2026-08-12: `device`/`fp16` now report the *actual resolved* placement, not a declared-only stub — see below; `declared_device` is the new field holding what a model's `ModelSpec` asked for, in case the two differ, e.g. a CUDA request that fell back to CPU) |

`/document-qa` and `/image-caption`'s request/response shapes are
unchanged by the 2026-08-12 model-manager work — both the original budget
cap/LRU/single-flight/heavy-exclusivity work and the same-day dedicated-
CUDA-venv follow-up that turned `device`/`fp16` from an informational stub
into real GPU placement (`document_qa.py`/`image_caption.py` now register
`device="cuda", fp16=True`, live-verified: correct output unchanged,
~4x-6x faster than the prior CPU baseline; falls back to CPU automatically
if CUDA isn't available — see `python-bridge/local_models/manager.py` and
`python-bridge/README.md`). All of that is purely internal to the bridge
(what's resident, where, and how fast), not part of either route's
contract. `/status` is new and not yet consumed by any TS tool; if the
eval harness or a future tool needs to call it from TypeScript, that's a
`tools-execution-agent` pickup, not done here.

### Phase 3 data/tables routes, behind `DataAnalyzeTool` — implemented and live-verified 2026-08-12

All three routes below are now live in the bridge (`python-bridge-agent`,
2026-08-12), request/response shapes exactly as originally planned —
**no shape changes**, so no tool-side updates should be needed. Live-
verified against the real bridge (not just unit-tested): correct
classify/regress predictions with `probabilities` columns aligned to
sorted labels, correct table-QA cell grounding, correct forecast shape
with `low`/`high` always present (chronos-t5-tiny always exposes
quantiles via sampling, so these are never omitted in practice); malformed
input (empty/ragged tables, non-positive/excessive horizon, empty series)
confirmed to return 400/422, never a raw 500.

| Route | Model | Request | Response |
|---|---|---|---|
| `POST /tabular-predict` | TabPFN-v2 (clf+reg) | `{ operation: "classify" \| "regress", train_features: number[][], train_labels: (string \| number)[], test_features: number[][] }` | `{ predictions: (string \| number)[], probabilities?: number[][] }` (`probabilities` present only for `operation: "classify"`, one row per test sample, columns aligned to the sorted unique labels seen in `train_labels`) |
| `POST /table-qa` | tapas-mini-finetuned-wtq | `{ question: string, table: { columns: string[], rows: string[][] } }` | `{ answer: string, cells: Array<{ row: number, column: number }> }` (`cells` are 0-indexed into `table.rows`/`table.columns`, empty array if the model didn't ground an answer to specific cells) |
| `POST /forecast` | chronos-t5-tiny | `{ series: number[], horizon: number }` | `{ forecast: number[], low?: number[], high?: number[] }` (`forecast` is the median prediction, length `horizon`; `low`/`high` are an uncertainty band if the underlying model exposes quantiles, omitted otherwise) |

All three: CPU (tiny models, no GPU device placement needed per
`LOCAL_AI_MASTER_PLAN.md` §3/§4 — that capacity is reserved for BLIP/
DistilBERT and future bigger models), register via `manager.py`'s
`ModelSpec` pattern like every other route, loopback-only, no auth, fail
with a clear 4xx (not a raw 500) on malformed input (confirmed live:
empty/ragged `table.rows`, empty `train_features`/`test_features`,
mismatched `train_features`/`train_labels` length, non-positive or
excessive `horizon`, too-short `series`).

**Consumer side status (2026-08-12, tools-execution-agent):** `DataAnalyzeTool`
is built and registered against this exact contract (request/response
shapes above, verbatim — including sending `train_labels`' classify/regress
choice through as the bridge's own `operation` field, distinct from the
tool's own top-level `operation` field which selects question/predict/
forecast). Mocked tests cover all three operations plus error handling.
`DataAnalyzeTool.live.test.ts` was written per this repo's
`*.live.test.ts` convention before these routes went live — **the routes
are live now** (this update); running that file against the real bridge to
confirm is still `tools-execution-agent`'s/the orchestrator's pickup (out
of `python-bridge-agent`'s `src/`-free surface), not done as part of this
change. No tool-side code changes are expected — no route shape changed
from what's documented above.

Extending this table is `python-bridge-agent`'s responsibility whenever a
new route is added — see that agent's own Architecture rules for the
lazy-load-singleton pattern every route follows (now: register a
`ModelSpec` with the shared `local_models.manager` rather than a private
per-module singleton — see `python-bridge/README.md`'s "Adding another
model" section).

---

## 4. Not yet implemented / planned
> `tools-execution-agent` adds entries here as new tools are built.

(none tracked yet — this scaffold was generated before any post-scaffold
tool work began)
