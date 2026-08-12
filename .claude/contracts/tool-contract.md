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
| `GET /status` | none yet — debugging/eval-harness only | (no body) | `{ budget_mb: number, committed_mb_estimated: number, process_rss_mb: number \| null, rss_source: "windows_working_set" \| "posix_rusage" \| "unavailable", loaded: Array<{ name, estimated_mb, heavy, device, fp16, in_use, loaded_at, resident_seconds }>, registered: string[] }` |

`/document-qa` and `/image-caption`'s request/response shapes are
unchanged by the 2026-08-12 model-manager work (budget cap + LRU eviction,
single-flight loading, heavy-model exclusivity flag, device-placement
stub — see `python-bridge/local_models/manager.py`) — that work is purely
internal to the bridge (what's resident and when), not part of either
route's contract. `/status` is new and not yet consumed by any TS tool;
if the eval harness or a future tool needs to call it from TypeScript,
that's a `tools-execution-agent` pickup, not done here.

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
