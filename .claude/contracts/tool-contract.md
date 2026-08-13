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
| `AudioAnalyze` | `src/tools/AudioAnalyzeTool/` | Phase 4 "Hearing" gateway tool (added 2026-08-13, `tools-execution-agent`) — one tool, `operation: "transcribe" \| "vad"`, dispatching to `/transcribe`/`/vad` on the Python bridge (§3 below). Same flat-`ZodObject`-tool-facing-schema / internal-`z.discriminatedUnion`-for-validation shape as `DataAnalyzeTool` (`AudioAnalyzeTool/schemas.ts`). Unlike `DataAnalyzeTool`, `audio_path` is required by both operations, so the internal union's main job is rejecting operation-mismatched fields (e.g. `threshold` supplied with `operation: "transcribe"`) rather than a missing shared field. |
| `TranscribeAndSummarize` | `src/tools/TranscribeAndSummarizeTool/` | Phase 4's named **fixed pipeline tool** (`LOCAL_AI_MASTER_PLAN.md` §6 mitigation 4 / §8 Phase 4) — one call runs `/vad` then `/transcribe` and returns the raw transcript + speech-segment metadata; does not call any LLM itself ("router summarizes" happens in the calling model's own next turn, same "return facts, not prose" posture as `DocumentQA`/`DataAnalyze`). Does not physically trim the audio to VAD's detected ranges before transcribing — see the tool's own `call()` comment for why (avoids duplicating `audio_utils.py`'s WAV parsing in TypeScript; Whisper's long-form generation already handles surrounding silence correctly). VAD's real payoff here: if it detects zero speech, transcription is skipped entirely (`had_speech: false`, empty transcript) rather than paying for a wasted Whisper pass. |
| `VisionAnalyze` | `src/tools/VisionAnalyzeTool/` | Phase 5 "Vision suite" gateway tool (added 2026-08-13, `tools-execution-agent`) — one tool, `operation: "caption" \| "classify" \| "embed" \| "embed-dinov2" \| "segment" \| "detect" \| "pose"`, dispatching to `/image-caption`, `/clip-classify`, `/clip-embed`, `/dinov2-embed`, `/clipseg-segment`, `/owlv2-detect`, `/vitpose-pose` respectively on the Python bridge (§3 below). Same flat-`ZodObject`-tool-facing-schema / internal-`z.discriminatedUnion`-for-validation shape as `DataAnalyzeTool`/`AudioAnalyzeTool` (`VisionAnalyzeTool/schemas.ts`); `image_path` is required by every operation, same pattern as `AudioAnalyzeTool`'s universally-required `audio_path`. **`ImageCaptionTool` fold-in decision (per the task's own explicit request to make a real call): option (b), not (a)** — `ImageCaptionTool` stays exactly as-is (unchanged file, name, and shape) as a lightweight standalone convenience tool, and `VisionAnalyzeTool`'s `"caption"` operation *also* independently calls `/image-caption` (via the new shared `src/tools/shared/visionBridge.ts` client, not by invoking `ImageCaptionTool` itself — mirrors how `AudioAnalyzeTool`/`TranscribeAndSummarizeTool` each call `/transcribe`/`/vad` directly rather than composing tool calls). Reason: `ImageCaptionTool` is load-bearing by *name* in several places outside `src/tools/` — `src/services/api/toolPreFilter.ts`'s `CORE_TOOL_NAMES` (always-visible core tool set), `scripts/eval/routingCases.ts`'s routing-eval cases (`expectedTool: 'ImageCaption'`, both tuning and holdout splits), and `src/services/api/routerFewShot.ts`'s few-shot examples — removing or renaming it would invalidate all three without a coordinated update, for zero benefit (a few dozen duplicated lines of a thin fetch wrapper) over real risk (regressing the routing eval mid-work on an already-fragile metric, per `LOCAL_AI_MASTER_PLAN.md` §6/§8's own current status). `"embed"` (CLIP, 768-dim) vs `"embed-dinov2"` (DINOv2, 384-dim) are two separate top-level operations rather than one `"embed"` operation with a `model` sub-parameter — see `VisionAnalyzeTool/schemas.ts`'s comment for the reasoning (the two embedding spaces are not interchangeable settings of the same computation the way `DataAnalyzeTool`'s classify/regress `task` sub-parameter is; each needs its own distinct operation-enum description so a small tool-calling model picks the right one for "text-alignable" vs. "pure-visual" similarity). |
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

### Phase 4 hearing routes, backing `AudioAnalyze`/`TranscribeAndSummarize` — bridge side and both tools built and live-verified

Both routes below went live in the bridge (`python-bridge-agent`,
2026-08-13) per `LOCAL_AI_MASTER_PLAN.md` §8 Phase 4, then `AudioAnalyzeTool`/
`TranscribeAndSummarizeTool` were built against this exact contract
(`tools-execution-agent`, 2026-08-13, same day — see §2's table above for
each tool's shape). No route shape changed between the bridge-side session
and the tool-side session; everything documented below is exactly what
both tools call.

| Route | Model | Request | Response |
|---|---|---|---|
| `POST /transcribe` | whisper-large-v3-turbo | `{ audio_path: string, language?: string }` | `{ text: string, language: string, segments: Array<{ text: string, start: number, end: number }> }` (`language` omitted in the request auto-detects — the response's `language` field always reports what was actually used, detected or supplied; an unrecognized requested language string is a 400, not a 500) |
| `POST /vad` | silero-vad (ONNX release, not the pre-downloaded `Silero-VAD-v5-MLX` checkpoint — see `local_models/vad.py`'s module docstring for why) | `{ audio_path: string, threshold?: number, min_speech_duration_ms?: number, min_silence_duration_ms?: number, speech_pad_ms?: number }` (all four optional, defaults 0.5/250/100/30) | `{ segments: Array<{ start: number, end: number }> }` (seconds, speech segment timestamps only — not a transcription) |

Both: `audio_path` currently only accepts **WAV audio** (mono or stereo,
8-bit or 16-bit PCM — 16-bit live-tested, 8-bit implemented but untested;
compressed WAV and non-WAV containers like mp3/m4a are rejected, not
silently mishandled — see `local_models/audio_utils.py`). A missing,
unreadable, or unsupported-format file is a 404 (same collapsed-existence-
oracle reasoning as `/image-caption` — see that route's own contract note
above); a too-short/too-long/out-of-range parameter is a 400. `/transcribe`
is GPU+fp16 (`device="cuda"`, falls back to CPU automatically); `/vad` is
CPU-only (live-benchmarked ~250x real-time at this model's size — GPU
placement would add complexity for no measurable benefit, see `vad.py`).
Live-verified end-to-end against real Windows-SAPI-synthesized speech
audio (short and >30s long-form) and a synthesized speech/silence/speech
clip for VAD segmentation — see `LOCAL_AI_STATUS.md`'s Phase 4 session
entry for exact transcripts/segment boundaries produced.

`TranscribeAndSummarizeTool` calls `/vad` first, then `/transcribe` — both
routes are independent and composable, no bridge-side pipeline endpoint
exists for this (deliberately left as tool-side orchestration, matching how
`DataAnalyzeTool` composes three independent bridge routes rather than the
bridge doing multi-model pipelines itself). It does **not** trim the audio
to VAD's detected ranges before transcribing (a real option the master
plan's own phrasing left open — see that tool's `call()` comment for the
justification); the only behavioral effect of the `/vad` call is an early
exit when zero speech is detected, skipping `/transcribe` entirely.

**Consumer side status (2026-08-13, tools-execution-agent):**
`AudioAnalyzeTool` (`src/tools/AudioAnalyzeTool/`) and
`TranscribeAndSummarizeTool` (`src/tools/TranscribeAndSummarizeTool/`) are
both built and registered against this exact contract, request/response
shapes verbatim. A shared HTTP client + 404/400 error-mapping helper
(`src/tools/shared/audioBridge.ts`) backs both tools' bridge calls, so the
`{"detail": "..."}` FastAPI error-body parsing and the 404→"not
found/unsupported format" / 400→"rejected the request: `<detail>`" mapping
live in exactly one place. Mocked tests cover both operations of
`AudioAnalyzeTool` plus `TranscribeAndSummarizeTool`'s two-call pipeline
(including the had-speech / no-speech branches and error propagation from
either bridge call); `*.live.test.ts` files for both tools synthesize their
own test audio at run time (Windows SAPI TTS for real speech, a small
hand-rolled silent-WAV writer for the no-speech case) rather than depending
on a checked-in binary fixture — see `LOCAL_AI_STATUS.md`'s Phase 4
tool-side session entry for live-verification results.

### Phase 5 vision-suite routes, backing `VisionAnalyze` — bridge side and tool both built and live-verified

All six routes below went live in the bridge (`python-bridge-agent`,
2026-08-13) per `LOCAL_AI_MASTER_PLAN.md` §8 Phase 5, then `VisionAnalyzeTool`
was built against this exact contract (`tools-execution-agent`, 2026-08-13,
same day). No route shape changed between the bridge-side session and the
tool-side session; everything documented below is exactly what the tool
calls.

| Route | Model | Request | Response |
|---|---|---|---|
| `POST /clip-classify` | clip-vit-large-patch14 | `{ image_path: string, labels: string[] }` | `{ predictions: Array<{ label: string, score: number }> }` (sorted descending by score; softmax-normalized across the supplied `labels`, not a calibrated open-set probability) |
| `POST /clip-embed` | clip-vit-large-patch14 | `{ image_path: string }` | `{ embedding: number[] }` (768-dim, L2-normalized — cosine similarity between two calls reduces to a dot product; NOT comparable to `/dinov2-embed`'s vectors, different model/space) |
| `POST /clipseg-segment` | clipseg-rd64-refined | `{ image_path: string, prompt: string, threshold?: number }` (`threshold` optional, default 0.5, `0 < threshold < 1`) | `{ found: boolean, box: { x1: number, y1: number, x2: number, y2: number } \| null, confidence: number, coverage: number }` (`box` is a bounding box derived from the thresholded mask, in the *original* image's pixel coordinates, not a raw pixel mask — see `local_models/clipseg.py`'s module docstring for why a mask blob wasn't returned; `confidence` is mean sigmoid probability inside the box, `coverage` is the fraction of image pixels above threshold) |
| `POST /dinov2-embed` | dinov2-small | `{ image_path: string }` | `{ embedding: number[] }` (384-dim, L2-normalized, the LayerNormed CLS token — NOT comparable to `/clip-embed`'s vectors) |
| `POST /owlv2-detect` | owlv2-base-patch16-ensemble | `{ image_path: string, queries: string[], threshold?: number }` (`threshold` optional, default 0.1, `0 < threshold < 1`) | `{ detections: Array<{ label: string, score: number, box: { x1, y1, x2, y2 } }> }` (sorted descending by score; `box` is in the original image's absolute pixel coordinates, top-left/bottom-right — via `Owlv2Processor.post_process_grounded_object_detection`) |
| `POST /vitpose-pose` | vitpose-plus-base | `{ image_path: string, boxes?: number[][] }` (`boxes`, if supplied, is COCO-format `[x, y, width, height]` per box; omitted defaults to a single full-image box — this bridge does not compose a person-detector stage internally, see below) | `{ people: Array<{ box: { x1, y1, x2, y2 }, keypoints: Array<{ name: string, x: number, y: number, score: number }> }> }` (17 COCO keypoints per person, `name` values like `"L_Shoulder"`/`"R_Knee"` from this checkpoint's own `config.id2label`) |

All six: loopback-only, no auth, same collapsed-404 reasoning as
`/image-caption`/`/transcribe` for a missing or unreadable `image_path`
(`local_models/image_utils.py`, new shared helper this phase — see its own
docstring); a malformed request body (empty `labels`/`queries`/`prompt`, a
malformed `boxes` entry) is a 400, never a raw 500. Device placement was
decided per-model from live benchmarks, not defaulted: `clip`/`owlv2` are
GPU+fp16 (measured 10x and ~25x CPU/GPU speedups respectively, large enough
to matter for a single interactive call); `clipseg`/`dinov2`/`vitpose` are
CPU-only (measured CPU latency already comfortable, 55-296ms, and kept off
the GPU to preserve this machine's tight VRAM headroom) — see
`python-bridge/local_models/clip.py`'s module docstring for every model's
exact benchmark numbers side by side, and `LOCAL_AI_STATUS.md`'s Phase 5
session entry for live co-residency measurements against the existing GPU
models (`document-qa`/`image-caption`/`transcribe`).

**`vitpose-plus-base` is a mixture-of-experts checkpoint** — the bridge
always requests the COCO-pretrained expert (`dataset_index=0`) internally;
this is not exposed as a request parameter (no current use case for the
other 5 experts). It is also genuinely top-down (requires a box at the
image-processor level, confirmed by reading the processor's own source, not
assumed) — there is no way to run it on a full image without *some* box,
which is why `/vitpose-pose` supplies a full-image default rather than
requiring the caller to always pass one.

**CLIP image memory, scoped (2026-08-13)**: `/clip-embed` exposes the raw
embedding primitive the master plan's "CLIP image memory" bullet names. A
genuine persistent embedding store/retrieval layer on top of it (storage
format, indexing, integration with the existing memdir/all-minilm
text-memory system or a new one) is a separate, substantial design decision
that was **not** built this dispatch — flagged for the project owner as a
later, explicitly-scoped effort, not half-built here. See
`LOCAL_AI_STATUS.md`'s Phase 5 session entry for the full reasoning.

Extending this table is `python-bridge-agent`'s responsibility whenever a
new route is added — see that agent's own Architecture rules for the
lazy-load-singleton pattern every route follows (now: register a
`ModelSpec` with the shared `local_models.manager` rather than a private
per-module singleton — see `python-bridge/README.md`'s "Adding another
model" section).

**Consumer side status (2026-08-13, tools-execution-agent):**
`VisionAnalyzeTool` (`src/tools/VisionAnalyzeTool/`) is built and registered
against this exact contract (request/response shapes above, verbatim,
including forwarding `threshold` as `undefined` when the caller omits it so
the bridge's own per-route defaults apply). A shared HTTP client + 404/400
error-mapping helper (`src/tools/shared/visionBridge.ts`) backs all seven of
its operations (the six routes above plus the pre-existing `/image-caption`,
folded in as the `"caption"` operation — see §2's table entry for the
fold-in decision and reasoning), mirroring `audioBridge.ts`'s exact shape so
the `{"detail": "..."}` FastAPI error-body parsing and the 404→"not
found/unsupported format" / 400→"rejected the request: `<detail>`" mapping
live in exactly one place. Mocked tests cover all seven operations plus
error handling (`VisionAnalyzeTool.test.ts`); `VisionAnalyzeTool.live.test.ts`
synthesizes its own test images at run time via the bridge's own venv
Python + PIL (a shapes image using the exact same shapes/coordinates
session 23/24 used bridge-side, for classify/segment/detect; a real Windows
wallpaper for embed/embed-dinov2; a synthesized stick-figure drawing for
pose, honestly caveated the same way `vitpose.py`'s own docstring is, since
no real human photo exists on this machine) rather than depending on a
checked-in binary fixture — see `LOCAL_AI_STATUS.md`'s Phase 5 tool-side
session entry for live-verification results per operation.

---

## 4. Not yet implemented / planned
> `tools-execution-agent` adds entries here as new tools are built.

`AudioAnalyze`/`TranscribeAndSummarize` (Phase 4) shipped 2026-08-13; see
§2's table and §3's "Consumer side status" note above. `VisionAnalyze`
(Phase 5) shipped 2026-08-13; see §2's table and §3's Phase 5 "Consumer side
status" note above — nothing outstanding for Phase 5. Nothing currently
outstanding in this section.
