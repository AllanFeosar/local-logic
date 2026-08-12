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

## Session 8 (2026-08-12, tools-execution-agent) — DeepSolve security review: all 5 findings fixed, needs independent re-audit

Picked up Session 6's "security review complete, verdict not-safe-to-ship-as-is"
handoff and fixed all five findings from that review (2 HIGH, 3 MEDIUM). Per
the review's own process requirement, **this still needs a second,
independent security-audit-agent dispatch to re-verify** — everything below
is written to make that re-verification concrete and checkable, not a
self-declared "done".

### Finding 1 (HIGH, fixed) — builtin denylist bypass → RCE

`pythonSandbox.ts`'s `DANGEROUS_TOKENS` substring scan (`'eval('`, `'open('`,
etc.) is gone entirely. Replaced with real static analysis via Python's own
`ast` module (no new dependency — ships with every Python 3 install):
`validatePythonSnippet` now spawns the already-resolved interpreter to run a
small, fixed, trusted linter script (embedded as `AST_LINTER_SCRIPT`, a
string constant in `pythonSandbox.ts` — the untrusted snippet is passed on
stdin, never interpolated into the linter's own source) that does
`ast.parse()` + `ast.walk()`. Closes the bypass class (not just the four
examples) by rejecting **any** `ast.Name` reference to a banned identifier
— `eval`, `exec`, `compile`, `__import__`, `open`, `input`, `globals`,
`locals`, `vars`, `getattr`, `setattr`, `delattr`, `breakpoint`, `exit`,
`quit`, `help`, `copyright`, `license`, `credits`, `memoryview`,
`attrgetter`, `methodcaller`, `__builtins__` — regardless of Load/Store/Del
context, so `z = __import__` is *itself* a rejected reference and `z(...)`
never gets the chance to run; `open (...)` (space before paren) is
irrelevant to an AST walk since it's the same `Call` node either way. No
assignment/dataflow tracking was needed for this — flagging any reference,
not just calls, is sufficient per the review's own stated fallback.
Verified: `pythonSandbox.test.ts`'s new "Finding 1" describe block
(`w = open; w('x')`, `e = exec; e(...)`, `z = __import__; z(...)`,
`open ('x')` with a space, `g = getattr; g(...)`, `v = eval; v(...)`) — all
6 rejected with `reason` containing `disallowed identifier`.

### Finding 2 (HIGH, fixed) — import allowlist regex bypass

`IMPORT_LINE_RE` (line-anchored regex) is gone. The same AST walk handles
`ast.Import`/`ast.ImportFrom` via `ast.walk()`, which finds them regardless
of surface syntax: `import math, os` is one `Import` node with two `alias`
entries and **every** alias is checked (not just the first); `x = 1; import
os` and `if True: import subprocess` produce the identical AST shape a
top-level `import os` does; a backslash-continued `import \` + `    os`
parses to the same single-name `Import` node. Also newly rejects wildcard
from-imports (`from math import *` — can't be statically vetted) and
relative imports (`from . import os` — `node.level > 0`). Verified:
`pythonSandbox.test.ts`'s "Finding 2" describe block — all 6 cases
(comma-separated, semicolon-chained, indented-in-block, backslash-continued,
wildcard, relative) rejected with `reason` containing `disallowed import`.

### Finding 3 (MEDIUM, fixed) — `operator.attrgetter`/`methodcaller` getattr-equivalent

Took option (a) from the review (narrow the allowlist entry) rather than
removing `operator` entirely, since `operator.mul`/`operator.add`/etc. are
genuinely used by real, live-generated verification snippets (see Session
6's own live example, and this session's fresh live re-verification below,
which also used `operator`-adjacent constructs). Both `attrgetter` and
`methodcaller` are now in `BANNED_IDENTIFIERS` (closes
`from operator import attrgetter` + bare-name use) **and** in
`BANNED_ATTRS` (closes `operator.attrgetter`, and — because the ban is on
the attribute *name*, not on resolving what object it's accessed on —
closes multi-hop re-aliasing too: `op2 = operator; op2.attrgetter` is
rejected without needing to prove `op2` traces back to the `operator`
import). `operator.mul`/`operator.add`/etc. remain fully usable since
`.mul`/`.add` aren't banned attribute names. Verified:
`pythonSandbox.test.ts`'s "Finding 3" describe block — direct
`operator.attrgetter`/`methodcaller` use, `from operator import
attrgetter`, and the re-aliased `op2.attrgetter` case are all rejected;
`reduce(operator.mul, [17, 23], 1) == 391` (the exact shape of Session 6's
live example) is still accepted.

### Finding 4 (MEDIUM, fixed) — unconditional allow + isReadOnly()===true → zero prompting

`AskMathModelTool.ts`'s `checkPermissions` now returns `{behavior:'ask',
message: ...}` when `input.deep === true` (once per tool invocation, not
per-candidate — the original, still-legitimate UX goal is preserved),
instead of unconditional `allow`. Single-shot mode (`deep` unset or
`false`) is unchanged — still unconditional `allow`, zero side effects.
Followed this codebase's own idiom for "usually side-effect-free, sometimes
consequential" (`ConfigTool.ts`: unconditional allow for a read, plain
non-rule-keyed `ask` for a write) rather than building bespoke path/rule
matching like `BashTool`/`FileEditTool` — deep mode has no natural
"path"/rule-content to key permission rules on. Traced through
`src/utils/permissions/permissions.ts`'s `hasPermissionsToUseToolInner` to
confirm this composes correctly with the rest of the permission pipeline: a
plain `ask` (not tied to a `decisionReason.type:'rule'`) still respects
`bypassPermissions` mode (step 2a — the existing, documented escape hatch,
not a new bypass) and a tool-level "always allow AskMathModel" rule (step
2b) — both of which override even a returned `ask` unless it came with
`requiresUserInteraction()` or a rule-typed `ask`, neither of which apply
here — so a user who approves once isn't nagged on every subsequent
deep-mode call. In a headless/`shouldAvoidPermissionPrompts` session, `ask`
auto-denies (fails closed), matching every other tool.
`isReadOnly(input)` now returns `!input?.deep` instead of unconditional
`true` — checked every real call site in the codebase first
(`grep -rn "\.isReadOnly\("` across `src/`) before changing it: `cli/print.ts`
only calls it for MCP-server tools with input literal `{}` (`{}.deep` is
`undefined`, so behavior is unchanged there); `extractMemories.ts`'s
`createAutoMemCanUseTool` only calls `tool.isReadOnly` when
`tool.name === BASH_TOOL_NAME` (never reached for `AskMathModelTool`); the
`FilesystemPermissionRequest.tsx` UI component only reaches its
`isReadOnly` line for tools with a `getPath` method, which `AskMathModelTool`
doesn't have. Confirmed no other call site is affected.
Verified: `AskMathModelTool.test.ts`'s new `describe('checkPermissions')`
(single-shot → `allow`, `deep:false` → `allow`, `deep:true` → `ask` with a
non-empty message) and `describe('isReadOnly')` (single-shot/`deep:false` →
`true`, `deep:true` → `false`).

### Finding 5 (MEDIUM, fixed) — bare `print("VERIFIED")` forges "code-verified"

`pythonSandbox.ts`'s AST linter already parses the snippet for security
purposes, so it also reports two structural facts as a byproduct of the
same walk, threaded through `PythonExecResult.snippetMeta`:
`hasComparison` (an `ast.Compare` node where at least one operand is *not*
a bare literal constant, so `1 == 1` doesn't count but `computed ==
expected` does) and `hasNonPrintCall` (a `Call` node targeting anything
other than the bare `print` builtin — e.g. a call into an allowed module
function). `verification.ts`'s `verifyAnswer` now only classifies a
VERIFIED-printing, exit-0 snippet as `'pass'` when at least one of those is
true (`meta.hasComparison || meta.hasNonPrintCall`); otherwise it downgrades
to `'inconclusive'` with an explanatory detail, using the bucket's existing
"code couldn't adjudicate it" semantics rather than inventing a fourth
bucket — `solveDeep.ts` needed zero changes since it already routes
`inconclusive` into reranker scoring. Chose the "did real work" structural
bar (task's suggestion #2, closest to a natural byproduct of the AST walk
already being done for Findings 1-3) over trying to correlate the code's
comparison against the candidate's separately-extracted stated answer
(suggestion #1) — deliberately not over-engineered further, e.g. a
tautological `1 == 1` gate is caught (both operands are `ast.Constant`) but
a tautological `(2*2) == (2*2)` is not (neither side is a bare
`ast.Constant` node, since `2*2` is a `BinOp`) — a real residual gap,
documented rather than hidden, and judged acceptable against the review's
own "meaningfully harder to forge, not perfect" bar. Verified:
`verification.test.ts` — bare `print("VERIFIED")` → `inconclusive` with
detail containing "too trivial"; `1 == 1`-gated VERIFIED → also
`inconclusive`/"too trivial"; a real comparison (`abs(2*2-4) < 1e-9`) and a
call-only check with no explicit comparison (`math.isclose(17*23, 391)`)
both still classify `'pass'`, confirming the fix doesn't reject legitimate
checks. `solveDeep.test.ts`'s `PASSING_SNIPPET`/`FAILING_SNIPPET` fixtures
(previously bare `print("VERIFIED")`/`print("FAILED: wrong")`) were updated
to include a real `computed == expected` comparison so those tests keep
testing what they were meant to test rather than accidentally exercising
the new trivial-print rejection.

### Verification performed

- `pythonSandbox.test.ts`: rewritten (validator is now async — it spawns
  Python to run the AST linter). All prior cases preserved plus new
  describe blocks for Findings 1/2/3 and new `snippetMeta` assertions.
  Tests that need a real interpreter degrade gracefully (skip with a
  console message) if none is found on PATH, matching this file's existing
  convention — not exercised on this dev machine (Python is present).
- `verification.test.ts`: 3 new tests for Finding 5 (see above).
- `AskMathModelTool.test.ts`: 6 new tests for Finding 4 (see above).
- `solveDeep.test.ts`: fixtures updated (see Finding 5), all 6 pre-existing
  behavioral tests (early-exit, reranker fallback, self-consistency
  fallback, bounded retry, best-effort-unverified, N-cap) still pass
  unchanged in intent.
- **Live end-to-end, re-run three separate times** (not just once) against
  real Ollama + VibeThinker-3B + a real spawned `python.exe`, through the
  new AST-based validator and the new triviality check, to confirm
  tightening validation didn't start rejecting legitimate model-generated
  checks: `solveDeep.live.test.ts` standalone, again inside the full scoped
  suite, and again inside the whole `AskMathModelTool/` directory run. All
  three produced a genuinely different, real (not templated) verification
  snippet each time — repeated addition, an `(x+y)²−(x−y)²` algebraic
  identity, and a nested-function repeated-addition check — and all three
  correctly executed under the new AST validator and correctly classified
  `code-verified`/`VERIFIED: true`.
- `npx tsc --noEmit`: 3521 errors total, matching Session 6's own
  post-session baseline exactly (zero new errors; grepped specifically for
  `AskMathModelTool`/`deepSolve` — zero matches).
- `bun test src/tools/AskMathModelTool/deepSolve/pythonSandbox.test.ts
  src/tools/AskMathModelTool/deepSolve/verification.test.ts
  src/tools/AskMathModelTool/deepSolve/solveDeep.test.ts
  src/tools/AskMathModelTool/AskMathModelTool.test.ts`: 82/82 pass.
- Scoped self-verification command (`bun test src/tools src/services/tools
  src/bridge src/utils/promptShellExecution.test.ts
  src/utils/ripgrep.test.ts`): **187/187 pass**, zero failures (includes
  every live test in scope — `AskMathModelTool.live.test.ts`,
  `solveDeep.live.test.ts`, `DocumentQATool.live.test.ts`,
  `ImageCaptionTool.live.test.ts`, `DataAnalyzeTool.live.test.ts` — none of
  the prior sessions' documented transient-contention flakiness reproduced
  this run).
- `bun run build`: clean. Confirmed the fixes are actually present in the
  compiled bundle the CLI runs (`grep -o "too trivial to trust" dist/cli.mjs`
  and `grep -o "Deep mode generates several candidate" dist/cli.mjs` both
  matched), and `node bin/openclaude --version` runs cleanly post-build.

### Not touched, per the task's explicit scope

`python-bridge/`, `src/services/api/toolPreFilter.ts`,
`src/memdir/embeddingClient.ts`, and the sibling `openclaude` repo — none
were referenced by any of the five findings.

### What a fresh re-audit should specifically try

- Any other Python `Name`/`Attribute` reference our `BANNED_IDENTIFIERS`/
  `BANNED_ATTRS` sets might have missed within the 17 allowed modules
  (`math, cmath, fractions, decimal, statistics, itertools, functools,
  operator, re, string, collections, heapq, bisect, numbers, typing,
  dataclasses, enum`) — the fix is a fixed denylist of known-dangerous
  names layered on an AST walk, not an exhaustive per-symbol capability
  audit of every function in every allowed module (documented as an honest
  limit in `pythonSandbox.ts`'s own header comment).
- Whether the `hasComparison`/`hasNonPrintCall` bar for Finding 5 is
  gameable in some way beyond the documented `(2*2)==(2*2)`-style residual
  gap (e.g. a call into an allowed module that has no real effect on the
  VERIFIED branch, satisfying `hasNonPrintCall` without genuine
  correctness content).
- Whether returning a non-rule-keyed `ask` from `checkPermissions` (rather
  than a rule-content-keyed one) has any permission-pipeline edge case this
  session's trace through `permissions.ts` missed — worth an independent
  read of `hasPermissionsToUseToolInner`/`checkRuleBasedPermissions`
  against the specific `{behavior:'ask', message}` shape returned here.

## Session 9 (2026-08-12, tools-execution-agent) — DeepSolve security round 2: string-eval bypass of the AST validator fixed, plus a real runtime import guard added

Picked up a **second independent security re-audit's** finding: Session 8's
AST-based validator (round 1) closed the substring-matching bypasses, but a
fresh review found the AST walk has its own remaining blind spot — it only
inspects real syntax *nodes*, never *string literal contents*. `typing` is on
`ALLOWED_IMPORTS`, and `typing.get_type_hints()` evaluates string/forward-
reference annotations as real Python code internally via its own `eval()` —
a payload hidden inside a string constant is invisible to the walk (just an
opaque `ast.Constant`) but executes at runtime. Per this task's own
requirement, **reproduced the exact exploit live against the pre-round-2
code first**, then fixed both the specific hole (Part 1) and added a
structurally different runtime enforcement layer (Part 2), then re-verified
both parts closed it. Still needs a third independent re-audit — everything
below is written to make that concrete and checkable, matching Session 8's
own process.

### Reproduction (confirmed live, not theoretical)

The task's exact exploit —
```python
import typing
def _c() -> "__import__('os').popen('whoami').read()":
    pass
typing.get_type_hints(_c)
print("VERIFIED")
```
— passed `validatePythonSnippet` unchanged (`typing` allowed, `get_type_hints`
an unbanned Name+Attribute) and, on execution, the resulting traceback
leaked the payload's real `os.getcwd()`/`os.listdir()` output directly into
its own error message — proof the import and filesystem calls actually ran,
not a hypothetical reading of the CPython source. A `str.format` variant
(`"{0.__class__.__init__.__globals__[k]}".format(x)`) was also reproduced,
this time cleanly (`LEAK: __main__`, exit 0, no error at all) — attribute
traversal driven by a format-spec *string*, same root cause, disclosure-only
in this minimal env.

**A further, more severe finding surfaced during the broader audit the task
asked for** ("audit `typing` more broadly... and ban what you find"),
confirmed live and reported prominently since it wasn't explicitly
requested: several `ALLOWED_IMPORTS` modules expose the real `sys` or
`builtins` module as a **plain attribute**, because they `import sys` /
`import builtins as bltns` at their own module scope — `typing.sys`,
`fractions.sys`, `statistics.sys`, `dataclasses.sys`, `enum.sys`,
`enum.bltns`, `collections._sys`. `enum.bltns.__import__('os').popen(...)`
is a *simpler* full RCE than the string-eval one above — no annotation
tricks, no `eval`, just plain attribute traversal on an already-imported
module — and was confirmed working against the pre-round-2 validator.
`typing.TypeVar("T", bound="<payload>").__bound__.evaluate()` was also
confirmed live: it reaches a `ForwardRef` instance and triggers the same
eval-a-string behavior **without the payload ever naming `ForwardRef` at
all**, closed by banning the `evaluate`/`_evaluate` attribute names rather
than only the constructor name.

### Part 1 — closing the specific holes (static, `pythonSandbox.ts`)

Added to `BANNED_IDENTIFIERS` (bare-name/import forms): `get_type_hints`,
`ForwardRef`, `_eval_type`, `sys`, `_sys`, `bltns`. Added to `BANNED_ATTRS`
(the form these are actually reached through, e.g. `typing.get_type_hints`):
`get_type_hints`, `ForwardRef`, `evaluate`, `_evaluate`, `_eval_type`,
`format`, `sys`, `_sys`, `bltns`. Same mechanism as round 1's Finding 3
(attrgetter/methodcaller) — banning the *name* regardless of what object
it's accessed on, so re-aliasing doesn't help. `format` is banned only as an
attribute (not identifier) since it's a common enough word that banning the
bare name would risk rejecting a legitimate local variable named `format`;
same reasoning kept `evaluate`/`_evaluate`/`_eval_type` attribute-only.
Legitimate numeric formatting in a verification snippet can still use
f-strings (compile to `JoinedStr`/`FormattedValue`, not an `Attribute`/`Call`
node) — this bans the `.format()` *method*, not all formatting.

### Part 2 — runtime import guard, the architectural fix (`RUNTIME_IMPORT_GUARD_PREFIX`, new)

Investigated the most robust approach achievable in plain CPython with no
new dependencies, verified every design decision empirically rather than
assuming (per the task's explicit instruction), landed on: a fixed, trusted
Python preamble now prepended to the *executed* script (never to what the
AST linter validates — the linter still only ever sees the raw untrusted
snippet) that runs before a single line of the untrusted snippet does:

1. **Primes `sys.modules`** by really importing all 17 `ALLOWED_IMPORTS`
   modules via the real, unguarded `__import__` first. Necessary because
   CPython's pure-Python stdlib modules transitively need internal plumbing
   to load at all on Windows (`_io`, `ntpath`, and — confirmed empirically —
   `os` itself, plus `winreg`) — without priming, even a plain `import math`
   would get blocked once the strict guard below activates.
2. **Overrides the *shared* `builtins.__import__`** (not a per-namespace
   copy) with a function that re-checks the same 17-module allowlist at the
   moment any import is actually attempted, regardless of whether the
   request came from a top-level `import` statement, a dynamically `eval`'d
   string, or from inside an allowed module's own internal machinery.
   Deliberately does **not** trust "already in `sys.modules`" as a reason to
   allow a name — confirmed empirically that `os` and `winreg` end up cached
   as legitimate priming plumbing, so a cache-based exception would have
   silently reopened the exact hole this exists to close.
3. **A `sys.meta_path` finder inserted at position 0**, enforcing the
   identical allowlist as a second, independent check.
4. **Strips a short list of other dangerous builtins** (`eval`, `exec`,
   `compile`, `open`, `input`, `globals`, `locals`, `vars`, `getattr`,
   `setattr`, `delattr`, `breakpoint` — **not** `__import__`, which stays
   present but now points at the guarded function, since the script's own
   `import` statements still need it) from the *executed script's own*
   `__builtins__` mapping.

Built from `ALLOWED_IMPORTS` via a new `pyStringSetLiteral` helper so this
doesn't become a third hand-duplicated copy of the module list (matching the
existing "keep AST_LINTER_SCRIPT's copy in sync" caveat, without adding to
the duplication problem for the new script).

**Empirically verified, not assumed** (per the task's explicit instruction),
with concrete counterintuitive findings worth recording:

- Investigated whether "stripping dangerous names from the script's own
  `__builtins__`" (item 4) adds anything real, rather than assuming either
  way. Result: **it does**, but for a narrower reason than either the
  reject-or-accept framing suggested. CPython's `eval(code, globals=X, ...)`
  freshly consults `X['__builtins__']` *at the moment of that specific call*
  — confirmed by direct experiment: stripping `__import__` from the script's
  own `__builtins__` blocked the `get_type_hints` exploit outright
  (`NameError: name '__import__' is not defined`), because
  `annotationlib.evaluate()`'s internal `eval()` call passes the *target
  function's* `__globals__` — i.e. this same script's own globals dict — as
  the `globals` argument. This does **not** protect the script's *own*
  top-level bytecode (a frame's builtins are fixed once at frame-start,
  before the mutation runs — confirmed by a direct top-level `eval()` call
  still resolving fine even after stripping) — but that's already covered by
  the static ban on directly referencing these names. It also does **not**
  protect against reaching a dangerous *object reference* directly (see
  next point) — only against a string being eval'd/exec'd with this
  script's own globals, which is exactly the `get_type_hints` bug's shape.
- Directly tested (not assumed) whether the shared-`builtins`-module patch
  in item 2 also happens to close the `enum.bltns.__import__('os')` vector
  found during the broader audit, since `enum.bltns` IS the same shared
  `builtins` module object being patched. **Confirmed yes** — live tested
  with the Part 1 static bans on `sys`/`bltns` temporarily removed, the
  runtime guard alone still blocked it (`ImportError: sandbox runtime
  guard: import of 'os' is not allowed`).
- Directly tested (per the task's own suggestion) whether the runtime guard
  alone — with the round-2 static bans temporarily bypassed via a test-only
  export (`_runPythonSnippetBypassingStaticValidationForTests`, new) —
  stops the original `get_type_hints` exploit. **Confirmed yes.**
- Also directly tested the honest boundary: `typing.sys.modules['os']` (a
  plain dict lookup on an already-populated module cache, no `__import__`
  call anywhere in the chain) is **not** stopped by the runtime guard at
  all, with or without static bans in place — confirmed live. This is
  closed *only* by the static `sys`/`_sys`/`bltns` ban, which is inherently
  non-exhaustive (same limitation this whole task is about).

### Honest scope statement (also in `pythonSandbox.ts`'s own header comment, not just here)

"Even if the static scan misses a payload, the payload can no longer reach a
non-allowlisted import when it actually executes" is the bar this meets —
confirmed for both "hidden in a string" and "reached via an allowed module's
own attribute-then-`__import__`" cases. It is explicitly **not**
"unbypassable": attribute traversal to an already-imported dangerous object
that never calls `__import__` at all (the `typing.sys.modules[...]` class)
is completely outside the runtime guard's reach by construction — no import
chokepoint is ever hit — and depends entirely on the static denylist, which
round 2 itself proves is not a complete enumeration. A future undiscovered
variant of that second category remains a real, open risk this design does
not eliminate.

### Tests

24 new tests in `pythonSandbox.test.ts`: a "Round 2" describe block (10
tests — the exact task exploit, the `str.format` variant, direct
`ForwardRef`/`.evaluate()`, `TypeVar(bound=...).__bound__.evaluate()`,
`typing._eval_type`, the 7 `sys`/`bltns`/`_sys` attribute-exposure variants
as a parametrized loop, and one confirming legitimate `typing`/`dataclasses`/
`enum` usage still validates ok) plus a new top-level describe block (4
tests) exercising `RUNTIME_IMPORT_GUARD_PREFIX` in isolation via the new
`_runPythonSnippetBypassingStaticValidationForTests` test-only export:
runtime guard alone stops the `get_type_hints` exploit, runtime guard alone
stops `enum.bltns.__import__`, the honest-gap test confirming
`typing.sys.modules[...]` is *not* stopped by the runtime guard alone, and a
legitimate-usage-still-works test. `pythonSandbox.test.ts` total: 68/68
pass. `runPythonSnippet`'s execution mechanics were factored into a shared
`executeGuardedScript` helper (both the real call path and the test-only
bypass export use it) — no behavior change to the real path.

### Verification performed

- `bun test src/tools/AskMathModelTool/deepSolve/pythonSandbox.test.ts`:
  68/68 pass.
- `bun test` across `verification.test.ts`, `solveDeep.test.ts`,
  `generateCandidates.test.ts`, `rerankCandidates.test.ts`,
  `AskMathModelTool.test.ts`: 44/44 pass, unchanged behavior.
- `solveDeep.live.test.ts` run twice, real HTTP calls to VibeThinker-3B, a
  real spawned `python.exe` running under both the AST validator and the new
  runtime guard: both runs produced genuinely different (model-sampled)
  verification snippets (a repeated-addition check, then a
  `reduce`-vs-`math.prod` cross-check using `math`/`functools`/`operator`
  together) and both correctly classified `code-verified`/`VERIFIED: true` —
  confirms the tightened validation and the new runtime guard don't reject
  legitimate model-generated checks.
- Scoped self-verification command (`bun test src/tools src/services/tools
  src/bridge src/utils/promptShellExecution.test.ts
  src/utils/ripgrep.test.ts`): **204/204 pass** across 25 files, including
  every live test in scope (`AskMathModelTool.live.test.ts`,
  `solveDeep.live.test.ts`, `DocumentQATool.live.test.ts`,
  `ImageCaptionTool.live.test.ts`, `DataAnalyzeTool.live.test.ts`).
- `npx tsc --noEmit`: 3521 errors — exactly matching Session 8's documented
  post-session baseline, zero new (grepped specifically for
  `pythonSandbox`/`deepSolve` — zero matches).
- `bun run build`: clean. Confirmed the fixes are present in the compiled
  bundle (`grep -o "sandbox runtime guard" dist/cli.mjs` and
  `grep -o "_install_sandbox_runtime_guard" dist/cli.mjs` both matched), and
  `node bin/openclaude --version` runs cleanly post-build.

### Not touched, per the task's explicit scope

`python-bridge/`, the semantic-tool-pre-filter work
(`src/services/api/toolPreFilter.ts`, `src/memdir/embeddingClient.ts`), and
the sibling `openclaude` repo — none were referenced by this round.

### What a fresh (third) re-audit should specifically try

- Whether any other `typing`/`dataclasses`/`enum`/`functools` public API has
  similar "evaluates a string" or "exposes a live dangerous-module
  reference" behavior beyond what this round found — the fix is still a
  fixed denylist layered on an AST walk plus an import-chokepoint runtime
  guard, not an exhaustive per-symbol capability audit of the 17 allowed
  modules (documented as an honest limit in `pythonSandbox.ts`'s own header
  comment, same as round 1).
- Whether there's a *third* category beyond "hidden in a string" and
  "reached via an allowed module's own attribute" that this round hasn't
  considered — e.g. anything that reaches a dangerous capability via a
  *return value* of an allowed function rather than a module attribute.
- Whether the `__builtins__`-stripping layer's frame-timing behavior (a
  module-level frame's builtins are fixed at frame-start, function/nested-
  eval frames created after the mutation pick it up fresh) holds identically
  across Python versions/patch releases likely to be resolved via PATH on a
  real user machine, not just the 3.14.2 install this round tested against.
- An independent read of `RUNTIME_IMPORT_GUARD_PREFIX` itself for logic bugs
  (e.g. the priming loop swallowing all exceptions via a bare
  `except Exception: pass` — deliberate, so one failed prime doesn't break
  the rest, but worth a second look) and of `executeGuardedScript`'s
  refactor for behavior parity with the pre-refactor `runPythonSnippet`.

## Session 10 (2026-08-12, orchestrating session) — DeepSolve code execution: NOT shipped, held back after a third round found a trivial full RCE bypassing every layer

The independent re-audit Session 9 asked for happened. Verdict: **still not
safe.** A live-reproduced, 10/10-confidence finding: `dataclasses.inspect.os`,
`dataclasses.annotationlib.builtins`, and `statistics._random._os` are all
live references to the real `os`/`builtins` modules, reachable by plain
attribute traversal from two of the still-allowed modules
(`dataclasses`, `statistics`) — no `import` statement, no `eval`, nothing
either the AST linter or the runtime import guard is positioned to see,
because **no import call happens at all**. `dataclasses.inspect.os.system("echo PWNED")`
is a one-line full RCE that passes the linter (`{"ok": true}`) and runs
under the runtime guard unmodified. Confirmed live: arbitrary command
execution, arbitrary file write via the real (guard-strip-bypassing)
`builtins.open`, and arbitrary `eval` via the real `builtins.eval`. Full
detail, reproduction, and the auditor's own architectural analysis are in
the agent's report (not reproduced verbatim here — see the conversation
history around this session, or re-run the same audit prompt for the
full write-up).

**This is the third consecutive round where closing the reported hole left
the same class reachable a different way** (round 1: regex bypass → AST
rewrite; round 2: AST rewrite blind to string-literal contents
(`typing.get_type_hints`) → runtime import guard added; round 3: guard
blind to already-imported-module attribute access → this finding). The
auditor's own assessment, which this session's judgment agrees with:
**this is not a whack-a-mole problem with one more fix left in it.**
Python's shared module cache means any already-imported module is
reachable by attribute traversal from *some* allowed module in an
open-ended, CPython-version-dependent way that a static denylist cannot
exhaustively enumerate — confirmed empirically across three rounds, not
just asserted in the abstract.

**Decision: stop iterating, do not ship.** A fourth patching round would
almost certainly repeat the pattern — the auditor's own BFS already
surfaces more reachable dangerous objects than the one vulnerability
class reported. Continuing to add names to a denylist against an
open-ended reachable-object graph is not a responsible way to secure
something that grants real code execution on the user's machine,
especially given `deep: true` sits on an *already-visible* tool gated by
only a single permission prompt a user could click through without
grasping the risk. **Nothing from `src/tools/AskMathModelTool/deepSolve/`,
the modified `AskMathModelTool.ts`/`prompt.ts`, or
`scripts/eval/deepSolveCases.ts`/`deepSolveEval.ts` has been committed —
everything is confirmed still local-only, uncommitted, unpushed, and will
stay that way** until a future session makes a deliberate architectural
choice, not another patch.

**What's still real and valuable, kept in the working tree for a future
session to build on:** the generate → verify-outcome-classify → score →
escalate orchestration logic (`deepSolve/solveDeep.ts`,
`generateCandidates.ts`, `rerankCandidates.ts`) is correct and
well-tested — it's specifically the *code-execution* verification step
that's the unresolved problem, not the pipeline shape around it.

**Two concrete directions for whoever picks this up, neither implemented
here — a deliberate decision point for the project owner, not something
to guess at:**
1. **Redesign verification to not execute arbitrary Python at all.**
   Replace "the specialist writes and we run a Python check" with a much
   narrower, provably-safe mechanism — e.g. the specialist emits a
   structured numeric/symbolic claim (its answer plus what it should
   equal) and verification is a fixed, hand-written comparison (safe
   numeric equality/tolerance check, `ast.literal_eval` for simple
   literal values, or a tiny hand-rolled arithmetic-expression evaluator
   with no function-call or attribute-access grammar at all) instead of
   full Python. This sidesteps the entire vulnerability class the three
   rounds found — there is no stdlib module graph to traverse if nothing
   resembling `import`/`Attribute`/`Call` beyond a fixed comparison
   primitive is ever executed. Real cost: narrows what's checkable (loses
   the ability to verify via an arbitrary independent algorithm, e.g. the
   "two trains and a bird" case's simulate-and-compare check from Session
   6's eval) — a genuine tradeoff, not a free lunch.
2. **Real OS-level isolation instead of in-process denylisting.** This
   project already has a reviewed sandbox mechanism
   (`@anthropic-ai/sandbox-runtime`) that's unconditionally disabled on
   native Windows (confirmed across all three rounds — bubblewrap/Seatbelt
   don't exist there). If the project owner is willing to have a WSL2
   distro available on this machine, that mechanism becomes genuinely
   usable for exactly this purpose (`isSupportedPlatform()` returns true
   for WSL2, only WSL1 is excluded) — running the verification subprocess
   inside a real Linux sandbox boundary closes this whole class
   structurally, the way no in-process Python trick can, by reusing
   infrastructure this project already trusts rather than building a new
   one. Real cost: a WSL2 dependency this project didn't previously have,
   and cross-boundary latency/complexity this session didn't scope out.

Neither direction was chosen or started — flagging both with their real
tradeoffs is the honest deliverable here, not a recommendation forced
under time pressure.

## Session 11 (2026-08-12, tools-execution-agent) — Tier 1 restricted AST evaluator: built, wired in, live-verified 6/6, independent security-audit-agent review still required

Picked up Session 10's direction 1 (`LOCAL_AI_MASTER_PLAN.md` §11
"Verifier isolation — the settled answer"): replace DeepSolve's math
verification step with a genuinely restricted numeric AST evaluator — an
**allowlist of AST node types**, not another round of denylist patching on
`pythonSandbox.ts`. `pythonSandbox.ts` is **not revived** — it's retired in
place with a top-of-file banner pointing here and at §11, kept only so a
future reader can see exactly what was tried and why three rounds failed.

### What was built (`deepSolve/restrictedEvaluator.ts`, new)

A small, trusted Python script (`RESTRICTED_EVAL_SCRIPT`, embedded as a
string constant, spawned via the same process-hygiene discipline
`pythonSandbox.ts` established: `execa(pythonPath, ['-I','-S','-B','-c',
SCRIPT], { shell: false, extendEnv: false, ... })`, untrusted snippet on
stdin only, hard timeout + kill). Unlike `pythonSandbox.ts` there is **no
temp file and no filesystem write at all** — one process, one fixed
trusted script, one small JSON result on stdout. Critically, the script
never calls Python's own `eval()`/`exec()`/`compile()` on the untrusted
input, not even on a "validated" AST — it parses with `ast.parse()` (reused
for convenience, not safety — a well-tested standard grammar recognizer,
not a security dependency) and then **walks the tree itself**, computing a
result node-by-node via its own hardcoded dispatch. This is what makes "the
grammar cannot express a reference to anything outside the fixed function
table" literally true rather than aspirational: there is no `Attribute`
node type recognized at all (closes every round-1/2/3 exploit class, all of
which depended on attribute traversal through an already-imported module),
and `Name` Load only ever resolves against the interpreter's own local
dict, never Python's real `globals()`/`builtins`/`sys.modules`.

**Exact allowed AST node types** (anything else is rejected — no branch
exists for it, not "checked against a list"): `Module`, `Assign` (single
simple `Name` target only), `Expr` (statement), `Constant` (int/float/bool
literals only — string, bytes, complex, `None`, `Ellipsis` all rejected),
`BinOp` (`+ - * / // % **`), `UnaryOp` (`+ -` only — `not` is deliberately
excluded, not on the task's own allowed list), `BoolOp` (`and`/`or`, with
real short-circuit evaluation), `Compare` (`== != < <= > >=`, including
chained comparisons like `1 < x < 10`), `Call` (only when `node.func` is a
bare `Name` whose `.id` is literally a key in `FUNCTION_TABLE` — no
`**kwargs`, no `*args` unpacking, ≤20 positional args), `Name` (Load only
resolves against the script's own local-variable dict built from prior
`Assign` statements; Store only as an `Assign` target). `Import`/
`ImportFrom`, `Attribute` (any kind, any object), `Subscript`, `Lambda`,
every comprehension form, `JoinedStr`/f-strings, `Starred`, `With`,
`Global`/`Nonlocal`, `While`/`For`/`If`/`FunctionDef`/`ClassDef`/`Raise`/
`Try`, and `eval`/`exec`/`open`/`import`/etc. used as bare call targets are
all confirmed rejected (see test list below) — there is no dangerous-name
list to maintain because none of these can be *expressed* by this grammar
in a way that reaches anything, not because particular spellings are
banned.

**Exact function table** (13 entries, each a plain wrapper function the
trusted script defines itself): `sqrt`, `abs`, `pow` (2-arg real exponent
or 3-arg modular form — `pow(7,100,13)`), `gcd`, `lcm`, `factorial`, `min`,
`max`, `round` (1- or 2-arg), `floor`, `ceil`, `sum`, `isclose`
(tolerance-based float equality, usable as the entire check on its own).
Chosen from the task's own suggested list plus two deliberate, justified
additions: `isclose` (float-tolerant equality is a common, genuinely useful
verification pattern — matches a real usage this project's own live tests
have produced before) and `lcm` (a natural, trivial `gcd` complement for
number-theory checks). Nothing else was added. Bounds to prevent a chain of
individually-small-looking operations from compounding into a
many-gigabyte integer before the timeout would catch it: `MAX_POW_EXPONENT
= 10_000`, `MAX_FACTORIAL_N = 10_000`, `MAX_ABS_VALUE = 10**50_000` (checked
after **every** arithmetic/call result, not just at `Pow`, so growth is
stopped at most one operation after crossing the threshold — a single large
`**` doesn't blow up, but neither does a chain of smaller-looking `*`s that
compounds past the bound).

**Grammar shape — the "genuine check" requirement, closing Finding 5's
class at the grammar level instead of a downstream heuristic**: zero or
more `name = <expr>` assignment statements, followed by exactly one final
bare-expression statement whose **top-level node must be `Compare`,
`BoolOp`, or `Call`** (`validate_final_shape`) — a bare literal, a bare
variable reference, or a bare arithmetic expression as the final line is
rejected outright, before ever being evaluated. At runtime, that final
expression must literally compute to Python's `True`/`False` — a
non-boolean result (e.g. a plain number) is reported as an `'error'`
outcome, never treated as a pass. **Decided against supporting multi-line
scripts with the check stored in an intermediate variable and returned by
bare `Name` reference** (e.g. `ok = (a==b)\nok`) — this would need real
dataflow tracing to distinguish a genuine deferred check from an unrelated
final `True`, which the task's own framing and this project's established
convention (documented, accepted residual gaps over speculative complexity)
argued against; a candidate must write the comparison itself on the final
line. This is a documented, deliberate simplification, not an oversight —
see the file's own header comment.

**Honest, explicitly documented residual gap** (mirrors the exact gap
`pythonSandbox.ts`'s own Finding 5 fix accepted): a tautological literal
comparison (`4 == 4`) is still syntactically valid and not rejected. Unlike
the old design, this is a **correctness** concern only, not a security one
— a trivial check still cannot execute anything in this grammar.

### Rejection mechanism

Two independent code paths, both fail closed: (1) grammar rejection
(`{"status":"rejected","reason":...}`) — the trusted script parsed the
input, found a disallowed construct, and never evaluated it at all; (2)
runtime error (`{"status":"error","error":...}`) — the snippet fit the
grammar but hit a runtime issue evaluating it (undefined variable, division
by zero, wrong argument count, a bound exceeded, sqrt of a negative number,
a non-boolean final result). `verification.ts` maps both to `'inconclusive'`
(never `'fail'`) — a rejected/unevaluable check is not proof the answer is
wrong, matching this pipeline's existing, unchanged three-bucket contract.
Only a genuine `{"status":"result","value":true|false}` can produce `'pass'`
or `'fail'`.

### Wiring changes

- `verification.ts` rewritten: imports `evaluateRestrictedCheck` from
  `restrictedEvaluator.ts` instead of `runPythonSnippet` from
  `pythonSandbox.ts`. The old Finding-5 `hasComparison || hasNonPrintCall`
  downstream heuristic is gone entirely — no longer needed, since
  `validate_final_shape` enforces the same "genuine check" property at the
  grammar level before this file ever sees a result. `VerificationResult`/
  `VerificationOutcome`'s shape (`pass`/`fail`/`inconclusive` +
  `detail`/`stdout`/`stderr`) is **unchanged** — `solveDeep.ts` needed zero
  changes.
- `generateCandidates.ts`'s `buildVerifyInstructions()` rewritten: asks
  VibeThinker for "a verification check... evaluated by a restricted
  arithmetic evaluator, NOT a full Python interpreter" with the exact
  operator/function list spelled out, instead of "write a Python script...
  use only these stdlib imports... print VERIFIED/FAILED". Explicitly
  tells the model it's fine to omit the check entirely if the problem needs
  something outside this grammar (a loop, a simulation) rather than forcing
  an invalid one — this is what correctly routes those cases to
  `'inconclusive'` (see eval results below) instead of a malformed snippet.
- `AskMathModelTool.ts`: `checkPermissions`'s `ask` message and
  `isReadOnly`'s inline comment updated to describe the new mechanism
  (still spawns a local process per candidate, so the permission gate is
  **unchanged** — still `ask` for `deep: true`, not relaxed to `allow`,
  since that wasn't asked for and deep mode still has a real process-spawn
  side effect regardless of how safe the computation inside it is).
  `prompt.ts`'s deep-mode description updated to say "restricted
  arithmetic/logic check" instead of implying arbitrary Python execution.
- `pythonSandbox.ts`: **not deleted**, not modified beyond a large top-of-file
  banner comment marking it retired, pointing at this session and at §11,
  and stating plainly "do not attempt a round-4 name-ban patch — the shape
  is wrong, not the name list." Nothing in the live pipeline imports from it
  anymore (confirmed via `grep -rn "from '\./pythonSandbox" src` — the only
  remaining import is its own `pythonSandbox.test.ts`, kept passing
  unchanged as a historical record).

### Tests

**`restrictedEvaluator.test.ts` (new, 59 tests, all passing, real Python
subprocess per test — not mocked)**: every allowed node type/operator
computing correctly (literals, all 7 `BinOp`s, both `UnaryOp`s, all 6
`Compare`s incl. chaining, both `BoolOp`s, multi-statement `Assign`
sequences, all 13 `FUNCTION_TABLE` entries individually, `isclose` as a
bare final check); every rejected category (import, from-import, attribute
access, `eval`/`exec`/`open`/`getattr`/`setattr`/`__import__`/`print` as
call targets, a bare dangerous identifier with no call proven inert via
"undefined variable" rather than a special ban, lambda, comprehensions,
f-strings, subscript, keyword args, ternary, `not`, string/bytes constants,
tuple-assignment targets, every other disallowed statement type, a bare
non-check final expression, an assignment as the final statement, oversized
snippet, empty snippet); a dedicated **regression suite reusing the exact
exploit payloads from Sessions 8/9/10** — `z = __import__; z(...)`,
`operator.attrgetter`, `typing.get_type_hints` string-eval,
`enum.bltns.__import__(...)`, `str.format` globals-leak, and the round-3
finding that ended `pythonSandbox.ts`, `dataclasses.inspect.os.system(...)`
and `statistics._random._os` — all confirmed rejected, not because their
specific names are banned, but as a permanent, concrete record that the
grammar cannot express any of them; runtime-error classification
(division/floor-division/modulo by zero, undefined variable, wrong arg
count, `factorial`/`pow` bounds, `sqrt` of a negative number); the
documented tautology residual gap; and evaluator plumbing (fails closed
with no interpreter found, timeout honored under an unreasonably tight
budget since the grammar can't express a genuine infinite loop to test
against, unlike `pythonSandbox.test.ts`'s old "kills a real `while True`"
test).

- `verification.test.ts`: rewritten for the new grammar and mechanism (11
  tests) — extraction unchanged, classification updated: `import os` still
  correctly `'inconclusive'`/"not executed" (now via grammar rejection, not
  an import-allowlist check), a bare `True` is `'inconclusive'`/"not
  executed" (grammar-rejected, not a downstream "too trivial" heuristic
  anymore), `4 == 4` now genuinely `'pass'`s (the documented residual gap,
  asserted explicitly rather than hidden), `isclose(...)` alone `'pass'`es,
  runtime errors (undefined variable) `'inconclusive'`, timeout
  `'inconclusive'`.
