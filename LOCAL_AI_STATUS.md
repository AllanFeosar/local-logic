# Local AI Integration — Status (as of 2026-08-11)

This document is a handoff summary for continuing this work in a fresh
Claude Code session. Read this first before touching anything below.

The long-range roadmap (full model inventory, capability tiers, memory
budget, phased integration plan) lives in
[LOCAL_AI_MASTER_PLAN.md](LOCAL_AI_MASTER_PLAN.md) — this file tracks
what is *actually built and verified*; that one tracks where it's going.

## The goal

Combine several small, locally-downloaded AI models ("low-GB combo") into
this project (`openclaude-main`), orchestrated via tool-calling, so a
router model can delegate narrow tasks to purpose-built specialists instead
of one generalist model doing everything.

**Calibrated goal (important — this was explicitly corrected mid-session):**
this is NOT about beating frontier models (GPT-5/Opus/Gemini-class) on
general capability — that's not realistic with sub-4B local models and
shouldn't be pursued as a goal. It IS realistic to match or beat a frontier
model on the *specific narrow task* each specialist was built for
(extractive QA, image captioning, math computation, embedding retrieval),
at near-zero cost, fully offline. Frame future work around that, not
"overcome top-tier AI" generally.

## Hard boundary — do not violate

`openclaude` (no "-main" suffix, sibling directory
`E:\Allan Project\Git Repo Project\openclaude`) is the user's normal daily
driver for cloud providers (Anthropic, etc.). **Never modify it for this
work.** All local-AI experimentation belongs exclusively in
`openclaude-main`. This was violated once earlier in the project's history
and had to be fully reverted — don't repeat that.

## Architecture

- **Router**: `qwen3:1.7b` via Ollama — has verified reliable native
  tool-calling. Drives the conversation, decides when to delegate.
  Configured in `.openclaude-profile.json` (`OPENAI_MODEL=qwen3:1.7b`,
  `OPENAI_BASE_URL=http://localhost:11434/v1`).
- **Math specialist**: VibeThinker-3B, invoked ONLY through the
  `AskMathModel` tool (`src/tools/AskMathModelTool/`) — never as the main
  model. It does not reliably support native tool-calling itself (proven
  via testing: hallucinates wrong XML tags instead of populating
  `tool_calls`). The tool does a raw completion call to Ollama and strips
  the `<think>` trace before returning.
- **Extractive QA**: DistilBERT (`distilbert-base-cased-distilled-squad`)
  via `DocumentQATool` → the Python bridge (`python-bridge/`).
- **Image captioning**: BLIP (`blip-image-captioning-large`) via
  `ImageCaptionTool` → the same Python bridge.
- **Memory retrieval**: all-minilm embeddings pre-filter large memory
  directories (>15 files) before handing off to the existing Sonnet-based
  selector in `src/memdir/findRelevantMemories.ts`. Fails open (falls back
  to full list) if Ollama/all-minilm is unreachable.
- **Not yet wired**: Qwen3-Reranker-0.6B (downloaded, pulled into Ollama,
  unused — pairs naturally with the embedding pre-filter for real two-stage
  retrieval). ~20 other downloaded HF models (TAPAS table-QA, Whisper STT,
  CLIP, TabPFN, VideoMAE, clipseg, owlv2, dinov2, vitpose, musicgen,
  stable-diffusion, etc.) in `C:\Users\allge\AI Models\huggingface\` —
  none wired up.

## Critical operational fact

`bin/openclaude` runs the **compiled** `dist/cli.mjs`, never live
`src/`. **Any change to `src/` requires `bun run build` before it takes
effect** when running `node bin/openclaude`. This tripped up testing once
already — don't skip it.

Also required to be running for any of this to work:
- Ollama (`http://localhost:11434`) — normally runs as a background
  service, should already be up.
- The Python model bridge — NOT auto-started. Run
  `python-bridge/start.ps1` after a machine restart. It reuses the
  Debate project's venv (`E:\Allan Project\Debate Project\Debate\backend\venv`)
  rather than a fresh install — see `python-bridge/README.md`.

## Bugs found and fixed this session (don't reintroduce)

1. **Bun's hardcoded 300s fetch timeout.** Fixed using the codebase's own
   `createCombinedAbortSignal` (`src/utils/combinedAbortSignal.ts`) — NOT
   `AbortSignal.any([sig, AbortSignal.timeout(ms)])`, which does not
   reliably override Bun's default. The codebase has a comment documenting
   exactly why (`AbortSignal.timeout` timers are finalized lazily under
   Bun).
2. **Stale dist build** — see above.
3. **`shouldDefer: true` risk** — new tools were initially deferred
   (ToolSearch-gated), matching the base app's convention for less-common
   tools. Changed to `shouldDefer: false` for all 3 new tools: the
   `defer_loading`/`tool_reference` mechanism is Anthropic-Messages-API
   beta plumbing of uncertain behavior once translated through
   `openaiShim.ts` to Ollama, and a 1.7B router is a poor bet to
   spontaneously call `ToolSearch` for a tool it doesn't know exists.
4. **Ollama+Qwen3 `/think` template bug** (found via live testing, not
   obvious from code). Ollama's chat template appends a literal `" /think"`
   suffix to the last user turn when think-mode is on. For terse prompts
   ("847 x 293") this is textually ambiguous and the model sometimes
   misreads it as an incomplete division, producing a wrong/confused
   answer. Fixed in `openaiShim.ts`'s `_doOpenAIRequest`: adds
   `body.think = false` when the target is a local provider URL AND the
   model is not one of the tool-call-recovery-listed models (so
   VibeThinker's own reasoning, invoked separately, is untouched).
   Architecturally this is also the *right* default, not just a
   workaround — the router shouldn't need deep reasoning, that's what
   delegation is for.
5. **Accidentally broke the Debate project's venv** mid-session — installing
   `torchvision` without pinning pulled a `torch` upgrade, and a file lock
   (my own bridge server had torch loaded) caused a failed uninstall that
   corrupted `torch`. Caught immediately and fully repaired: reinstalled
   `torch==2.12.1+cpu` exactly, reinstalled `torchvision`/`pillow` with
   `--no-deps` this time, cleaned up pip debris, verified Debate's own
   `claimbuster.py` still runs. **Lesson: always pin versions and use
   `--no-deps` when adding packages to a shared/reused venv.**
6. **transformers v5.12.1 dropped `pipeline("question-answering")`.**
   `local_models/document_qa.py` does manual span extraction via
   `AutoModelForQuestionAnswering`/`AutoTokenizer` instead.
7. **transformers v5.12.1's `AutoProcessor`/`pipeline("image-to-text")`
   failed on BLIP** with a confusing "unrecognized image processor" error.
   Root cause: missing `torchvision`/`pillow` in the reused venv (that
   project never needed images). Fixed by installing those deps AND
   loading BLIP's concrete classes (`BlipProcessor`/
   `BlipForConditionalGeneration`) directly instead of through Auto*/
   `pipeline()`.
8. **The "backend"/"C# core" startup-banner lines showing "Not running"
   are cosmetic, not a real issue.** Leftover from an abandoned 3-tier
   migration (Node "LlmBackend" + C# "core" + thin CLI, tied to the old
   `mcp-openclaude` project — see `src/config/integrationConfig.ts`'s own
   comment). No `LlmBackend` folder or `.csproj` exists anywhere in this
   repo. Doesn't affect anything — the working path is the third "local"
   banner line, straight through Ollama.

## Verification performed (all live against real models, not just mocks)

- `AskMathModel`: `17 * 23` → correct (391) in 16.9s.
- `DocumentQA`: correctly extracted "blue" (0.995 confidence) from a real
  passage.
- `ImageCaption`: correctly captioned a real image.
- `embeddingPreFilter`: correctly ranked the relevant memory #1 among 18
  candidates for a coding-error query.
- `think: false` fix: verified clean/correct across repeated runs, through
  the actual `openaiShim.ts` code path.
- Typecheck: exactly matches the pre-existing baseline (4130 errors, all
  pre-existing staleness unrelated to this work — openclaude-main is a much
  older fork than `openclaude`). Zero new errors from anything built this
  session.
- Fast test suite: 42/42 passing across 8 files.

## Session 2 (2026-08-12) — re-verification findings

