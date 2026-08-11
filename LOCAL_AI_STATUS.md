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

## Open items for next session

- **Not yet re-verified**: a full interactive REPL test with Qwen3 making
  its own delegation decisions naturally, now that the `/think` fix +
  rebuild are in. The one live REPL test done this session surfaced the
  `/think` bug (now fixed) — should re-run the same prompts
  (`847 × 293`, `12 × 7`, a document-QA-shaped question, an image-caption
  request) to confirm delegation actually happens correctly end-to-end.
- Wire up Qwen3-Reranker-0.6B — natural next step, pairs with the existing
  embedding pre-filter for genuine two-stage retrieval.
- Extend `python-bridge/` to more of the ~20 unused downloaded models —
  `python-bridge/README.md` documents the exact pattern (copy
  `document_qa.py`/`image_caption.py`'s lazy-load structure, add a route,
  add a matching TS tool).
- **Agreed next direction (not started)**: build a small head-to-head eval
  — a handful of real test cases per specialist, run through both the
  local ensemble and a single frontier-model call, compared side by side.
  Turns "trying to overcome top-tier AI" into actual measured evidence
  instead of assumption, consistent with how skeptical this whole project
  has been about unverified claims throughout.
- The Python bridge's torch build is CPU-only (no CUDA in the reused
  venv) — fine for the two small models wired so far, worth reconsidering
  if bigger/slower models get added later.
- `toolCallRecovery.ts` (VibeThinker tool-call recovery) is fully built and
  tested but not load-bearing in the current architecture — VibeThinker is
  never asked to call tools itself anymore, only invoked for plain-text
  math completions. Kept as a safety net in case that changes.