- `generateCandidates.test.ts`: `buildDeepPrompt` test updated to check for
  the new function-table vocabulary (`isclose`, `sqrt`) instead of the old
  `VERIFIED` sentinel wording.
- `solveDeep.test.ts`: `PASSING_SNIPPET`/`FAILING_SNIPPET` fixtures updated
  to the new grammar (`computed = 2 + 2\nexpected = 4\ncomputed ==
  expected`, no `print`) — all 6 pre-existing behavioral tests (early-exit,
  reranker fallback, self-consistency fallback, bounded retry,
  best-effort-unverified, N-cap) pass unchanged in intent.
- `AskMathModelTool.test.ts`: `checkPermissions`/`isReadOnly` tests
  unchanged in behavior; one test description updated (no longer claims a
  temp file is written, since the new mechanism doesn't write one).
- `pythonSandbox.test.ts`: **unchanged, still 68/68 passing** — the file's
  own logic wasn't touched, only a banner comment was added above it.

Full `AskMathModelTool/` directory: **179/179 pass** (10 files, including
every live test in scope). Scoped self-verification command (`bun test
src/tools src/services/tools src/bridge
src/utils/promptShellExecution.test.ts src/utils/ripgrep.test.ts`):
**263/263 pass**, 0 fail, across 26 files — identical pass count to before
this session's changes, confirming nothing else regressed.

### `solveDeep.live.test.ts` — re-verified live end-to-end with the new evaluator, four separate real runs

Run four times total this session (standalone, inside the `AskMathModelTool/`
directory run, inside the full scoped suite twice), each a real HTTP call to
VibeThinker-3B and a real spawned `python.exe` running the new restricted
evaluator. All four produced a genuinely different, real (model-sampled,
not templated) restricted-grammar check and all four correctly classified
`code-verified`/`VERIFIED: true` on the first candidate:
```
Final answer: 391
```python-verify
computed = 17 * 23
computed == 391
```
VERIFIED: true   METHOD: code-verified   CANDIDATES: {generated:1,passed:1}
```
(the other three runs independently produced `computed = ((17+23)**2 -
17**2 - 23**2) // 2` twice — the same algebraic-identity style Session 6
saw under the old mechanism — and a third equivalent restatement, all
correctly evaluated by the new grammar).

### `scripts/eval/deepSolveEval.ts` re-run live against the new evaluator: 6/6 → 6/6, zero cases shifted to `inconclusive`

Ran the full 6-case set live twice (`--n 2`), matching Session 6's own
evaluation protocol. **Result: single-shot 6/6, DeepSolve 6/6 — all six
`code-verified` on the first candidate (`candidates=1, retried=false`),
including both cases marked `[HARD]`.** Full transcript in
`reports/eval-deep-solve.md`/`.json` (overwritten from Session 6's run).

**This directly tests, and updates, this task's own prediction.** Going in,
the expectation was that `deep-6-classic-rate-trick` (the "two trains and a
bird" problem) — the master plan's own named example of a case that "needs
a loop or a data structure to simulate something" — might now fall through
to `'inconclusive'` under the narrower grammar, since Session 6's original
run needed the old (now-retired) arbitrary-Python mechanism. **That did not
happen in this run.** The actual snippet VibeThinker produced was a direct
closed-form recomputation, not a simulation:
```python-verify
90 * (300 / (70 + 50)) == 225
```
— i.e. it independently reached for "closing speed × time-to-meet", which
fits entirely inside Tier 1's grammar (plain arithmetic, no loop needed).
The **trap** in this problem is in the *solving* step (naively integrating
the bird's back-and-forth flight instead of recognizing total-time ×
bird-speed) — a competent *verification* of the correct answer doesn't
require simulating the back-and-forth at all, so this particular "hard"
case turns out not to be a real example of the narrowed-grammar cost after
all. `deep-5-modular-exponentiation` also used the new function table
directly and correctly: `computed = pow(7,100,13)\ncomputed == 9` — good
independent confirmation the model understood the new 3-arg `pow` from the
rewritten prompt with zero examples given. **Net finding: this session's 6
existing eval cases do not demonstrate the "narrows what's checkable" cost
the master plan documented as real and expected** — that cost is real in
principle (a genuine simulate-and-compare check, e.g. modeling discrete
timesteps or a data structure, is still correctly unexpressible and would
correctly fall to `'inconclusive'`) but this particular case set doesn't
happen to exercise it. Growing `deepSolveCases.ts` with a case that
*forces* a simulation-shaped check (not just a "hard" problem generally) is
the natural way to actually observe this tradeoff, and remains open (see
Open Items).

### Verification performed

- `npx tsc --noEmit`: **3521 errors — exactly matching Session 9's
  documented baseline, zero new** (grepped specifically for
  `restrictedEvaluator`/`AskMathModelTool`/`deepSolve` in the diff — zero
  matches beyond pre-existing baseline noise).
- `bun run build`: clean.
- Scoped self-verification (`bun test src/tools src/services/tools
  src/bridge src/utils/promptShellExecution.test.ts
  src/utils/ripgrep.test.ts`): **263/263 pass**, 0 fail, across 26 files —
  run twice, identical both times.
- `bun run eval:deep-solve -- --n 2`: 6/6 single-shot, 6/6 DeepSolve, all
  `code-verified`, zero `inconclusive` — see above.
- `solveDeep.live.test.ts`: 4 separate live runs, all correct — see above.

### Security review — REQUIRED before this is treated as safe to leave reachable, not yet done

Per this project's own established discipline for this exact surface
(Sessions 8/9/10), **this build does not declare itself safe** — an
independent security-audit-agent dispatch is the next required step before
`deep: true` (already reachable today, unchanged from before) should be
considered settled. What's different this time, worth the auditor knowing
up front: the mechanism is architecturally much smaller (one file, ~500
lines including the embedded Python and its own extensive header comment,
vs. `pythonSandbox.ts`'s ~900 lines across three rounds of denylist
patches) and the safety argument does not depend on enumerating dangerous
names at all — the auditor's job is to check whether the **allowlist** is
actually closed (every AST node type the walker's `evaluate()`/
`validate_expr()` dispatch does NOT have an explicit branch for is
rejected, with no silent fallthrough) rather than to hunt for a missed
denylist entry. Concrete things worth an independent look:

- Whether `validate_expr`/`evaluate`'s `isinstance` dispatch chains have
  any node type that could reach a branch handling it as something other
  than "disallowed" — e.g. whether Python's own AST ever represents two
  different source constructs with the same node class in a way that lets
  something disallowed slip through a check meant for something allowed
  (this session did not find one, but didn't set out to disprove it either).
- Whether the `_finalize` magnitude/type bound (`MAX_ABS_VALUE = 10**50_000`,
  checked after every operation) is actually sufficient against every
  combination of the 7 `BinOp`s and 13 functions, or whether some
  combination this session didn't think of can still compound faster than
  the per-operation check catches it within the timeout window.
- Whether `MAX_CALL_ARGS = 20` / `MAX_STATEMENTS = 25` / `MAX_NODES = 300` /
  `MAX_SNIPPET_CHARS = 4_000` are individually and jointly sufficient
  against a pathological-but-grammar-valid input (e.g. very deeply nested
  arithmetic within the 300-node/60-depth budget) causing excessive
  interpreter recursion or CPU time within the timeout.
- Whether `validate_final_shape`'s Compare/BoolOp/Call requirement, combined
  with the runtime True/False requirement, actually closes the "genuine
  check" concern as claimed, or whether there's a construction this session
  didn't consider (beyond the documented, accepted tautology gap).
- A fresh read of `evaluateRestrictedCheck`'s process-spawn plumbing
  (`restrictedEvaluator.ts`, the TypeScript half) for parity with
  `pythonSandbox.ts`'s already-reviewed patterns (`shell: false`, minimal
  env, timeout + no shell injection surface) — this session deliberately
  duplicated the small amount of shared plumbing (`resolvePythonInterpreter`/
  `buildMinimalEnv`) rather than importing from the retired file, for
  independent auditability of this file on its own; worth confirming that
  duplication didn't introduce a subtle divergence.

### Not touched, per the task's explicit scope

`python-bridge/`, the semantic-tool-pre-filter work
(`src/services/api/toolPreFilter.ts`, `src/memdir/embeddingClient.ts`), and
the sibling `openclaude` repo — none were referenced by this session's work.

## Open items for next session

- ~~Independent re-audit of both DeepSolve security rounds~~ **Done — see
  Session 10 above.** Verdict: not safe, a third bypass class found
  (attribute-reachable `os`/`builtins` via `dataclasses`/`statistics`, no
  import call, invisible to both the linter and the runtime guard). Session
  10's architectural decision point was resolved in Session 11: **Tier 1
  (restricted numeric AST evaluator, `deepSolve/restrictedEvaluator.ts`)
  built and wired into the live pipeline in place of `pythonSandbox.ts`**,
  which stays retired (not deleted, not revived). ~~Still needs an
  independent security-audit-agent pass before being considered settled~~
  **Done — see Session 12 above.** Round-4 audit verdict: **SAFE TO SHIP**,
  no HIGH/MEDIUM findings, after being explicitly tasked with finding a new
  bypass class rather than re-confirming old ones. Two non-blocking
  correctness gaps it found (non-finite-literal magnitude bypass, a
  multi-statement `Pow`-chain magnitude blowup) are fixed and
  regression-tested. This surface is now considered settled; Tier 2 (real
  OS/WASM isolation for the arbitrary-code subset the restricted grammar
  can't express) remains deliberately deferred, not built.
- Grow `deepSolveCases.ts` toward the master plan's own ≥20-problem gate
  with genuinely harder cases (this session's two "hard" picks turned out
  to be within VibeThinker's single-shot reach) — needed to actually
  measure the "beats single-shot" claim rather than just confirming the
  machinery works. **Session 11 addendum**: also add at least one case that
  genuinely *requires* a simulation/loop-shaped verification (not just a
  "hard" problem generally) — the current 6-case set doesn't exercise the
  Tier 1 restricted evaluator's documented "loses arbitrary-algorithm
  verification" cost at all (even the "two trains and a bird" case turned
  out to have a closed-form verification, see Session 11), so that
  real, expected tradeoff has never actually been observed happening.
- Tier 2 (real isolation for the arbitrary-code subset Tier 1 can't
  express — WASM/Pyodide preferred on native Windows, Docker-on-WSL2/gVisor
  second, per §11) is not built. Not urgent unless/until a real case
  surfaces that needs it (see the item above) — Tier 1 alone covered
  100% of the existing eval set.
- The Phase 3.5 gate's second half (a frontier-model head-to-head) —
  deliberately not attempted this session (no live paid API calls without
  explicit opt-in, matching this project's own established eval
  discipline).
- The bare full-suite `bun test` fetch-mock cross-file artifact noted
  above — same category as the already-flagged `test:provider` hermeticity
  work, not investigated further this session (out of scope, pre-existing).
- ~~Top priority: semantic tool pre-filtering~~ **Done — see Session 7
  above.** Built, verified, committed, pushed. Confirmed a no-op at today's
  tool count (discretionary tail already below the filter's threshold),
  which means the remaining 6/20 routing-eval failures are confirmed to be
  a reliability ceiling independent of tool count — the next lever needs
  to target the actual failure modes (wrong-tool hallucination,
  over-delegation on trivial prompts) directly, not menu trimming.
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

## Session 12 (2026-08-12, orchestrating session) — Tier 1 evaluator: personally re-verified, independently audited (round 4, SAFE TO SHIP), two correctness fixes applied

Picked up Session 11's hand-off directly — the restricted AST evaluator was
built and reported complete but explicitly *not* self-declared safe. Before
trusting that report, matched this exact surface's established discipline
(Sessions 8/9/10: every prior round was personally re-verified, not taken on
the building agent's word) rather than proceeding straight to an audit
dispatch.

### Personal verification (before dispatching the audit)

- Read `restrictedEvaluator.ts` in full. Confirmed directly, not just via
  its own header comment, that the untrusted snippet is never passed to
  Python's real `eval()`/`exec()`/`compile()`, that `evaluate()`'s dispatch
  has no branch that falls through to something other than "disallowed" for
  any of the excluded node types, and that `Name` Load resolves only
  against the script's own closed local dict.
- Wrote an independent 26-case empirical script (not reusing the agent's own
  test file) covering all 8 legitimate-arithmetic categories plus every
  historical exploit payload from Sessions 8/9/10 (`z = __import__`,
  `dataclasses.inspect.os.system(...)`, `statistics._random._os`,
  `typing.get_type_hints`, `enum.bltns.__import__`, `str.format` globals
  leak, bare `print("VERIFIED")`/bare `True` forgery) plus several classes
  this session added itself (lambda smuggling, list comprehension, f-string
  injection, dunder subscript access, DoS-bound triggers). **26/26 behaved
  safely** — every exploit rejected or errored, never executed.
- Ran the real suites directly rather than trusting the reported counts:
  `restrictedEvaluator.test.ts` (59 tests / 263 `expect()` calls, matched
  exactly), full `AskMathModelTool/` tree (179/179, including a live
  end-to-end run against the real local Ollama model that came back
  `code-verified`).
- Rebuilt `dist/cli.mjs` and grepped it directly: `pythonSandbox.ts`'s
  distinctive markers (`RUNTIME_IMPORT_GUARD_PREFIX`, `AST_LINTER_SCRIPT`)
  are **absent** (confirmed dead/tree-shaken), `restrictedEvaluator.ts`'s
  (`RESTRICTED_EVAL_SCRIPT`, `validate_final_shape`) are **present**.
- Confirmed `npx tsc --noEmit` unchanged at exactly 3521 (the established
  baseline, zero new), and `git status` showed nothing from this work
  committed yet.

No discrepancy found between the agent's report and direct testing — this is
the first round of this security-critical component where personal
verification found *zero* daylight between claim and reality.

### Independent security-audit-agent, round 4 — verdict: SAFE TO SHIP

Dispatched with explicit instructions **not** to just re-run the Sessions
8/9/10 exploit list (already independently confirmed above) but to hunt for
a bypass specific to this narrower allowlist architecture. Result: **no
HIGH or MEDIUM findings.** Adversarial cases tried and confirmed contained,
beyond what this session's own 26-case script covered: function-value
aliasing (`f = sqrt; f(4)`), reserved-name shadowing, the walrus operator,
`*args`/`**kwargs`-shaped unpacking, `AugAssign`/`AnnAssign`/tuple assignment
targets, NUL bytes in the source, fullwidth-Unicode homoglyph identifiers
(NFKC-normalizes consistently before both validation and evaluation — not a
split-brain bug), complex-valued arithmetic (`(-1) ** 0.5`), and a
1:1-structural proof that the validator's depth-60 recursion limit actually
bounds the evaluator's own recursion (no separate stack-exhaustion path).
Process hygiene (`-I` isolation actually defeats a temp-dir/CWD import
hijack — verified empirically against the local interpreter, not just
asserted) and the permission-gating integration (`checkPermissions` returns
`ask` for `deep: true` on the only call path to `solveDeep`, immune to the
`acceptEdits` fast-path) were both independently re-confirmed. Also
independently re-confirmed `pythonSandbox.ts` is genuinely unreachable —
its only importer is its own test file, no barrel re-export exists.

The audit flagged four **non-blocking** items — no security/capability
impact, but worth recording exactly as reported since two were real
correctness gaps in a tool whose entire purpose is producing a trustworthy
`verified: true`/`false` signal:

- **(A, fixed this session)** A bare `Constant` node's value returned
  directly from `evaluate()` without going through the `_finalize` magnitude
  check — `x = 1e400` (a valid float literal that overflows to `inf` without
  a `SyntaxError`, since Python permits this) could plant an unbounded value
  into `env` untouched by `MAX_ABS_VALUE`. Worse, `NaN` specifically survived
  even the existing check on other code paths, because `abs(nan) >
  MAX_ABS_VALUE` evaluates `False` (all comparisons against `NaN` are
  `False` in Python) — so `y = x - x; y != y` would have resolved to a
  false `{"status":"result","value":true}`, a genuine "code-verified" pass
  on an undefined computation.
- **(B, fixed this session)** The `Pow` bound only checked the *exponent's*
  magnitude, not the resulting value. A large-int base already within
  `MAX_ABS_VALUE` (e.g. produced by a prior `x = 10 ** 10000` statement)
  raised to another bounded-looking exponent could still trigger CPython's
  eager, exact `int ** int` computation of a ~100-million-digit integer
  before `_finalize` ever saw the result — contained by the 5-10s process
  timeout, but contradicting the file's own "checked after every single
  operation" guarantee.
- **(C, fixed this session)** A stale comment in `AskMathModelTool.ts`
  claimed exactly two real-code call sites of `Tool.isReadOnly()`; the audit
  found a third (`FilesystemPermissionRequest.tsx`, UI label text only, a
  code path `AskMathModelTool` never reaches). Doc-accuracy only.
- **(D, no fix needed)** `scripts/eval/deepSolveEval.ts` calls `solveDeep`
  directly, bypassing `checkPermissions` — this is the same intentional,
  developer-invoked-harness pattern every other `scripts/eval/*` entry point
  uses (requires shell access to run at all), not a bypass of the tool's
  actual gate.

### Fixes applied (`restrictedEvaluator.ts`)

- `_finalize` now explicitly rejects non-finite floats
  (`math.isfinite(value)` check) before the magnitude comparison, closing
  both the `inf`-literal and the `NaN`-survives-the-magnitude-check paths in
  one place.
- `evaluate()`'s `Constant` branch now returns `_finalize(node.value)`
  instead of the bare `node.value`, so literals are bound-checked exactly
  like every other production point (`BinOp`/`UnaryOp`/`Call` already were).
- `Pow` now estimates the result's magnitude via `right *
  math.log10(abs(left))` (correct for arbitrary-precision int bases —
  Python's `math.log10` has a special path for big ints that avoids the
  `OverflowError` a naive `float(left)` conversion would hit) and rejects
  **before** calling `**` at all when the estimate alone exceeds
  `MAX_ABS_VALUE_EXP` (the `10**50_000` bound's exponent, now factored into
  its own named constant so the two checks can't drift apart).
- Four new regression tests added to `restrictedEvaluator.test.ts` (63
  total now, 279 `expect()` calls): the `1e400` literal, the `NaN`
  self-inequality smuggle, the two-statement `10**10000` then `**10000`
  chain (asserted to reject in well under a second — proving it's the new
  pre-check firing, not the 5s timeout), and a legitimate bounded `Pow`
  chain confirmed unaffected.
- One caught-and-fixed authoring mistake worth recording: the first attempt
  at these edits used backtick characters inside code comments *inside* the
  TypeScript template literal that holds the embedded Python script,
  which silently terminated the template literal early and broke the build
  (`error: Expected ";" but found "x"`) — caught immediately by running the
  test suite, not assumed to be fine; fixed by rewriting those comments
  without backticks.

### Verification performed (this session, after the fixes)

- `restrictedEvaluator.test.ts`: **63/63 pass**, 279 `expect()` calls.
- Full `AskMathModelTool/` tree: **183/183 pass**, 504 `expect()` calls.
- `bun run build`: clean. `npx tsc --noEmit`: **3521, unchanged**.
- Direct empirical re-check of both fixes via `evaluateRestrictedCheck`
  outside the test framework: the `inf` literal, the `NaN` smuggle, and the
  `10**10000` Pow chain all now resolve in well under 200ms with an
  `'error'` outcome (not the 5000ms timeout), and the legitimate bounded
  `Pow` chain still resolves correctly to `true` — confirming the fixes are
  genuine pre-checks, not accidentally relying on the timeout to mask a
  still-slow path.

### Status: Tier 1 restricted evaluator considered safe to ship

Both this session's own empirical adversarial testing and the independent
security-audit-agent's round-4 review — deliberately tasked with finding a
*new* bypass class, not re-confirming old ones — agree: no code-execution,
sandbox-escape, or permission-bypass path exists in this design. The two
correctness gaps found are fixed and regression-tested. `pythonSandbox.ts`
stays retired (not deleted, not revived) exactly per §11's resolution.
Tier 2 (real OS/WASM isolation for the arbitrary-code subset Tier 1 still
can't express) remains deliberately deferred, unchanged from Session 11's
assessment — no case in the current eval set has yet demonstrated needing
it.

### Not touched, per scope

`python-bridge/`, semantic-tool-pre-filter work, the sibling `openclaude`
repo — none referenced this session.

## Session 15 (2026-08-13, provider-router-agent) — Lever F shipped (real gain, gate not cleared); Lever G built, measured, found to regress accuracy, shipped OFF by default

Picked up `LOCAL_AI_MASTER_PLAN.md` §6's two evidence-cited levers (F, G)
added by the project owner directly in session 13/14, per that section's own
sequencing: try F first (cheap, prompt-only); only build G if F alone
doesn't clear the ≥90% routing-eval gate.

### Lever F — few-shot examples in the router prompt (`src/services/api/routerFewShot.ts`, new)

Three illustrative prior-turn examples (table→`DataAnalyze`, math→
`AskMathModel`, trivial-math→no-tool-needed with a real answer), shaped as
real OpenAI-wire-format `user`/`assistant` message pairs (the assistant turn
uses `tool_calls` for the two delegation examples, plain text for the
no-tool example) — matching the Meta-Tool ablation's actual "few-shot
examples" arm, not prose instructions. Ordered `DataAnalyze` → `AskMathModel`
→ no-tool-needed, with the no-tool example placed last (closest to the real
conversation) to weight it most via in-context recency bias, since 3 of the
6 known baseline failures are over-delegation.

Gated via `shouldApplyRouterFewShot(baseUrl, isToolCallRecoveryModel,
hasTools)` — local-only (`isLocalProviderUrl`) AND tools actually offered
this turn AND not a tool-call-recovery-listed model (VibeThinker). The
`hasTools` conjunct is new relative to the existing `think`/
`reasoning_effort` local-only gate and matters: it's what keeps this from
firing on a non-tool-selection local call (e.g. a future compaction/
summarization call reusing the router model) — confirmed via code reading
that no such call exists today anyway (`AskMathModelTool`/`DocumentQATool`/
`ImageCaptionTool`/`DataAnalyzeTool` all bypass this shim's
`beta.messages.create()` entirely for their own specialist calls — see
`routerFewShot.ts`'s own header comment for the full trace), so this is
verified defense-in-depth, not a load-bearing distinction today.

Wired into `openaiShim.ts`'s `_doOpenAIRequest` (inserted into `openaiMessages`
right after the system message, before the real conversation, immediately
before `body` is constructed — so every downstream consumer sees the same
augmented list). 12 new tests in `routerFewShot.test.ts` plus 7 regression
tests added to `openaiShim.test.ts` (gate wiring, insertion point, exclusion
for recovery models/no-tools/remote URLs).

**Result: 70.0% (14/20) baseline → four full 20-case eval runs at
80.0%/85.0%/75.0%/75.0% (16, 17, 15, 15 correct)** — average 78.75%, a real,
reproducible, substantial improvement, but **the ≥90% gate was not reliably
cleared in any single run**. Per-run failure patterns varied (real model
sampling variance, not a harness bug — `distractor-3`'s wrong tool changed
across runs, `distractor-5` flipped between correct/over-delegation/
run-error) but `math-3` (multi-step 4-digit word problem) was wrong in every
run regardless of lever — the hardest case in the set across every
configuration tried this session and in every prior session too (baseline:
`Grep`; F-only: `DataAnalyze` or `Grep`; see below for G's results on it).
Per the plan's own instruction ("if this alone reaches ≥90%: stop here"),
this did not clear the gate, so Lever G was built next.

### Lever G — grammar-constrained tool selection via `response_format` (`src/services/api/routerConstrainedToolSelection.ts`, new)

Built exactly as the master plan's corrected design prescribes: never use
Ollama's native `tools` path for the router's tool-*selection* decision
(confirmed via the plan's own research that Ollama's `tools` path is
genuinely unconstrained — no GBNF grammar built from it). Instead, build one
JSON Schema — `oneOf` of one branch per registered tool
(`{tool: <const name>, arguments: <that tool's own sanitized input_schema>}`)
plus a `{tool: "none", answer: <string>}` branch — and send it via
`response_format` *instead of* `tools`, never alongside it (empirically
reconfirmed the "Constraint Tax" landmine live before writing any code: a
`tools`+`response_format` request against `qwen3-router:1.7b` hung past 40s
with no output). Decode the resulting JSON defensively
(`decodeToolDecision`: malformed JSON, non-object response, a tool name
outside the registered set — defense in depth even though the grammar
should make this inexpressible — and missing/non-object `arguments` are all
handled as `{kind:'invalid'}`, never thrown) back into the exact same
`tool_use`/text content-block shape `_convertNonStreamingResponse` already
produces, so `toolExecution.ts`/the permission pipeline need zero changes.

**Research performed before writing implementation code** (per the task's
own instruction to verify technical uncertainty directly rather than
guess), all against this project's real `qwen3-router:1.7b` tag: confirmed
live that Ollama's OpenAI-compat `response_format`/`json_schema` genuinely
supports `oneOf` discriminated unions with `const` discriminators (a 3-branch
test and a 15-branch scale test — representative of this profile's real
~13-tool count — both compiled and responded correctly, the 15-branch case
in 1.66s including compile); confirmed the Constraint Tax finding directly
(above); confirmed `sideQuery`-style non-streaming callers and the main
`claude.ts` streaming loop (`stream: true` always, confirmed by reading the
call site) both need to be served correctly, which is why this module
always does its own internal non-streaming Ollama call regardless of what
the caller asked for, then either returns the plain message object or wraps
it via a new `messageToStreamEvents()` generator (hand-built, not reusing
`openaiStreamToAnthropic` — deliberately, to avoid touching that sensitive
shared code path at all) depending on `effectiveParams.stream`.

**Wiring**: intercepts in `OpenAIShimMessages.create()`, *before* the normal
`_doRequest`/`_doOpenAIRequest` path is invoked — when the gate applies and
`runRouterConstrainedToolSelection()` succeeds, it fully replaces the normal
request for that turn (lever F's `tools`-shaped few-shot never even runs,
since it lives inside `_doOpenAIRequest`); on any failure (network error,
non-200, malformed JSON, invalid decision) it returns `null` and falls
through unchanged to the normal path, where F may then apply. Confirmed via
a dedicated regression test that the returned stream carries the
`controller` property `claude.ts`'s own stream-vs-error-message check
depends on (`if (!('controller' in e.value))`).

**Specialist-call scope confirmed unaffected**, per the task's explicit
request: `AskMathModelTool`/`deepSolve/generateCandidates.ts` fetch
VibeThinker directly with their own bare completion payload, never through
`beta.messages.create()`; `DocumentQATool`/`ImageCaptionTool`/
`DataAnalyzeTool` call the Python bridge over plain HTTP. Neither path is
reachable from this module. The `isToolCallRecoveryModel` exclusion is
defense in depth on top of that, verified the same way as F's.

### A real bug found and fixed during development: missing tool descriptions

First live full-eval run (`reports/after-lever-g-run1/`) scored **35.0%
(7/20) — a regression against both the untouched 70% baseline and lever F's
~79% average.** Investigated rather than shipped blind (per this project's
own established discipline for this exact kind of surprising result):
captured the actual raw model output for a failing `ImageCaption` case via
temporary debug logging and found the model fabricating a plausible-sounding
but entirely made-up image description instead of delegating, because
**`buildToolDecisionSchema()` only ever encoded tool *names* and *argument
shapes* — never each tool's actual `description` text.** Native `tools`-based
calling gets a model's fine-tuned tool-awareness "for free" via Ollama's own
chat-template rendering of each tool's description; this module's raw JSON
Schema has no natural place for that, so without deliberately adding it back
the model had zero semantic information about what `ImageCaption` or
`DataAnalyze` even do. Fixed: `buildToolCatalogText()` +
`appendToolCatalogToSystemMessage()`, appending a plain-text "available
tools" catalog (name + real description) to the system message. Verified
live on the exact failing case (ImageCaption correctly delegated afterward,
confirmed via the same debug capture) before re-running the full eval.

**Second full eval run (`reports/after-lever-g-run2/`) also scored 35.0%
(7/20)** — the catalog fix genuinely fixed `ImageCaption` (5/5 correct, up
from 0/5) but the *docqa* category went the opposite direction (0/5, all
mis-routed to `DataAnalyze` — up from 1/5 wrong in run 1) and the *math*
category also went fully wrong (0/5, all self-computed "none" instead of
delegating — up from 0/5 already-wrong-but-differently in run 1). Net score
unchanged, failure distribution shifted. This is a genuine, reproducible
negative result across two independent full runs, not a shallow bug —
documented honestly rather than glossed over, matching this project's own
established practice for surprising findings (see the DeepSolve
code-execution sessions).

**One more experiment tried, not shipped**: temporarily allowing the
constrained-selection call to reason (`think`/`reasoning_effort` left
unset instead of forced `none`) fixed the specific failing `docqa-5` case
live (correct `DocumentQA` call, tool executed, correct 0.98-confidence
answer) but at 3-4x latency cost (85.7s vs ~15-25s) and surfaced a **new**
bug — a leaked `</think>` tag prefix in the decoded `answer` text for the
no-tool case (this module doesn't currently reuse
`AskMathModelTool/thinkTrace.ts`'s `stripThinkTrace`, unlike the paths that
already need it). `math-3` was still wrong even with reasoning enabled.
Not pursued further within this session's time budget — flagged as a
concrete, partially-promising direction for whoever picks this up next
(see "Open items" below), not silently dropped.

**Root-cause hypothesis, stated as a hypothesis, not a proven fact**: bypassing
Ollama's native `tools` decoding path for `response_format` also bypasses
whatever fine-tuned "should I call a tool at all, and which one" judgment
the base model learned specifically for native tool-calling — grammar
constraints make an invalid tool *name* structurally inexpressible, but they
don't restore that judgment, and a raw JSON-schema decision with
`reasoning_effort: 'none'` gives the model no room to weigh several
paragraph-length tool descriptions against each other before committing.
This is a real gap in the master plan's own evidence base: the cited
XGrammar-2 result (constrained 3B beats unconstrained 70B on BFCL) measured
constraining *within* the native tool-calling grammar on a direct
XGrammar/vLLM stack — a fundamentally different mechanism from replacing
`tools` with `response_format` entirely, which is the only thing Ollama
actually exposes. Not fully diagnosed to the last detail (a controlled
ablation isolating "no descriptions" vs "no few-shot" vs "no reasoning" as
independent variables would take another session), but not needed to reach
the practical decision below.

### Decision: Lever G shipped, but OFF by default

Given two independent full-eval measurements both landed at 35% — a clear
regression versus both the 70% baseline and F's ~79% average — leaving this
wired as the default behavior for the `ollama` profile the moment it's
built would make things *worse* than what a user already has today. Matches
this project's own established discipline for a feature that doesn't clear
its own bar (see the DeepSolve code-execution mechanism: "built and
tested... does not declare itself safe... nothing wired into any
default/always-visible path"). Concretely: `shouldApplyRouterConstrainedSelection()`
now takes a 4th parameter, `enabled`, and requires
`OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION` to be explicitly truthy on
top of every other conjunct (`openaiShim.ts`'s `create()` computes it via
`isEnvTruthy(process.env.OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION)`,
matching this project's existing `OPENCLAUDE_DISABLED_MCP_SERVERS` naming
convention). **Not set in `.openclaude-profile.json`** — left for the
project owner to flip on deliberately if they want to keep experimenting
(e.g. against a larger/different router model, or after finishing the
think-enabled variant), not silently active. The module itself is fully
built, wired, and tested — nothing was deleted or left half-working, matching
this project's own "flag the tradeoffs honestly, don't force a decision
under time pressure" precedent.

**Final default-shipped-state re-verification** (G off, matching what
actually ships): re-ran the full 20-case eval once more with the
opt-in unset — **75.0% (15/20)**, squarely inside lever F's already-measured
75-85% range, confirming G being off doesn't regress anything and the
shipped default state is exactly "lever F alone."

### Tests

`routerFewShot.test.ts` (15 tests, encode/insertion logic in isolation),
`routerConstrainedToolSelection.test.ts` (40 tests: gate function including
the off-by-default conjunct, `buildToolDecisionSchema` encode direction —
including the empty-tools/no-input-schema/incompatible-keyword-stripping
edge cases, `decodeToolDecision` decode direction — including every edge
case the task explicitly called out: malformed JSON, a JSON array/primitive
instead of an object, a tool name outside the registered set, missing/
non-object `arguments`, empty input, `messageToStreamEvents` for both
`tool_use` and plain-text/empty-content messages, and
`runRouterConstrainedToolSelection` orchestration against a mocked `fetch`
covering success, every documented fail-open path, the tool-catalog
regression test, and confirming `tools`/`tool_choice` are never sent
alongside `response_format`), plus regression tests added to
`openaiShim.test.ts` (11 new tests: F's wiring, G's off-by-default
behavior, G's stream:true/stream:false wiring when explicitly enabled, and
G's fail-then-fallback path with per-request body assertions).

Scoped self-verification (`bun test src/tools src/services/tools src/bridge
src/utils/promptShellExecution.test.ts src/utils/ripgrep.test.ts
src/memdir --path-ignore-patterns='**/*.live.test.ts'`): **278/278 pass**,
0 fail, across 24 files. Provider-router-agent's own designated check
(`bun run test:provider` 164/164, `bun run test:provider-recommendation`
41/41, plus the wider `bun test src/services/mcp src/services/oauth
src/services/github src/memdir src/upstreamproxy
src/services/remoteAgentService.test.ts src/utils/context.test.ts
src/utils/sessionStorage.test.ts src/utils/conversationRecovery.test.ts
src/utils/conversationRecovery.hooks.test.ts src/utils/toolResultStorage.test.ts
src/utils/githubModelsCredentials.test.ts
src/utils/githubModelsCredentials.hydrate.test.ts src/utils/buildConfig.test.ts
src/utils/model/providers.test.ts`): 82/84, the exact 2 pre-existing
`remoteAgentService.test.ts` vitest/bun-mocking-gap failures documented
since Session 3, unrelated to this session (same file, same failure class,
confirmed by re-reading that session's own diagnosis rather than assuming).
`npx tsc --noEmit`: **3521 errors — exactly matching the documented
baseline, zero new** (confirmed repeatedly through several rounds of
edits, not just once). `bun run build`: clean every time; confirmed both
`routerFewShot`/`routerConstrainedToolSelection` markers and the
`OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION` gate string are present in
the compiled `dist/cli.mjs`.

### Open items for next session

- Lever G's think-enabled variant is a concrete, partially-promising
  unfinished direction: fixed the one case it was tried on live, but needs
  (a) `stripThinkTrace` (or equivalent) applied to the decoded `answer`
  field before it reaches the user, (b) a full eval run to see whether the
  latency cost (3-4x) is worth whatever accuracy gain it nets across all 20
  cases rather than the one case tested, and (c) a decision on whether it's
  a fixed always-on behavior for G or its own separate opt-in.
- A controlled ablation isolating G's three additive pieces (tool
  descriptions / few-shot examples / reasoning on-or-off) as independent
  variables would properly diagnose why G underperforms instead of the
  hypothesis-stated-as-hypothesis above — not done this session (time
  budget), flagged as the honest next step rather than a guess dressed up
  as a finding.
- `math-3` (the 4-digit-ticket-sum word problem) was wrong in literally
  every configuration tried across this session and prior sessions
  (baseline, F-only ×4, G ×2) — worth a dedicated look at why this specific
  case is so much harder than the other math cases for this model, separate
  from the general routing-reliability work.
- The ≥90% Phase-1 gate is still not met (best single-run result to date:
  85% with lever F). Next levers per `LOCAL_AI_MASTER_PLAN.md` §6 that
  haven't been tried: the qwen3:4b-instruct path is closed (Session 5,
  hardware-rejected on this machine), but nothing rules out revisiting with
  different hardware; the think-enabled G variant above; or a genuinely
  different mechanism not yet in the plan.

### Not touched, per scope

`python-bridge/`, the sibling `openclaude` repo — neither referenced this
session. `LOCAL_AI_MASTER_PLAN.md`'s and `scripts/eval/deepSolveCases.ts`/
`scripts/eval/README.md`'s uncommitted working-tree changes predate this
session (confirmed via `git diff` before starting — this session only ever
read `LOCAL_AI_MASTER_PLAN.md`, never wrote to it) and were left exactly as
found.

## Session 16 (2026-08-13, orchestrating session) — Session 15 independently re-verified, zero discrepancies; unrelated Ollama stuck-service incident found and fixed during verification

Picked up immediately after session 15's completion notification, matching
this project's established discipline for every prior round of this kind of
work: personally verify a building agent's report before trusting it, rather
than relaying its claims.

### Verification performed

- Read both new modules in full (`routerFewShot.ts`, 169 lines;
  `routerConstrainedToolSelection.ts`, 671 lines) and the full diff of
  `openaiShim.ts` (90 lines changed) and confirmed directly: both gate
  functions match the established `isLocalProviderUrl`-based,
  gate-function-plus-apply-function shape (`toolPreFilter.ts`'s own
  convention); G's fail-open discipline is real (every failure mode —
  network error, non-200, malformed JSON, an invalid decision — returns
  `null` and falls through to the unchanged normal path, never throws);
  `decodeToolDecision` re-validates the tool name against the registered
  set even though the grammar should already guarantee it, matching this
  project's established "don't trust even a constrained mechanism blindly"
  discipline (`deepSolve/restrictedEvaluator.ts`, §11); the few-shot table
  example's argument shape (`operation: 'question'`, `table: {columns,
  rows}`, `question`) matches `DataAnalyzeTool`'s real
  `questionSchema` exactly, confirmed by reading `schemas.ts` directly, not
  assumed.
- Confirmed `OPENCLAUDE_ENABLE_ROUTER_CONSTRAINED_SELECTION` is genuinely
  unset anywhere in this repo (`.env`, `.openclaude-profile.json`,
  `package.json` all checked directly) and that `isEnvTruthy` (from
  `src/utils/envUtils.ts`, the function `openaiShim.ts` actually imports —
  confirmed by checking the import, not assuming which of this codebase's
  three same-named helper functions was used) returns `false` for
  `undefined`, so G is genuinely inert in the shipped state.
- Investigated the flagged "think-trace-leak bug" specifically before
  accepting session 15's claim that it's not currently reachable: confirmed
  the shipped `routerConstrainedToolSelection.ts` hardcodes `think: false,
  reasoning_effort: 'none'` unconditionally — the leak was only ever
  produced by a temporary, unshipped experimental edit (reasoning left on)
  that session 15 tried live and did not commit. Not reachable in the
  actual diff being verified.
- Re-ran the new test files directly: **71/71 pass** (`routerFewShot.test.ts`
  + `routerConstrainedToolSelection.test.ts` + `openaiShim.test.ts`
  together). Re-ran the scoped self-verification suite: **278/278 pass**,
  matching session 15's own reported count exactly. Rebuilt
  (`bun run build`: clean) and re-checked `npx tsc --noEmit`: **3521,
  unchanged**. Spot-checked the new regression tests' actual content (not
  just their pass/fail count) for the `controller`-property stream check
  and the off-by-default test — both present and asserting what session
  15's report claimed.

### Independent live routing-eval re-verification — and an unrelated operational incident found along the way

First live re-run (nothing else running concurrently) produced a deeply
suspicious pattern: 11 cases succeeded normally, then the remaining 9 (every
case from `routing-caption-2` onward) failed identically at the exact 45s
timeout ceiling. A second immediate re-run was worse: **all 20 cases**
timed out identically from the very first case. This did not look like a
real accuracy signal (a genuine router failure wouldn't produce byte-
identical 45.0xx-second timeouts case after case) — investigated rather
than reported blind, matching this project's own standing discipline for
a surprising result.

**Root cause, confirmed step by step, not assumed:**
1. `ollama ps`/`ollama api/tags` responded fine (Ollama's lightweight
   metadata endpoints were healthy), but a bare `curl` directly to
   `/api/chat` — no CLI, no tools, no few-shot, none of this session's or
   session 15's code involved at all — hung for a full 90 seconds with zero
   response. This conclusively ruled out anything from today's work as the
   cause before touching any Ollama process: the generation pipeline itself
   had gotten stuck while the HTTP server around it stayed up.
2. Restarted Ollama (`taskkill` both `ollama.exe` and `ollama app.exe`,
   relaunched). The GUI-wrapped `ollama app.exe` failed to bring its own
   server subprocess up cleanly when launched from this non-interactive
   shell ("ollama server not ready after retries") — worked around by
   launching `ollama.exe serve` directly instead.
3. That fresh server reported `{"models":[]}` and `"total blobs: 0"` —
   alarming at first glance, but verified (before concluding anything about
   data loss) that this project's models live at a **non-default path**
   (`C:\Users\allge\AI Models`, not the default `~/.ollama/models` — per
   this session's own persistent memory note) which the manually-launched
   server hadn't been pointed at. Confirmed all 20 blobs and every expected
   manifest (`qwen3-router:1.7b`, `qwen3:4b`, `qwen3:1.7b`, `all-minilm`,
   the Qwen3-Reranker and VibeThinker GGUF pulls) were fully intact on disk
   at that path before doing anything further — **no data was lost**, this
   was purely a matter of which path the freshly-launched process was told
   to scan.
4. Relaunched with `OLLAMA_MODELS` set explicitly to the correct path — all
   6 models reappeared immediately. A first post-restart generation request
   still needed ~21s just for `llama-server`'s own cold-start (confirmed via
   the server's own log, not guessed) before a 30s client timeout was long
   enough; a second request against the now-warm runner completed correctly
   in ~21s total with a normal, correct answer ("5 + 3 = 8").

**Operational note for future sessions** (the actual, useful takeaway,
recorded so this doesn't need re-diagnosing next time): if Ollama's
metadata endpoints (`/api/tags`, `/api/ps`) respond but real generation
requests hang indefinitely, this is a known failure mode on this machine —
restart via `ollama.exe serve` directly (not the `app.exe` GUI wrapper,
which does not reliably bring its server subprocess up when launched from
a non-interactive/background shell) with `OLLAMA_MODELS="C:\Users\allge\AI
Models"` set explicitly (the non-default model path this project actually
uses), and budget ~20s for the first request after restart before
concluding it's still broken.

**With Ollama healthy again, a clean full 20-case run scored 15/20
(75.0%)** — independently reproducing session 15's own reported 75-85%
range almost exactly (one case, `routing-math-1`, still hit a run-error,
plausibly residual cold-start slowness immediately after the restart,
consistent with the ~20s-cold-start finding above; every other case behaved
normally). This is treated as the trustworthy confirmation number, not the
two contaminated runs before it, which are not representative of the
router's real behavior and are disregarded rather than reported.

### Verdict

Zero discrepancies found between session 15's report and this session's
independent verification, across code review, test re-execution, build/tsc,
and a from-scratch live eval run. Session 15's work is confirmed accurate
and safe to commit as reported: lever F shipped and active (real,
reproducible ~5-15 point gain), lever G built, tested, and correctly gated
off by default after a measured regression. `LOCAL_AI_MASTER_PLAN.md`
Phase 1's status updated to match. Not a security-sensitive surface per
`.claude/hooks/security-gate.ps1`'s own path pattern (`src/services/api/`
isn't in it — consistent with sessions 5 and 7's earlier `openaiShim.ts`/
`claude.ts` changes, neither of which needed a security-audit-agent pass
either), so no audit dispatched; verification here was code review + live
measurement, matching what this exact class of change has always required
in this project.

### Not touched, per scope

`python-bridge/`, the sibling `openclaude` repo, Tier 2 (DeepSolve's
deferred code-execution isolation) — none referenced this session.