The Phase-0 REPL re-verification this doc asked for turned up a real
problem: **bug #4's `/think`-suffix fix never actually worked.**
`body.think = false` is a native-Ollama-API field and is silently ignored
on Ollama's OpenAI-compatible `/v1/chat/completions` endpoint (confirmed
live, repeatedly, against Ollama 0.32.8 — the visible `reasoning` trace and
the suffix corruption were both still present with `think: false` in the
request body). Last session's "verified clean/correct across repeated
runs" claim did not hold up under fresh testing and no test ever covered
it (`grep think openaiShim.test.ts` — zero matches), which is how this
went unnoticed. Root cause and fix confirmed against Ollama's own tracked
issues: https://github.com/ollama/ollama/issues/14820 and
https://github.com/ollama/ollama/issues/15288 — the OpenAI-compat endpoint
maps `reasoning_effort` (not `think`) to the internal think state. **Fixed**
in `openaiShim.ts`'s `_doOpenAIRequest`: now sends both `think: false`
(harmless no-op on Ollama, kept for other local servers like LM Studio that
may honor it) and `reasoning_effort: 'none'` (the field Ollama's OpenAI
shim actually reads). Verified clean across repeated live calls with no
test coverage gap this time — a regression test is in flight.

Also tightened `AskMathModelTool`'s description (`src/tools/AskMathModelTool/prompt.ts`):
the original "don't delegate trivial arithmetic (e.g. 12*7)" carve-out was
being applied too broadly by the 1.7B router, causing it to self-compute
3+ digit multiplication it can't reliably do. Sharpened the threshold
explicitly (both operands ≤2 digits = trivial, 3+ digits = always
delegate).

**Bigger finding, not yet fixed — needs your call before proceeding:**
even after both fixes above, delegation is still unreliable, and the
reason looks structural rather than a small prompt tweak. Live-testing
"12 x 7" produced a tool call to `Skill` with `skill: "math"` — there is
no "math" skill; the actual skill list is `update-config, debug, simplify,
batch, agent-team-scaffold, graphify`. The router reached for a
plausible-sounding but nonexistent tool instead of the real
`AskMathModel` sitting right there in its own tool list, and also passed
malformed arguments (`args` as an object where a string was required).
This session's tool list is ~65 entries (the ~25 built-ins plus ~40 tools
across the newly-added mempalace/lmstudio/graphify MCP servers) —
dramatically more than the ~10 the router was validated against
originally. This matches, almost exactly, the routing-degradation risk
called out in `LOCAL_AI_MASTER_PLAN.md` §6 before any of this MCP tooling
existed. Likely not fully fixable by more prompt tweaking alone; the
plan's own mitigations (domain-gateway tools, semantic tool pre-filtering,
router upgrade to qwen3:4b) are the real answer, but implementing those
touches tool-selection behavior project-wide, not just the local-AI
specialists, so it's flagged for a decision rather than done unilaterally.
See the question list relayed separately.

### Session 2 — completed this pass

- **Qwen3-Reranker-0.6B wired into genuine two-stage retrieval**
  (`src/memdir/rerank.ts`, new). Implements the real logprob-based
  pointwise scoring from Qwen3-Reranker's reference approach (not a lazy
  numeric-rating fallback) — requests a single output token with wide
  `top_logprobs` from Ollama's `/api/generate`, reads back "yes"/"no"
  probability mass, softmax-normalizes. Uses `raw: true` to supply its own
  chat-template prompt directly, which sidesteps the `/think`-suffix bug
  class entirely (no Ollama template auto-injection in raw mode). Wired
  into `findRelevantMemories.ts` as a second narrowing pass after the
  embedding pre-filter (top 20 → top 10) before Sonnet's final selection.
  Fails open like the embedding pre-filter. `bun test src/memdir`: 21/21
  pass, including a live test against the real reranker model.
- **Bridge model manager** (`python-bridge/local_models/manager.py`, new).
  Budget cap + LRU eviction, single-flight loading, heavy-model
  exclusivity flag (mechanism only — no heavy models registered yet),
  device-placement stub (informational, CPU-only enforced regardless —
  real CUDA placement is still an explicit separate decision, see
  question list), and a `/status` endpoint. RSS is read via raw `ctypes`
  calls to `kernel32`/`psapi` — deliberately not `psutil`, to avoid any
  risk to the shared/borrowed Debate venv. `document_qa.py` and
  `image_caption.py` now route through the manager; both routes
  re-verified working identically to before.
- **Eval harness** (`scripts/eval/`, new — `specialistEval.ts`, `cases.ts`,
  `README.md`, `npm run eval:specialists`). Runs real test cases against
  the live specialists (4 math, including a word problem beyond raw
  arithmetic; 4 DocumentQA, including a deliberately unanswerable
  question that correctly scored low confidence (0.056) rather than a
  confident wrong answer; 2+ image-caption cases) and writes
  `reports/eval-specialists.{json,md}`. Frontier-comparison column is
  left blank by default — no live paid API call happens unless run with
  an explicit `--frontier` opt-in, so nothing here can silently spend
  money.
- **Full-suite test triage**: `bun test` from the project root shows
  340 pass / 22 fail. All 22 were individually traced and confirmed
  unrelated to any change made this session or last: 10 are in
  `vscode-extension/` (separate npm package, missing the `vscode` module
  in this environment); 2 are the `providerConfig.ts` codexplan-alias bug
  and the `withRetry.ts` rate-limit-header bug documented above (proven
  pre-existing via revert-and-rerun against the untouched tree by two
  independent agents); 6 are `applyProviderFlag`/`remoteAgentService`
  tests polluted by this project's own pre-existing `.env` file (has a
  live NVIDIA NIM API key/model/base-URL configured, which `bun test`
  auto-loads — confirmed this does NOT leak into actual CLI runtime,
  `.openclaude-profile.json`'s ollama profile correctly wins there); the
  remaining 4 are live Ollama/bridge tests that pass cleanly when run in
  isolation (transient resource contention when many live-model tests
  hit the same local Ollama instance concurrently during a full-suite
  run) except `toolCallRecoveryIntegration.test.ts`'s live-model
  assertion, which is already-documented model-generation variance on
  the non-load-bearing `toolCallRecovery.ts` safety net (see below).

### Open items for next session

- Extend `python-bridge/` to more of the ~20 unused downloaded models —
  now via `manager.py`'s `ModelSpec` pattern (see its module docstring)
  rather than the old hand-rolled lazy-load-global pattern. Tier A next:
  TabPFN, TAPAS, Chronos (all small, no GPU needed).
- The Python bridge's torch build is CPU-only (no CUDA in the reused
  venv) — fine for the models wired so far, but the GPU sits completely
  idle (RTX 3050, 4GB VRAM, confirmed available). Needs a dedicated venv
  to use — explicit decision needed, see question list, not done this
  session on purpose (this exact kind of shared-venv operation broke
  things once already per bug #5 above).
- `toolCallRecovery.ts` (VibeThinker tool-call recovery) is fully built and
  tested but not load-bearing in the current architecture — VibeThinker is
  never asked to call tools itself anymore, only invoked for plain-text
  math completions. Kept as a safety net in case that changes. Its one
  live integration test shows normal run-to-run variance on the model's
  exact output shape — expected, not a regression.
- **Security review complete** (read-only audit of every new/changed
  surface this session). No HIGH or MEDIUM findings. `isLocalProviderUrl`
  confirmed not security-relevant and not spoofable in any way that
  matters (traced every call site — never gates credentials or auth).
  `rerank.ts`'s network calls confirmed safe (no auth headers, no
  credentials, fails open, response handling defensive throughout).
  `manager.py`'s raw `ctypes` RSS reader confirmed correct and memory-safe
  (struct layout, sizes, restype/argtypes, and return-value checking all
  verified against the Win32 API contract). Bridge confirmed bound to
  `127.0.0.1` only, `/status` confirmed to leak nothing sensitive (no
  paths, env vars, or credentials in its payload). Eval harness confirmed
  to make zero live paid API calls without explicit `--frontier`, and
  separately confirmed `AskMathModelTool` uses its own
  `MATH_MODEL_BASE_URL` (always local Ollama) rather than `OPENAI_BASE_URL`,
  so even the `.env` NVIDIA-key pollution mentioned above can't reach a
  paid provider through it.
  One LOW finding, since fixed: `/image-caption` had no auth and let a
  caller distinguish "file doesn't exist" (404) from "file exists but
  isn't a loadable image" (previously an unhandled 500) — a filesystem
  existence oracle for an unauthenticated local endpoint, compounded by
  DNS rebinding being possible against a loopback-only service with no
  `Host` validation. Fixed: both cases now return an identical generic 404
  (`server.py`, `image_caption.py`), and a `Host`-header check middleware
  rejects anything not addressed to `127.0.0.1`/`localhost` (`server.py`).
  Both verified live — legitimate routes still work identically, a
  spoofed `Host` header now gets 403, a non-image existing file now gets
  the same 404 as a missing one. The broader "confine `image_path` to an
  allowlisted root directory" recommendation was deliberately **not**
  implemented — the tool's whole purpose is captioning arbitrary
  user-pointed local images, so an allowlist is a real design decision
  (which roots?), not a mechanical fix; see question list.
  Also fixed: `.gitignore` had no pattern for the bridge's `*.log` files,
  so they showed as untracked-and-committable (contents checked, no
  secrets, just machine paths/username, but no reason to risk it).
  Separately, the audit independently re-confirmed (a third time, by a
  different, read-only agent, via the same revert-and-rerun style
  evidence) that the `providerConfig.ts`/`withRetry.ts` failures are
  pre-existing, and identified a related but distinct process bug worth
  fixing eventually: `bun test`'s `test:provider` gate is not hermetic
  (inherits the root `.env`, which is what actually breaks those two
  tests on this machine) and includes a live 90-second VibeThinker call
  with self-documented nondeterministic output in what should be a
  deterministic gate. Not fixed this session (out of scope — provider-
  router-agent's test infrastructure, not the local-AI plan) but flagged
  for whoever picks that up next: make the affected tests set their own
  provider env explicitly, and move the live tool-call-recovery assertion
  behind the same opt-in `*.live.test.ts` convention already used
  elsewhere in this repo.
- While restarting the bridge to verify the security fixes, found and
  cleaned up two stray `server.py` processes running simultaneously — one
  against the correct Debate venv, one against an unrelated system Python
  install at `C:\Users\allge\AppData\Local\Programs\Python\Python311\`.
  Killed both, restarted cleanly through the one correct path. Not
  investigated further where the second one came from (likely a stray
  manual run during today's agent work) — worth a glance if it recurs.

## Session 3 (2026-08-12, provider-router-agent) — routing eval built, measured, two mitigations tried

Executed the reordered Phase 0/1 plan from `LOCAL_AI_MASTER_PLAN.md` §6/§8.
Full detail below; summary: **the routing eval is real and reproducible
(35.0% across three separate runs), MCP-scoping fixed latency/reliability
but not accuracy, and the single largest failure mode turned out to be
something the plan didn't anticipate — the router going completely silent
(zero output tokens) on certain prompts, not just picking the wrong tool.**

### Built: the routing eval (`scripts/eval/routingEval.ts`, `routingCases.ts`)

20 fixed prompts (5 math / 5 DocumentQA / 5 ImageCaption / 5 no-tool-needed
distractors), run through the real compiled CLI
(`node bin/openclaude -p "<prompt>" --output-format stream-json --verbose`),
scored purely on whether the router's *first* tool_use block matches the
expected tool (or correctly calls none) — independent of whether the
specialist would have answered correctly. Kills the child process as soon as
the router's decision is visible in the JSONL stream (doesn't wait for the
specialist to finish), so a 20-case run takes seconds-to-low-minutes instead
of the 15s-5min a full AskMathModel round trip can take. `bun run
eval:routing`.

**Baseline: 7/20 correct (35.0%)**, reproduced identically (same 7 correct,
same failure distribution) across three separate full runs at different
points in the session. Breakdown: ImageCaption 5/5 correct; AskMathModel
0/5 (4 silent, 1 wrong-tool); DocumentQA 0/5 (mostly silent, 2 wrong-tool
`Read`); distractors 2/5 (2 hallucinated `Skill{skill:"math"}` calls for
trivial arithmetic — the exact bug reported in Session 2 — plus one
`ImageCaption` called on a plain conversational prompt).

### Mitigation 1 — scope MCP servers out of the `ollama` profile (implemented)

Added `OPENCLAUDE_DISABLED_MCP_SERVERS` (comma-separated server names) as a
new field in `.openclaude-profile.json`'s `env` — profile-scoped, not
global: `src/services/mcp/config.ts`'s `isMcpServerDisabled()` now also
checks this env var, and `src/utils/providerProfile.ts`'s `buildLaunchEnv()`
only carries it through for the `ollama` branch (explicitly cleared for
every other profile). `.openclaude-profile.json`'s `ollama` profile now sets
it to `mempalace,lmstudio,graphify`. Confirmed via the CLI's own init event:
tool count dropped from 71 (24 built-ins + 47 MCP tools) to 23 built-ins,
`mcp_servers` shows all three as `"status":"disabled"`, and every other
profile (openai/codex/gemini/atomic-chat) is unaffected.

**Result: score unchanged at 7/20 (35.0%)**, but per-case latency dropped
roughly 2-3x (most cases 7-25s → 3-4s) since three MCP stdio subprocesses no
longer spin up and tear down on every single CLI invocation — a real
reliability win (eliminates a class of resource-contention-driven flakiness
this session hit early on) even though it didn't move tool-selection
accuracy. Matches the master plan's own caveat that this "may just buy
headroom before the next steps are needed."

### Mitigation 2 — tool-name validation net (found already implemented, doesn't cover the dominant failure modes)

`src/services/tools/toolExecution.ts` already rejects calls to tool names
that aren't in the registered list at all
(`<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
confirmed by reading that code — not modified, it's tools-execution-agent's
file, not provider-router-agent's). This satisfies item 3 as literally
scoped, but it doesn't touch any of the four failure patterns the baseline
actually shows: silent/empty turns, the router picking a *real* wrong tool
(`Read`, `ToolSearch`, `Grep`), or `Skill` being called with a fabricated
skill name (`Skill` itself is a real, registered tool — only its `skill`
argument is hallucinated, which is validated, if at all, inside the Skill
tool's own runtime logic, not at the tool-name layer). Concluded no further
work was needed/appropriate here this session.

### Mitigation 3 — semantic tool pre-filtering: deferred, not attempted

Per the master plan's own framing ("the biggest, riskiest change in this
list — only attempt if 2-3 didn't get the eval score high enough"), and
given: (a) mitigations 1-2 didn't move accuracy, satisfying that trigger
condition, but (b) this touches the shared tool-list-construction path used
by *every* provider, not just local ones — a mistake here has a much bigger
blast radius than anything else in this session's changes — and (c) session
time budget didn't leave room to build and adequately verify it with the
care that risk deserves. **Recommended next step**, not done. Deferred
cleanly: nothing half-built, nothing landed that needs finishing.

### New finding not anticipated by the plan: silent (zero-token) completions, not just wrong-tool selection

8 of the 20 baseline cases (all classified `no-tool-called`) weren't the
router picking a wrong tool — they were the router producing **zero output
tokens** and no text either: `"result":"", "stop_reason":"end_turn",
"usage":{"output_tokens":0,...}`, `is_error:false`, ~1-3s. Verified
reproducible: `curl`ing Ollama directly with the same prompt but a minimal
1-tool payload (not the full system prompt) returns a correct native
`tool_calls` response every time; something about the *full* production
request (real system prompt + full tool list, `reasoning_effort:"none"`)
occasionally makes qwen3:1.7b emit nothing at all for certain
multi-digit-math-shaped prompts specifically (not general prompts — "Say the
word banana"/"hi" never reproduced this). Not root-caused this session (out
of time budget; plausibly an Ollama/qwen3 quirk under this exact request
shape, not obviously a bug in this codebase's request construction) — this
is the single largest failure category in the eval and the top recommended
follow-up, ahead of semantic pre-filtering, since no amount of tool-list
trimming fixes a turn that produces no output at all.

### Two "pre-existing bugs" — root-caused as one hermeticity issue, not two logic bugs

Both `codexShim.test.ts`'s `codexplan` transport-resolution test and
`withRetry.test.ts`'s `anthropic-ratelimit-unified-reset` test were
reported as bugs in `providerConfig.ts`/`withRetry.ts`. Traced precisely:
both pass with **zero source changes** once the root `.env` (auto-loaded by
`bun test`, has `CLAUDE_CODE_USE_OPENAI=1`/`OPENAI_MODEL=qwen/qwq-32b`/
`OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1`) is excluded
(`bun test ... --env-file=/dev/null`). `providerConfig.ts`'s "custom
`OPENAI_BASE_URL` always wins over Codex-alias detection" is intentional,
documented behavior (`#200`/`#203` comment) — the ambient `.env`'s
`OPENAI_BASE_URL` was legitimately triggering it, not a bug. Same story for
`withRetry.ts`'s `getRateLimitResetDelayMs`: `getAPIProvider()` correctly
returns `'openai'` (not `'firstParty'`) once `CLAUDE_CODE_USE_OPENAI=1` is
set — also correct, intentional behavior. **Fixed by making the two
specific tests hermetic** (explicit env clear/restore around the assertions
that depend on ambient absence) rather than touching either source file —
see `src/services/api/codexShim.test.ts` and `withRetry.test.ts`. Verified:
both pass identically with and without the polluted `.env` loaded.

### `test:provider` gate hermeticity

- `codexShim.test.ts` / `withRetry.test.ts`: see above.
- `toolCallRecoveryIntegration.test.ts`'s one live, ~90s+, self-documented
  nondeterministic VibeThinker call moved to a new
  `toolCallRecoveryIntegration.live.test.ts`, following this repo's existing
  `*.live.test.ts` convention (`src/memdir/rerank.live.test.ts` etc.).
  **Important nuance found while doing this**: that naming convention is
  documentation-only in this repo, not a mechanical exclusion — a bare `bun
  test` (no path args) and shell-glob-based scripts like the old
  `test:provider` (`bun test src/services/api/*.test.ts ...`) both still
  pick up `*.live.test.ts` files, since `*.test.ts` matches any suffix
  ending in `.test.ts`. Fixed `test:provider` in `package.json` to add
  `--path-ignore-patterns='**/*.live.test.ts'` (quoted, so the shell doesn't
  try to glob-expand it itself before bun sees it). Verified: `bun run
  test:provider` now runs 11 files / 89 tests in ~10-36s (no more 90s+ live
  call), same pass count as before.
- **Also found and fixed, not originally in scope but the same root cause**:
  `scripts/eval/routingEval.ts` spawns `node bin/openclaude` as a child
  process. Since `bun run <script>.ts` (unlike a plain shell) *always*
  auto-loads the project's own `.env` into its own `process.env` — this
  isn't a `bun test`-only behavior — blindly forwarding `process.env` to the
  spawned child made every eval case silently route through NVIDIA NIM
  instead of Ollama (`hasExplicitProviderSelection()` in
  `providerProfile.ts` sees `CLAUDE_CODE_USE_OPENAI=1` from `.env` and skips
  applying `.openclaude-profile.json` entirely). Fixed by having
  `routingEval.ts` explicitly clear the same provider-selection env vars
  before spawning. **Worth flagging generally**: any future script that
  does `bun run some-script.ts` and spawns `node bin/openclaude` (or
  anything else that reads `OPENAI_*`/`CLAUDE_CODE_USE_*`) as a child needs
  the same guard, or it will silently pick up this project's live NVIDIA key
  instead of the intended local profile.
- **Correction to a Session 2 claim**: Session 2 attributed
  `remoteAgentService.test.ts`'s 2 failures (part of "6 are
  applyProviderFlag/remoteAgentService tests polluted by `.env`") to `.env`
  pollution. Re-checked this session: they fail identically with `.env`
  fully cleared (`--env-file=/dev/null`). The real cause looks different —
  `remoteAgentService.test.ts` imports from `vitest` (`vi.mock`,
  `vi.clearAllMocks`), not `bun:test`, and is being executed via `bun test`
  regardless; a vitest/bun mocking-compatibility gap is a much more likely
  culprit than env pollution. Confirmed pre-existing either way (nothing
  this session or last touches `remoteAgentService.ts`/`backendClient.ts`)
  and out of scope to fix here — flagged as a more precise diagnosis for
  whoever does pick it up, not fixed.

### Delegation ledger (`src/delegationLedger.ts`, new)

Passive observer wired into `query.ts` right next to the existing
`observeToolUpdateForLearning` call (same contract: never blocks, rewrites,
or reorders a tool call; only watches the already-yielded `tool_result`
stream after the fact; never throws). Appends one JSON line per tool
delegation to `reports/delegation-ledger.jsonl`:
`{timestamp, tool, querySummary, outcome, latencyMs}`, where `querySummary`
is a SHA-256 hash (first 16 hex chars) of the triggering human message —
**never raw query text, and never tool arguments/results** (both can carry
sensitive content — verified via a test that asserts the raw query text
never appears anywhere in a logged entry). `outcome` is
`'success' | 'error' | 'hallucinated-tool'`, where `'hallucinated-tool'` is
detected by matching `toolExecution.ts`'s exact `"No such tool available:"`
wording in the tool_result content. `latencyMs` is elapsed-since-batch-start
(an approximation, documented in the code, since tools in one batch
typically execute concurrently). Tested in `src/delegationLedger.test.ts`
(9 tests: classification, hashing/no-raw-leak, query extraction skipping
tool-result-only turns, no-op cases, never-throws). Note: the routing eval
itself doesn't populate the ledger — it deliberately kills the child process
right after the router's tool_use decision, before any tool_result exists —
confirmed populated correctly via a real end-to-end `ImageCaption` run.

### Deferred without attempting: qwen3:4b-instruct A/B (item 8)

Not pulled/tested. The eval evidence this session points more toward (a) a
genuine silent-completion issue (see above) and (b) `Skill`-tool-argument
hallucination — neither of which is obviously "the router is too small to
choose among N tools," the specific hypothesis a 4b A/B would test. Given
time budget, prioritized measuring/documenting the actual failure shapes
over speculatively trying a bigger model against them.

## Session 3b (2026-08-12, python-bridge-agent + tools-execution-agent, run in parallel with the above) — CUDA venv, GPU migration, Phase 3 models, DataAnalyzeTool

**Dedicated CUDA venv built and is now the default** (`python-bridge/venv`,
never shared — the sharing risk from the old Debate-venv arrangement is
gone entirely, not just mitigated). `torch==2.12.1+cu130` /
`torchvision==0.27.1+cu130` (driver 610.88 reports CUDA UMD 13.3, comfortably
covers the cu130 wheel index), confirmed `torch.cuda.is_available()` is
`True`. `document_qa.py` and `image_caption.py` migrated to real
`device="cuda", fp16=True` placement (the old `manager.py` stub now
actually moves tensors, with automatic CPU fallback if CUDA is unavailable
at runtime) — fp16 output was compared side-by-side against the previous
fp32-CPU baseline for quality regression (not just speed) before being kept
as the default; none found. Caught and fixed a real, non-obvious issue
along the way: the `tabpfn` package pings an external telemetry endpoint on
construction unless explicitly disabled — confirmed via reading its source
and setting `TABPFN_DISABLE_TELEMETRY=1` before first import, verified live
(construction takes ~0.03s, no network activity). Also resolved a real
`huggingface-hub` version conflict between `tabpfn-common-utils` (wants
`<1`) and `transformers` 5.12.1 (needs `>=1.5`) by pinning to what
`transformers` needs and verifying (by reading `tabpfn`'s source) that its
own runtime path never exercises the incompatible branch — documented as a
deliberate, verified pin deviation in `requirements.txt`, not an oversight.

**Phase 3 routes wired**: `/tabular-predict` (TabPFN-v2, split into
`tabpfn-clf`/`tabpfn-reg` model specs), `/table-qa` (tapas-mini-finetuned-wtq),
`/forecast` (chronos-t5-tiny) — all `device="cpu"` per the plan (tiny
models, GPU reserved for BLIP/DistilBERT). All three live-verified working
end-to-end via `DataAnalyzeTool`.

**Quality spot-check finding (not a plumbing bug — flagging honestly since
this session has been consistently skeptical of unverified claims
throughout)**: TabPFN and Chronos both look genuinely correct on manual
spot-checks (TabPFN correctly classified well-separated clusters with
sensible confidence; Chronos produced sane trend continuations with
reasonable uncertainty bands). **TAPAS's answer quality looks weak on basic
cross-column conditional lookups** — "What is the revenue of Gadget?"
against a 3-row table incorrectly returned row 0's value (Widget's revenue,
not Gadget's); a same-column echo question ("which product is Gizmo") did
work. The route itself is mechanically correct (well-formed request/response,
matches the contract) — this looks like a real capability limitation of the
tiny `tapas-mini-finetuned-wtq` checkpoint, not an integration bug. Doesn't
block Phase 3's gate (which centers on TabPFN as the flagship "local beats
frontier" demo, not TAPAS), but worth knowing before leaning on `/table-qa`
for anything real — a small eval set for `DataAnalyze`'s `"question"`
operation specifically (mirroring `specialistEval.ts`'s pattern) is a
reasonable near-term follow-up.

**`DataAnalyzeTool`** (`src/tools/DataAnalyzeTool/`) — the master plan's
first real domain-gateway tool (§6 mitigation 2): one tool,
`operation: "question" | "predict" | "forecast"`, tool-facing schema is a
flat `ZodObject` with every per-operation field optional (not a top-level
discriminated union — this project's MCP conversion layer can't handle a
`oneOf`/`anyOf` JSON Schema root for `outputSchema`, and a flat schema with
an enum field is also the better bet for a small local tool-calling model
to generate correctly), with a discriminated union used internally only for
precise per-operation validation errors. `predictTask.ts`'s
classify-vs-regress inference (when the caller doesn't specify `task`
explicitly) uses a documented "looks discrete" heuristic on the label data,
with its own edge-case caveats written into the tool's own prompt so the
router knows when to specify `task` explicitly instead of relying on
inference. Live-verified end-to-end against all three real bridge routes.

## Combined final verification (all three parallel streams merged)

`bun run build`: clean. Full `bun test`: 371 pass / 23 fail — every one of
the 23 individually traced: 10 `vscode-extension` (separate npm package,
pre-existing), 4 `applyProviderFlag` (`.env` pollution, pre-existing,
unrelated file not touched this session), 2 `remoteAgentService`
(pre-existing, re-diagnosed this session as a vitest/bun mocking
compatibility gap rather than `.env` pollution as previously assumed — see
above), 2 the relocated VibeThinker live tests (expected occasional
nondeterminism, no longer sitting inside a deterministic gate), and 5 "real
bridge" tests that **pass cleanly when re-run in isolation** — confirmed
transient resource contention from many live tests hitting the same single
local Ollama/bridge instance concurrently during a full-suite run (the
same pattern session 2 already established, now reconfirmed). Zero of the
23 trace to a real regression from any of this session's three parallel
streams.

## Session 4 (2026-08-12, tools-execution-agent) — DataAnalyzeTool eval: TAPAS/TabPFN/Chronos quantified for real

Built `scripts/eval/dataAnalyzeEval.ts` / `dataAnalyzeCases.ts`
(`bun run eval:data-analyze`) — turns Session 3b's anecdotal one-off
spot-checks into real, quantified, ground-truth-checkable results. Every
case has a locally-computable objective answer (the tables/synthetic data
were authored for this eval), so no frontier column is needed or
meaningful here. Run live twice against the real bridge; pass/fail counts
identical both times.

- **`"question"` (TAPAS): 6/8.** Same-column lookups 2/2 (solid).
  Cross-column lookups 3/4 — better than the single spot-check suggested,
  but it exactly reproduces that original failure ("revenue of Gadget"
  still returns the wrong row). Aggregation 1/2 — the weakest category;
  the exact "which product has the highest revenue" case from Session 3b
  still fails. Net: TAPAS's weakness is real but uneven, not a blanket
  failure — solid on direct lookups, unreliable on cross-column and
  aggregation questions specifically. Sample sizes are small (n=2-4 per
  category) — real signal, not a precise rate.
- **`"predict"` (TabPFN): 3/4.** Both classification cases passed cleanly
  with >99% confidence on the correct class. The regression case failed
  specifically at extrapolation distance from the training range (in-range
  and near-range test points were fine; far-out-of-range ones weren't) —
  reads as a genuine, expected model characteristic, not a bug. Matches
  Session 3b's "TabPFN looks correct" finding, now with a quantified
  caveat about extrapolation.
- **`"forecast"` (Chronos): 1/3 — correction to a Session 3b claim.**
  Session 3b's spot-check said "Chronos produced sane trend
  continuations"; this eval found that's not reliably true. Uncertainty
  bounds are solid on all 3 cases every run (always contain the point
  forecast, never zero-width or absurd — the plumbing/route is correct,
  independently confirmed by reading `forecast.py` against the model's
  documented usage). But **both linear-trend cases failed on the point
  forecast itself** — the model tends to plateau near the last observed
  value instead of confidently continuing an obvious trend (a series
  ending at 20 with a clear +2/step pattern forecasts ~18-20 flat, not
  ~22/24/26). Reproduced on both runs — not a fluke. Plausible explanation:
  a documented characteristic of trajectory-sampling forecasts from an
  8M-parameter checkpoint over a very short context window, not a wiring
  bug. **This measurably narrows the "Chronos genuinely correct" claim
  from Session 3b** — the uncertainty quantification is trustworthy, the
  point forecast on a clear trend is not.

Open questions this raises (not resolved, for the project owner):
whether `/table-qa` should be deprioritized for aggregation-style
questions specifically (same-column lookups are fine); whether the
Chronos trend-underforecast finding needs its own follow-up or whether
leaning on the (correct) uncertainty bounds rather than the point
forecast is an acceptable mitigation for now.

## Session 5 (2026-08-12, provider-router-agent) — silent zero-token completion bug: root-caused and fixed

Picked up Session 3's top open item directly. Reproduced the bug
deterministically first (`bun run eval:routing --case routing-math-1`
through the compiled CLI), then root-caused it by proxying the real Ollama
traffic (a small logging reverse-proxy inserted via a temporary
`OPENAI_BASE_URL` edit, reverted after) to capture the **exact** production
request byte-for-byte, and replaying that captured request directly against
Ollama's own endpoints with controlled variations — rather than guessing
from the app layer.

### Root cause

The full production request (real system prompt incl. the "auto memory"
instructions + environment block + ~13 visible tool definitions after
MCP-scoping/deferral) is **~15,592 tokens**. Ollama's default `num_ctx` for
`qwen3:1.7b` on this install is **4096** (confirmed via `/api/ps`'s
`context_length` field on a freshly-loaded default model) — nowhere close
to enough. Ollama's OpenAI-compatible `/v1/chat/completions` endpoint does
not error on overflow; it **silently truncates** the prompt to fit
(confirmed: `prompt_tokens` in the response came back as ~2050, roughly
half of `num_ctx`, regardless of the true ~15.6k-token input), and the
mangled remainder the model actually sees sometimes produces zero
parseable output (the observed bug), sometimes a plausible-looking but
wrong tool call (explains Session 3's `Read`/`Skill` hallucinations too —
same root cause, different truncation luck). Directly confirmed the fix
works by baking a larger `num_ctx` into a custom Ollama model tag and
replaying the *exact same captured request* against it: correct native
`AskMathModel` tool_calls, repeatably. `reasoning_effort:'none'` was tested
and ruled out as a contributing factor (removing it, i.e. leaving thinking
on, still produces correct output even under truncation — the *presence*
of truncation is what matters, not the think setting); the earlier
`/think`-suffix fix was left untouched and its regression tests still pass.

### Fix

Ollama's OpenAI-compat endpoint has no per-request context-length override
(tested: neither a top-level `num_ctx` nor an `options.num_ctx` field has
any effect on `/v1/chat/completions`) — `num_ctx` must be baked into the
model via `ollama create`. Built `qwen3-router:1.7b` (a previously-existing
but unused/orphaned tag from an earlier abandoned attempt, cleanly
recreated) with `PARAMETER num_ctx 40960` (matching the base model's real
native `context_length`) and `PARAMETER think false` (redundant with the
per-request `think`/`reasoning_effort` fields already sent by
`openaiShim.ts`, kept for belt-and-braces). `.openclaude-profile.json`'s
`OPENAI_MODEL` now points at this tag instead of bare `qwen3:1.7b`.

**A second, non-obvious bug surfaced and got fixed along the way**: simply
declaring the model's now-accurate context window in
`src/utils/model/openaiContextWindows.ts` (for the CLI's own auto-compact
warning/threshold logic) *without* also declaring its max-output-tokens
entry made the CLI trigger auto-compaction before every single routing
turn — `getEffectiveContextWindowSize()`'s reservation formula
(`contextWindow - min(getMaxOutputTokensForModel(model), 20_000)`, minus
`AUTOCOMPACT_BUFFER_TOKENS(13_000)`) goes deeply negative when the model
falls through to the generic 32k output-token default, so *any* token
usage looked like it was over threshold — confirmed live (every routing-eval
case hung on a `"compacting"` status, itself trying to reprocess the same
oversized prompt, blowing well past reasonable turn latency; first attempt
at fixing this by reverting the context-window declaration entirely was
tried, then correctly overridden mid-task once the real two-part fix was
traced through the actual formula in `autoCompact.ts`). Fixed by adding
**both** `OPENAI_CONTEXT_WINDOWS['qwen3-router:1.7b'] = 40_960` and
`OPENAI_MAX_OUTPUT_TOKENS['qwen3-router:1.7b'] = 4_096` together (a
tool-dispatch router doesn't need anywhere near 32k output tokens) —
verified live afterward, no compaction hang, correct tool calls, and the
full routing eval run clean end to end. See that file's own comments for
the complete math.

No `src/services/api/openaiShim.ts` change was needed — the entire fix
lives in Ollama's own model config (`ollama create`) plus this project's
provider-profile file plus the context-window lookup table. This also
means every existing `openaiShim.test.ts` regression test (including the
`/think`-suffix ones) passes completely unchanged.

### Result: routing eval 35.0% → 70.0%, zero silent completions remaining

`reports/after-silent-completion-fix/eval-routing.{json,md}` vs
`reports/baseline/eval-routing.md` (35.0%, 7/20) and
`reports/final/eval-routing.md` (Session 3's end-of-session re-run, same
35.0%). New score: **14/20 (70.0%)**. Breakdown: AskMathModel 4/5 (was
0/5), DocumentQA 3/5 (was 0/5), ImageCaption 5/5 (unchanged), distractors
2/5 (was 2/5, unchanged pattern but the *shape* of the failure changed —
see below). **Zero of the 20 cases are `no-tool-called`/silent this
time** — the exact failure mode this session targeted is fully gone.

Remaining 6/20 failures are a different, already-anticipated problem, not
a resurgence of the zero-output bug: 3 wrong-tool hallucinations
(`routing-math-3`, `routing-docqa-3` both called `Grep`; `routing-docqa-5`
called `DataAnalyze` instead of `DocumentQA` — a semi-plausible mixup,
table-tool for a passage) and 3 over-delegations (`routing-distractor-1`/
`-3`, trivial 2-digit arithmetic, now call `AskMathModel` directly instead
of the old `Skill{skill:"math"}` hallucination — a real tool this time,
still wrong per the eval's own "don't delegate trivial math" rule;
`routing-distractor-5` called `ImageCaption` on a plain conversational
question with no image). This matches `LOCAL_AI_MASTER_PLAN.md` §6's own
prediction: a 1.7B router degrades on tool selection once the menu grows
past ~10 (currently ~13 visible), independent of the context-truncation
bug that's now fixed.

### qwen3:4b A/B — attempted, rejected on latency (not accuracy)

Pulled `qwen3:4b` (2.50GB, native `context_length` 262144) and built a
matching `qwen3-router-4b:latest` tag (`num_ctx 40960`, `think false`,
same reasoning as the 1.7b fix) to test §6 mitigation 5. The full
20-case routing eval against it scored **0/20 — every case hit the
harness's 45s timeout**, and a follow-up direct single-case test with a
150s+ budget still produced no response at all after 3 minutes. Root
cause: this machine's RTX 3050 has only 4GB VRAM, and the 4b model at
40960 context has a ~9.2GB total resident footprint — only ~2.3GB of that
fits in VRAM (confirmed via `/api/ps`'s `size_vram` field), forcing most
of the model onto CPU inference, which is drastically slower. This is a
hardware-fit finding, not an accuracy verdict — **not adopted**, and
cleanly reverted (profile back to `qwen3-router:1.7b`, the temporary
`openaiContextWindows.ts` entries for the 4b tag removed, the `qwen3:4b`
Ollama weights left pulled/parked in case a future session with different
hardware or a lighter context setting wants to revisit).

### Verification

`bun run test:provider` (89/89), `bun run test:provider-recommendation`
(41/41), the broader test set (85/87 — the 2 failures are the
already-documented pre-existing `remoteAgentService.test.ts`
vitest/bun-mocking-gap failures, unrelated to this session), and
`npx tsc --noEmit` (4130 errors — exactly the documented pre-existing
baseline, zero new) all match the pre-session baseline with zero new
failures. `bun run build` run after every `src/` change, verified live
through the compiled CLI each time, per this project's own hard rule.

### Genuinely ambiguous decision for the project owner

`qwen3-router:1.7b`'s `num_ctx 40960` (vs. the model's max-supported 40960
— i.e. using the model's full native window) costs real, permanent RAM:
~6.4GB resident for the always-loaded router (confirmed via `/api/ps`,
only ~2.4GB of which fits this machine's 4GB VRAM, the rest in system
RAM) — a large step up from the ~1.8GB this project's own budget notes
assumed for the router baseline (`LOCAL_AI_MASTER_PLAN.md` §3), leaving
less headroom than planned for on-demand specialists (VibeThinker-3B
alone is ~1.9GB). This is a necessary cost of the fix (the full request
genuinely needs ~15.6k tokens of context, no smaller number works without
reintroducing truncation), not a tuning choice, but it's worth the project
owner knowing the actual number rather than the older budget estimate.

## Session 6 (2026-08-12, tools-execution-agent) — Phase 3.5 "The Logic Engine" (DeepSolve): built, live-verified, security review still pending

Built the generate→verify→search pipeline around `AskMathModel` per
`LOCAL_AI_MASTER_PLAN.md` §11/§8 Phase 3.5. **Exposed as a zero-growth
opt-in mode, not a new tool**: `AskMathModelTool`'s input schema gained one
optional field, `deep: boolean` (default false). Per §6's gateway-tool
principle this is better than "at most one new entry" — the router's tool
menu doesn't grow at all. Chosen over a separate `DeepSolve` tool because
the shape is identical ("ask a math problem, get an answer", just deeper
verification) and the task instructions explicitly asked for a surgical,
non-wide-rewrite change to this well-tested existing file. New code lives
entirely under `src/tools/AskMathModelTool/deepSolve/` (6 new modules + 6
new test files); `AskMathModelTool.ts`/`prompt.ts` changes are additive
(new optional input/output fields, a new `if (deep)` branch in `call()`,
extended `mapToolResultToToolResultBlockParam` — the existing single-shot
path and its tests are byte-for-byte unchanged in behavior).

### The pipeline, as built

1. **Generate** (`deepSolve/generateCandidates.ts`): best-of-N, one
   candidate at a time (not all upfront — see "early exit" below),
   temperature-varied `[0.2, 0.5, 0.8, 1.0, 1.2]`, default N=3, hard-capped
   at 5. **Investigated rather than assumed** whether Ollama's
   `/v1/chat/completions` honors a per-request `temperature` for
   VibeThinker: `ollama show`'s Modelfile has no `PARAMETER temperature`
   pinned, and two live calls at temperature 0.0 vs 1.9 with the same
   prompt produced visibly different reasoning length/style and different
   final answers — confirmed working, unlike `num_ctx` and the native
   `think` field on this same endpoint (both previously found silently
   ignored, see Session 5). No parallel model tag was needed. High
   temperature (up to 1.9) also empirically increased the odds of a
   rambling, never-closed `<think>` trace blowing the token budget — kept
   the schedule modest for that reason, documented inline.
2. **Verify — deterministic first** (`deepSolve/verification.ts` +
   `deepSolve/pythonSandbox.ts`): each candidate is prompted to also emit a
   fenced ` ```python-verify ` snippet that independently checks its own
   answer; that snippet is **actually executed locally** (never just
   asked-about) and classified `pass` / `fail` / `inconclusive` by reading
   its stdout for an exact `VERIFIED`/`FAILED: ...` sentinel line + exit
   code (an exception inside the check is `inconclusive`, not a provable
   `fail` — a bug in the check isn't proof the answer's wrong). The moment
   one candidate provably `pass`es, `solveDeep` returns immediately without
   generating the remaining candidates — real latency savings, live-verified
   below (single-candidate early exit on every "normal" case tested).
3. **Score what code can't check** (`deepSolve/rerankCandidates.ts`):
   `inconclusive` survivors are scored by Qwen3-Reranker via a new exported
   primitive, `scoreYesNoJudgment`, factored out of `src/memdir/rerank.ts`
   (same model, same `raw:true` prompt-template-bypass, same softmax/logsum
   -exp scoring math — literally reused, not reimplemented; `rerank.ts`'s
   own `rerankMemoriesByRelevance`/tests are behaviorally unchanged, 9/9
   still pass). Self-consistency vote (`selfConsistencyVote`) is only a
   tie-break among the reranker's own top-scoring tier, or a last-resort
   fallback if the reranker gives zero signal at all — never a vote among
   raw/unverified/failed candidates, matching §11's explicit anti-goal.
4. **Escalate depth, not width** (`deepSolve/solveDeep.ts`): only if every
   single candidate was *provably* wrong (zero `inconclusive` survivors —
   an `inconclusive` candidate goes to step 3 instead, never triggers this)
   does it retry — exactly once, re-prompted with the failed answers +
   verifier feedback baked into the prompt text
   (`generateCandidates.ts#buildRetryPrompt`), not more candidates.

### The code-execution mechanism — the mandatory security section

**Investigated reuse of the existing sandbox-runtime first, concluded it's
not applicable on this machine at all, before building anything new.**
Read `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js`
directly: `isSupportedPlatform()` returns `platform === 'linux' || platform
=== 'macos'` (WSL1 explicitly excluded too); `getPlatform()` maps
`process.platform === 'win32'` to `'windows'`, which is neither. This
project's actual dev/runtime machine is native Windows (`win32`, not WSL)
— so `SandboxManager.isSandboxingEnabled()`
(`src/utils/sandbox/sandbox-adapter.ts`) is **unconditionally `false` here
regardless of settings**; the underlying OS primitives (bubblewrap,
Seatbelt) don't exist on Windows at all. There was no "can it be invoked
non-interactively" question left to answer — reusing it would silently
no-op on this machine. Separately, even where it IS supported, it wraps a
shell command tied to the interactive Bash permission-prompt flow, which
per the task's own framing is the wrong shape for an internal,
per-candidate verification step nested inside another tool's `call()`.
Worth stating plainly: **`BashTool` itself is in the identical position on
this same machine today** — unsandboxed by the OS, gated only by the
permission prompt. This new mechanism has no such prompt (by design — see
below) but a categorically smaller capability surface.

Built the narrow, dedicated mechanism the task's fallback path describes:
`deepSolve/pythonSandbox.ts`, `runPythonSnippet(code, opts)`. Read that
file's own header comment for the full layered-defense writeup; summary:

- No shell at all — the snippet is written to a file at a path this code
  controls, then run via `execa(pythonPath, [scriptPath], { shell: false })`
  (argv array, zero string interpolation, zero injection surface).
- **Default-deny import allowlist** (`math`, `cmath`, `fractions`,
  `decimal`, `statistics`, `itertools`, `functools`, `operator`, `re`,
  `string`, `collections`, `heapq`, `bisect`, `numbers`, `typing`,
  `dataclasses`, `enum` — nothing else, regex-scanned) plus a **dangerous-
  builtin denylist** independent of imports (`eval`, `exec`, `compile`,
  `__import__`, `open`, `input`, `globals`, `locals`, `vars`, `getattr`,
  `setattr`, `delattr`, `breakpoint`, and sandbox-escape-gadget dunders like
  `__class__`/`__subclasses__`/`__globals__`/`__reduce__`).
- Interpreter run with `-I -S -B` (isolated mode, no site init, no
  `.pyc` writes) — real interpreter-level hardening independent of the
  regex layer.
- `extendEnv: false` + an explicitly minimal built env (just the
  interpreter's own directory on `PATH`, `SystemRoot` on Windows) — the
  child **never** inherits this process's environment, so this project's
  own `.env` (which Session 2/3 already flagged as carrying a live NVIDIA
  NIM key) is not exposed to it, defense in depth on top of `os` being
  import-denied entirely.
- Fresh, uniquely-named temp dir per call (`fs.mkdtemp` under
  `getClaudeTempDir()`, this codebase's own temp-dir convention) as both
  the script's location and the child's cwd; deleted in a `finally` block
  regardless of outcome.
- Hard timeout — 8s default, 15s hard cap regardless of what a caller
  requests — via execa's own `timeout`, plus a belt-and-braces
  `treeKill(pid, 'SIGKILL')` on timeout, the exact primitive
  `src/utils/ShellCommand.ts` already uses for the same guarantee.
  **Live-verified against a genuine infinite loop**, not just asserted:
  `pythonSandbox.test.ts` spawns `while True: x = x + 1` and confirms it's
  actually killed within the timeout, not left running.
- Output capped (execa `maxBuffer` + a further truncation on what's
  returned).

**Honest limits, stated for the reviewer, not hidden** (also in the file's
own comment): the import/builtin checks are regex-based static analysis on
source text, not a real Python AST/capability sandbox — a determined,
obfuscated payload could theoretically build a forbidden call without ever
containing a banned literal substring. Sized deliberately for its actual
threat model (a 3B local model writing a short self-check of its own
arithmetic, not a red-team adversary) and paired with the process-level
defenses above specifically so a gap in the text layer doesn't become
unrestricted execution. No OS-level network/filesystem namespace isolation
exists on this Windows machine — the import allowlist (no
socket/http/urllib/requests/os/pathlib/shutil) is what actually prevents
network/arbitrary-file access, not an OS-enforced boundary. No CPU/memory
ulimits (no Job Object binding in this codebase's dependency set) — timeout
is the primary resource bound.

**One judgment call flagged explicitly, not decided silently**:
`AskMathModelTool.checkPermissions` still returns unconditional `allow` for
`deep: true`, even though deep mode now spawns local processes (unlike the
tool's existing single-shot mode, which has zero side effects). Kept as-is
to match the task's explicit instruction not to prompt per-candidate (up to
N+1 times per call) and because the capability is narrow enough to plausibly
still fit the existing trust boundary — but this is the one place in this
change where "should this still be unconditional allow" is a real question,
not a mechanical continuation of prior behavior. Commented inline at the
exact line for the reviewer.

### Live-verified end-to-end, three separate real runs, not just unit tests

`solveDeep.live.test.ts` run three times total (once standalone, once
inside a scoped `bun test src/tools src/services/tools src/bridge ...` run,
once inside the DeepSolve eval below) — real HTTP calls to VibeThinker-3B,
a real spawned `python.exe`, real early-exit behavior. All three produced a
correct, genuinely different (model-sampled) but valid verification
snippet, and all three correctly printed `VERIFIED`:
```
ANSWER: Final answer: 391
```python-verify
import operator
from functools import reduce
expected = 391
computed = reduce(operator.mul, [17, 23], 1)
print("VERIFIED" if computed == expected else f"FAILED: ...")
```
VERIFIED: true   METHOD: code-verified   CANDIDATES: {generated:1,passed:1}
```
(the other two runs independently invented different valid checks —
repeated addition, and an `(a+b)²−a²−b²)/2` identity — real evidence this
isn't a hardcoded/templated response.)

### Eval: DeepSolve vs single-shot (`scripts/eval/deepSolveEval.ts`, `bun run eval:deep-solve`, new)

6 fixed cases (`deepSolveCases.ts`): 2 easy/regression, 2 medium, 2
deliberately hard (modular exponentiation via Fermat's little theorem —
7^100 mod 13 — and the classic "two trains and a bird" rate-trick problem),
each ground-truth-checkable, no live paid frontier call (the frontier
head-to-head is Phase 3.5's own separate, later gate step). Run live twice
(`--n 2`, to keep wall-clock reasonable — the shipped default is N=3):

**Result: 6/6 pass on both single-shot AND DeepSolve.** Every DeepSolve
answer was `code-verified` (a candidate's own check actually ran and
printed `VERIFIED`) — including both hard cases; `deep-6` (the bird
problem) needed 2 candidates (candidate 0 didn't pass, candidate 1 did) —
real evidence the multi-candidate/early-exit logic engages for real, not
just trivially on the first try every time. Full report:
`reports/eval-deep-solve.{json,md}`.

**Honest finding, not glossed over**: this particular 6-case set does not
yet demonstrate DeepSolve *beating* single-shot — VibeThinker-3B got all 6
right single-shot too, including the two problems picked specifically for
being the kind a 3B model plausibly fumbles. This is consistent with
VibeThinker's own strong published benchmarks (94.3 AIME26) and/or means
these two "hard" picks weren't hard enough — it does NOT mean the pipeline
doesn't work; every individual mechanism (real code execution, correct
pass/fail/inconclusive classification, early exit, multi-candidate
continuation when needed, reranker reuse) is confirmed working correctly
via both the live eval and the dedicated unit tests. The master plan's own
Phase 3.5 gate (`LOCAL_AI_MASTER_PLAN.md` §8) needs a fixed ≥20-problem set
to actually settle "beats single-shot" — this 6-case set is real evidence
the machinery works, not yet evidence of the accuracy claim. **Growing this
case set with genuinely harder problems (or ones the frontier-eval
convention already has, e.g. real AIME/competition items) is the natural
next step**, not done this session (time budget).

### Tests

62 new tests across 6 new files under `deepSolve/` (31 `pythonSandbox`,
11 `verification`, 6 `generateCandidates`, 7 `rerankCandidates`, 6
`solveDeep` mocked-state-machine covering early-exit / reranker-path /
self-consistency-fallback / retry-with-pass / retry-without-pass / N-cap,
1 `solveDeep.live`), all passing. `rerank.ts`'s refactor (new exported
`scoreYesNoJudgment` primitive) verified non-breaking: `rerank.test.ts` 9/9
unchanged. `AskMathModelTool.test.ts` 5/5 unchanged (single-shot behavior
byte-for-byte identical). Scoped self-verification command
(`bun test src/tools src/services/tools src/bridge
src/utils/promptShellExecution.test.ts src/utils/ripgrep.test.ts`): **158
pass / 0 fail** when run without concurrent resource contention (the same
scope showed 1 transient failure — `ImageCaptionTool.live.test.ts`,
unrelated to anything touched this session — when run concurrently with
the live DeepSolve eval hitting the same local Ollama instance; re-ran
alone immediately after and it passed cleanly, matching this project's own
long-established "passes in isolation" pattern for live-test contention).
`npx tsc --noEmit`: zero errors trace to any file touched this session
(grepped the full output for `deepSolve`/`AskMathModelTool`/
`memdir/rerank` — zero matches); total error count (3521) is lower than
the previously-documented baseline (4130), not higher. `bun run build`:
clean.

Full bare `bun test` (no path args, whole project): 443 pass / 24 fail
(467 total) vs. the previously-documented 371/23 baseline — net delta is
almost entirely the ~62 new tests added this session (nearly all passing).
Of the 24 fails: 10 are the pre-existing, unrelated `vscode-extension`
failures (documented, separate npm package); 1 new fail is
`solveDeep.live.test.ts`, but **the exact same run also fails two other
pre-existing, untouched live test files** (`DocumentQATool.live.test.ts`,
`ImageCaptionTool.live.test.ts`) **with the identical symptom** —
`TypeError: undefined is not an object (evaluating 'response.ok')`, i.e.
`fetch` itself resolving to `undefined` — which is a global-state
cross-file artifact of running many `fetch`-mocking test files together in
one bare-suite process (this project already has many files doing
`globalThis.fetch = mock; afterEach(() => globalThis.fetch = original)`;
under Bun's shared-process full-suite run, a leak/ordering issue between
them is a pre-existing, previously-documented category — see Session 2/3's
"passes cleanly when re-run in isolation" findings — not something this
session's code caused). My new live test independently passed cleanly
**twice** in smaller/isolated runs with genuine correct live output before
this happened, which is the strongest evidence it's the well-known
full-suite artifact and not a logic bug. Not fully root-caused (matches the
depth of investigation this project's own prior sessions applied to the
same category) — flagged for whoever next touches the shared `bun test`
full-suite hermeticity, same as the already-flagged `test:provider`
gate work.

### Security review — REQUIRED before this is wired into any default/always-visible path, not yet done

This is explicitly **not** finished per the task's own gating instruction.
`deep: true` is already reachable today (it's a field on the existing,
always-visible `AskMathModel` tool, not a separately gated new tool) — a
security-audit-agent pass is needed before treating this as safe to leave
that way. Files/mechanisms that need auditing, in priority order:

1. `src/tools/AskMathModelTool/deepSolve/pythonSandbox.ts` — the actual
   execution mechanism (import allowlist, builtin denylist, `-I -S -B`
   flags, minimal env, temp-dir lifecycle, timeout/treeKill). Highest
   priority — this is the new code-execution surface.
2. `src/tools/AskMathModelTool/deepSolve/verification.ts` — the extraction
   logic that decides what text becomes "the code that runs" (regex fence
   extraction from LLM output) and the pass/fail/inconclusive
   classification logic downstream of execution.
3. `src/tools/AskMathModelTool/AskMathModelTool.ts` — specifically the
   `checkPermissions` judgment call flagged above (unconditional `allow`
   covering the new code-execution capability) and the new `deep`
   input/`call()` branch.
4. `src/tools/AskMathModelTool/deepSolve/generateCandidates.ts` — the
   prompt construction feeding untrusted model output into what
   `verification.ts` will later try to execute (prompt-injection-adjacent:
   does anything here make it easier for a malicious/compromised model
   response to smuggle something past the sandbox, even though the
   sandbox itself doesn't trust the prompt for its own safety guarantees).
5. `src/memdir/rerank.ts`'s refactor (new exported `scoreYesNoJudgment`) —
   lower priority, purely a factoring-out of already-reviewed code
   (Session 2's security review covered `rerank.ts`'s network-call safety
   already), but worth a glance since it's now called from a second
   call site.

Not wiring any additional gating beyond what's described above pending
that review — build/tests/live-verification are done and real, but "is
this safe to leave reachable" is explicitly still open.

## Session 7 (2026-08-12, provider-router-agent, run in parallel with Session 6) — semantic tool pre-filtering: built, verified no-op at today's tool count

Implemented `LOCAL_AI_MASTER_PLAN.md` §6 mitigation 3
(`src/services/api/toolPreFilter.ts`, `src/memdir/embeddingClient.ts` new;
`src/memdir/embeddingPreFilter.ts` refactored behavior-preserving to share
the extracted embedding client; one gated `if` block added in `claude.ts`).
Full technical detail in `.claude/contracts/provider-router-contract.md`
§6 — summary here:

Gated by `shouldApplyToolPreFilter(provider, baseUrl)` — true only for the
OpenAI-compatible transport talking to a local endpoint (today: this
project's `ollama` profile). Every cloud-provider path (Anthropic
first-party, Bedrock, Vertex, Foundry, Gemini, GitHub Models, Codex, or a
non-local OpenAI-compatible endpoint) is provably unaffected —
`filteredTools` is the identical object upstream logic already produced.
A fixed core set (this app's built-ins + the four local-AI specialists)
plus `ToolSearch` always stays visible; the discretionary tail is ranked
by all-minilm embedding similarity to the current turn's text, top
`TOOL_PREFILTER_TOP_K` (4) survive. Fails open at every stage, same
discipline as `embeddingPreFilter.ts`.

**Result: routing eval unchanged, 70.0% (14/20) before and after —
a verified no-op, not a failed fix.** With MCP servers already scoped out
of the `ollama` profile and ToolSearch deferral already hiding most
non-core built-ins, the profile's actual discretionary tail today is only
2 tools (`Task`/`Skill`) — already below the top-K=4 threshold, so the
short-circuit in `applySemanticToolPreFilter` returns the input unchanged
on every turn, confirmed via a live routing-eval run showing
byte-identical `filteredTools` in every case. This means **the remaining
6/20 routing-eval failures are not a tool-count problem at today's ~13
visible tools** — they're a different reliability ceiling (3 wrong-tool
hallucinations, 3 over-delegation on trivial/no-tool-needed prompts) that
tool-list trimming can't reach. The infrastructure is real, tested, and
valuable for *future* growth (more MCP tools if scoping relaxes, Phase 4/5
gateway tools), just not the thing that closes today's gap.

**Phase 1 gate still not met** (70% < ~90%). Verified: `bun run build`
clean; `test:provider` 89/89; `test:provider-recommendation` 41/41; zero
new `tsc` errors trace to any file touched (checked directly, not just
totals).

## Open items for next session

- **Security review of the DeepSolve code-execution surface** (see list
  immediately above) — the top-priority item, blocking nothing else but
  itself needing to happen before this is considered fully done.
- Grow `deepSolveCases.ts` toward the master plan's own ≥20-problem gate
  with genuinely harder cases (this session's two "hard" picks turned out
  to be within VibeThinker's single-shot reach) — needed to actually
  measure the "beats single-shot" claim rather than just confirming the
  machinery works.
- The Phase 3.5 gate's second half (a frontier-model head-to-head) —
  deliberately not attempted this session (no live paid API calls without
  explicit opt-in, matching this project's own established eval
  discipline).
- The bare full-suite `bun test` fetch-mock cross-file artifact noted
  above — same category as the already-flagged `test:provider` hermeticity
  work, not investigated further this session (out of scope, pre-existing).
- **Top priority, per the master plan's own reordering**: semantic tool
  pre-filtering (`LOCAL_AI_MASTER_PLAN.md` §6 mitigation 3) — the
  zero-output bug that was blocking meaningful measurement of this lever
  is now fixed (routing eval 70.0%, clean baseline), and the remaining
  6/20 failures are exactly the tool-count-driven wrong-tool/over-delegation
  pattern this mitigation targets. Still the biggest/riskiest change in the
  list (touches the shared tool-list-construction path used by every
  provider, not just local ones) — budget real review time for it.
- qwen3:4b-instruct A/B is now closed (attempted and rejected on latency/
  VRAM-fit grounds, see Session 5 above) — no need to revisit unless the
  hardware changes (a machine with more VRAM, or a smaller quantization).
- A small `DataAnalyze`-specific eval set (mirroring `specialistEval.ts`)
  to properly characterize `/table-qa`'s real accuracy rather than relying
  on ad hoc spot-checks. (Session 4 above, tools-execution-agent, has since
  built exactly this — `scripts/eval/dataAnalyzeEval.ts` — so this item is
  effectively done; kept here only until the next full doc pass confirms
  it can be removed.)
- Whisper/vision phases (Phase 4/5) — GPU capacity now exists and is
  proven working (BLIP/DistilBERT on CUDA+fp16), so Phase 4 (Whisper
  turbo) is no longer blocked on platform work, only on router reliability
  being resolved first per the phase ordering. Router reliability is
  meaningfully better (70%) but still below the ≥90% gate, so this stays
  blocked until semantic pre-filtering (or another lever) closes the gap.
