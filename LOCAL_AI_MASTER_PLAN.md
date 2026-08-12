# Local AI Master Plan — All-Purpose Agentic AI from Small Local Models

Written 2026-08-11, revised 2026-08-12 (session 2). Companion to
[LOCAL_AI_STATUS.md](LOCAL_AI_STATUS.md) (which tracks what is *actually
built and verified*; this document is the *theoretical roadmap*). If these
documents move into an agents folder later, they move together.

**2026-08-12 revision — why the phase order changed.** Session 2 built
Phase 0's remaining pieces (reranker, bridge model manager, eval harness)
and re-verified delegation live, which surfaced something the original
plan didn't anticipate: this project picked up ~40 MCP tools (mempalace,
lmstudio, graphify) between when this plan was written and now, pushing
the router's visible tool count from ~10 to ~65. §6's "future risk at 25+
tools" became a *present* blocker — the router hallucinated a call to a
nonexistent `"math"` skill instead of the real `AskMathModel` tool sitting
in its own list. The original ordering scheduled the routing fix for
Phase 1, after Phase 0's gate ("specialists pass delegation eval") — but
that gate can't pass while routing is broken. This revision moves routing
reliability to the front of the queue, adds a routing eval (nothing
measured the router's tool *selection* before — only the specialists'
answers once delegated), and adds the cheapest possible mitigation that
wasn't in the plan at all: scoping non-local-AI MCP servers out of the
router's profile, which alone might drop the menu from ~65 back to ~25
with zero code changes. See the revised §8 for the full reordering.

---

## 1. The honest definition of "all-purpose"

This plan targets an agent that is all-purpose in **breadth of modalities**,
not frontier-depth reasoning. Concretely, one offline agent that can:

| Faculty  | Meaning                                       | Backing models              |
|----------|-----------------------------------------------|-----------------------------|
| Hear     | transcribe speech/audio files                 | Silero-VAD + Whisper turbo  |
| See      | caption, detect, segment, classify, pose      | BLIP, CLIP, OWLv2, CLIPSeg, DINOv2, ViTPose |
| Speak    | synthesize speech                             | Qwen3-TTS (research item)   |
| Read     | extractive QA over documents                  | DistilBERT-SQuAD (wired)    |
| Compute  | exact math                                    | VibeThinker-3B (wired)      |
| Analyze  | table QA, tabular prediction, forecasting     | TAPAS, TabPFN v2, Chronos   |
| Create   | images, music                                 | SD 1.5, MusicGen (optional) |
| Remember | semantic retrieval over memory                | all-minilm + Qwen3-Reranker |
| Act      | files, shell, code — the existing tool suite  | openclaude-main core        |

What stays honest (per the calibrated goal in LOCAL_AI_STATUS.md): a sub-4B
router will never out-reason a frontier model. The claim this architecture
*can* make: **frontier-competitive results on each narrow specialist task,
composed into one agent, at near-zero marginal cost, fully offline.** A few
specialists (TabPFN on small tabular data, Whisper turbo on transcription)
plausibly *beat* general-purpose frontier models at their task outright —
those are the flagship cases, and the eval harness must prove or kill each
such claim.

## 2. Design principles (earned, not aspirational)

1. **Specialists never route; the router never specializes.** Proven with
   VibeThinker: reasoning-tuned small models hallucinate tool-call formats.
   Specialists are invoked *through tools* only.
2. **Eval-gated integration.** No specialist counts as "working" without
   live verification plus a small eval set. A specialist that cannot beat
   or match "just ask a frontier model" on its own task gets parked — the
   ensemble stays honest.
3. **Deterministic where possible, model where necessary.** Multi-step
   flows the router would have to plan (VAD → Whisper → summarize) become
   fixed code pipelines. Small routers should make *one* decision per turn,
   not chains.
4. **Memory is the scarce resource, not compute.** Every integration states
   its RAM/VRAM cost up front and obeys the budget manager (§5).
5. **Pin everything in shared environments** (`--no-deps`, exact versions);
   prefer concrete model classes over `pipeline()`/`Auto*` (two
   transformers-v5 breakages already). New heavy deps go in a *dedicated*
   venv — the Debate venv is borrowed and was already broken once.
6. **Follow this project's existing structure and conventions, don't
   import a different one.** This project already has a full agentic tool
   suite with its own permission/sandbox model — new work (gateway tools,
   the DataAnalyze/VisionAnalyze/AudioAnalyze pattern, bridge routes) fits
   into that structure rather than reinventing parallel mechanisms.
   Concretely (confirmed 2026-08-12): `image_caption.py`'s file-path
   handling stays as the security review left it (closed existence oracle,
   Host-header check) rather than growing a bespoke path-allowlist inside
   the bridge — this project's own tool/permission layer is the intended
   control surface for what a local tool is allowed to touch, not a
   second access-control system duplicated inside `python-bridge/`.

## 3. Hardware budget (the binding constraint)

- **CPU**: i7-11800H (8C/16T) — fine for all sub-1B models and quantized LLMs.
- **RAM**: 15.7 GB total. Windows + apps ≈ 5–6 GB → **realistic AI budget
  ≈ 8–9 GB RAM**.
- **GPU**: RTX 3050 Laptop, **4 GB VRAM** — unused today (bridge torch is
  CPU-only). Big untapped win: Whisper turbo fp16 (~1.6 GB) and BLIP fp16
  (~1 GB) both fit; SD 1.5 fp16 with attention slicing (~2.5 GB) fits alone.
- Baseline resident set: qwen3:1.7b (~1.8 GB with context) + all-minilm
  (~0.1 GB) + idle Python bridge (~0.4 GB) ≈ **2.5 GB**, leaving ~5–6 GB of
  headroom for on-demand specialists.

Consequence: **all 25+ models can never be resident at once.** The
architecture is lazy-load + evict, with Ollama handling its own models
(keep_alive) and the bridge needing an explicit model manager (§5).

## 4. Full capability map

### Wired and verified (from LOCAL_AI_STATUS.md)
qwen3:1.7b (router) · VibeThinker-3B (math) · DistilBERT (doc QA) ·
BLIP (captioning) · all-minilm (embedding pre-filter) · Qwen3-Reranker-0.6B
(two-stage retrieval precision pass) · the bridge model manager (budget
cap, LRU eviction, single-flight, `/status`) · a per-specialist eval
harness (`scripts/eval/`). **Not yet wired despite being "done" per the
above: reliable router tool-selection at today's ~65-tool count** — see
the 2026-08-12 revision note above and the reordered §8.

### Tier A — wire next: high value per GB, proven tech, low effort
| Model | Size | Capability | Why it earns its slot |
|---|---|---|---|
| Qwen3-Reranker-0.6B | 0.6 GB | rerank retrieval candidates | Already in Ollama; completes two-stage retrieval. Near-zero effort. |
| TabPFN-v2 (clf+reg) | 0.5 GB | zero-shot tabular ML | Genuinely SOTA on small (<10k rows) tabular tasks — a real "local beats frontier" case. |
| tapas-mini-wtq | 0.04 GB | table QA | Tiny; answers questions over CSV/tables directly. |
| chronos-t5-tiny | 0.03 GB | zero-shot time-series forecasting | Tiny; real forecasting ability LLMs lack. |
| whisper-large-v3-turbo | 1.5 GB | speech-to-text | Frontier-grade transcription; unlocks the entire audio modality. GPU-viable. |

### Tier B — the vision suite (behind one gateway tool, §6)
| Model | Size | Capability |
|---|---|---|
| clip-vit-large | 1.6 GB | zero-shot classification, image-text similarity, image search |
| owlv2-base | 0.6 GB | open-vocabulary object detection ("find the dog" → boxes) |
| clipseg-rd64 | 0.6 GB | text-prompted segmentation masks |
| dinov2-small | 0.08 GB | visual features: similarity, dedup, clustering |
| vitpose-plus-base | 0.5 GB | human pose estimation |
| videomae-base | 0.35 GB | video understanding — **caveat**: this is the pretraining checkpoint; classification needs a fine-tuned head. Research item. |

### Tier C — output modalities (optional, after A+B)
| Model | Size | Capability | Caveat |
|---|---|---|---|
| Qwen3-TTS-1.7B + tokenizer | 4.9 GB | speech synthesis | Very new; transformers support unverified. Research spike first. |
| clap-htsat | 0.6 GB | zero-shot audio classification | Pairs with VAD/Whisper for "what sound is this?" |
| stable-diffusion-v1-5 | 4.0 GB | image generation | Fits 4 GB VRAM at fp16 + attention slicing; minutes-per-image on CPU. Dated quality — nice-to-have. |
| musicgen-small | 2.4 GB | music generation | Slow on CPU; lowest agentic value. Last. |

### Parked — with reasons (revisit only with a concrete use case)
- **Silero-VAD-v5-MLX** — MLX is Apple-Silicon format; **won't run on
  Windows**. Replace with the official silero-vad ONNX build (~2 MB
  download) when doing Phase 3.
- **FLUX.2-small-decoder** — a VAE decoder only; useless without the full
  FLUX.2 pipeline (not downloaded, wouldn't fit anyway).
- **stoic** — protein stoichiometry prediction; extremely niche *and*
  requires downloading ESM2-650M (~2.5 GB) as its backbone.
- **VGGT-1B** (4.7 GB) — images → 3D geometry/depth/camera poses. Heavy,
  niche until a 3D use case exists.
- **VoxelModel-v1** — toy text-to-3D voxels, custom code.
- **ddpm-cifar10-32** — toy 32×32 unconditional generation.
- **mobilenetv3-small** — ImageNet classifier; redundant once CLIP
  zero-shot classification is wired (could return as a ~10 MB fast path if
  CLIP proves too slow).

## 5. Platform layer: the bridge model manager

The current bridge lazy-loads and never unloads. With 15+ models that
becomes an OOM machine. Before wiring anything heavy, `python-bridge/`
gets a small model manager:

- **Budget cap** (configurable, default ~4.5 GB bridge RSS) with **LRU
  eviction**: loading a model that would exceed the cap evicts
  least-recently-used models first.
- **Single-flight loading**: concurrent requests for the same model share
  one load, don't race.
- **Heavy-model exclusivity**: models flagged heavy (SD, MusicGen, TTS)
  evict everything else and load alone.
- **Device placement**: per-model `device` config (`cuda`/`cpu`) + fp16
  flag. Requires a **new dedicated venv** with CUDA torch — do not touch
  the Debate venv again. Migrate document_qa/image_caption to it; retire
  the borrowed venv. **Decided 2026-08-12: yes, build it.** CPU and GPU
  run side by side — CPU stays the default/baseline path, the GPU is the
  offset used when a model needs more headroom (bigger/slower models, or
  several models resident at once). The RTX 3050's 4 GB VRAM sits
  completely idle today; Phase 3 (Whisper turbo) wants it too, so this
  isn't optional forever, just sequenced after router reliability.
- **`/status` endpoint**: what's loaded, RAM/VRAM usage — feeds the eval
  harness and debugging.

Ollama-side models (qwen3, VibeThinker, reranker, all-minilm) need none of
this — Ollama already does keep_alive eviction. Tune `keep_alive` so
VibeThinker unloads after ~5 min idle instead of lingering.

## 6. The routing problem at scale (no longer theoretical — this is Phase 0/1 now)

A 1.7B router choosing among ~10 tools worked when this was written. By
session 2 the real count had grown to ~65 (the ~25 built-ins plus ~40
tools across mempalace/lmstudio/graphify MCP servers added in between),
and live testing confirmed the predicted degradation: the router
hallucinated a call to a nonexistent `"math"` skill instead of the real
`AskMathModel` sitting in its own list. Mitigations below, **reordered by
cost** (cheapest/lowest-risk first — try each and re-measure with the
routing eval before reaching for the next):

0. **Scope MCP servers out of the local-AI router's profile** (do this
   *first* — zero code changes). Roughly 40 of the ~65 tools are
   mempalace/lmstudio/graphify MCP servers that are your Claude-side
   tooling, not sensible delegation targets for a 1.7B local dispatcher.
   If the `ollama` profile can omit them (via `--strict-mcp-config`,
   `--disallowedTools`, or scoping `.mcp.json` loading per-profile —
   confirm which mechanism actually fits this codebase's structure rather
   than assuming), the menu drops from ~65 to ~25 with no engineering at
   all. Re-run the routing eval after this alone — it may be sufficient
   on its own, or may just buy headroom before the next steps are needed.
1. **Tool-name validation net** (cheap, catches the exact observed
   failure). When the router calls a tool name that doesn't exist, reject
   and re-prompt with the valid tool list instead of failing silently or
   letting a hallucinated call through.
2. **Domain gateway tools.** Collapse each new local-AI domain into one
   tool with an `operation` enum:
   - `VisionAnalyze(image, operation: caption|detect|segment|classify|pose|similarity, query?)`
   - `AudioAnalyze(file, operation: transcribe|classify)`
   - `DataAnalyze(table, operation: question|predict|forecast, query?)`
   Dispatch below the gateway is deterministic code, not model choice —
   this also keeps the menu from growing every time a new specialist is
   wired in later phases.
3. **Semantic tool pre-filtering** (reuses existing infra). Embed tool
   descriptions with all-minilm at startup; per user turn, expose core
   tools + top-k semantically relevant ones. This is RAG-over-tools and
   mirrors the already-proven `embeddingPreFilter.ts` pattern — target
   keeping the visible menu under ~10, where small-model tool selection
   stays reliable.
4. **Fixed pipeline tools** for known multi-hop flows, so the router makes
   one call: `TranscribeAndSummarize` (VAD → Whisper → router summarizes),
   `DescribeImageFully` (caption + detect + classify → merged report).
5. **Router upgrade path**: qwen3:4b-instruct Q4 (~2.6 GB) still fits the
   budget and is markedly stronger at tool selection. Decide by eval
   (tool-selection accuracy on a fixed prompt set, 1.7b vs 4b), not vibes
   — this is exactly the kind of call the routing eval below exists for.
6. **(Experimental) planner/executor split**: for genuinely multi-step
   requests, one think-enabled qwen3 call drafts a numbered plan; the
   router executes it step by step. Only if everything above proves
   insufficient — adds latency and failure modes.

**The instrument every one of the above needs and didn't have**: a
routing eval — roughly 20 fixed prompts (math, doc-QA, captioning, and
deliberate "no tool needed" distractors to catch over-delegation) scored
purely on *did the router pick the right tool*, independent of whether
the specialist then answered correctly (the existing `scripts/eval/`
harness already covers that half). Build this before attempting any
mitigation above — otherwise "did that help" stays a guess.

## 7. Memory & self-improvement loop

- **Two-stage retrieval everywhere**: all-minilm recall → Qwen3-Reranker
  precision, replacing "embedding-only when >15 files". Later: extend the
  same pattern to codebase search and conversation history.
- **Image memory** (after Tier B): CLIP-embed images the agent has seen;
  "the screenshot with the red error dialog" becomes a retrieval query.
- **Delegation ledger** — **moved up from Phase 6 to continuous, starting
  now** (2026-08-12 revision): log every tool delegation (query → tool
  chosen → outcome → latency). Two uses: (a) regression data for the eval
  harness, (b) evidence for tuning routing descriptions/rules. This is the
  cheap, honest version of "self-improvement" — no fine-tuning fantasy,
  just measured iteration. It's cheap enough and useful enough to router
  reliability work (§6) that there's no reason to wait for a later phase —
  every routing decision made from here on should already be logged.

## 8. Phases and gates (reordered 2026-08-12 — see revision note at top)

Each phase has an exit gate; don't start the next phase before the gate
passes. **Router reliability moved to the front of the queue** — it's the
one thing every later phase depends on (every new modality adds tools to
a menu the router already can't reliably pick from), so it's no longer
"Phase 1 platform work," it's the actual Phase 0/1 blocker.

- **Phase 0 — Baseline, instrumentation, cheapest routing fix** (mostly
  done): commit the working tree before any router surgery lands on top
  of it; re-run the interactive REPL delegation test post-`/think`→
  `reasoning_effort` fix (done — found the original fix never actually
  worked, root-caused and fixed for real); wire Qwen3-Reranker into
  two-stage retrieval (done); build the per-specialist eval harness
  (done); build the **routing eval** (§6 — not yet built, this is the
  instrument everything below needs); scope MCP servers out of the local
  profile and re-run the routing eval (§6 mitigation 0 — try this before
  any engineering).
  *Gate: routing eval exists and has a baseline score; MCP-scoping tried
  and measured.*
- **Phase 1 — Router reliability**: tool-name validation net, domain
  gateway tools, semantic tool pre-filter, qwen3:4b A/B (§6 mitigations
  1-5, in cost order, re-measuring with the routing eval after each).
  Delegation ledger (§7) runs continuously starting in this phase, not
  later.
  *Gate: routing eval ≥ ~90% AND the 4 existing specialists pass
  delegation end-to-end in the REPL — this is the original Phase-0 gate,
  now correctly sequenced after the thing that was blocking it.*
  **Status 2026-08-12: gate NOT met.** Routing eval built and run
  (`scripts/eval/routingEval.ts`) — baseline **35.0% (7/20)**, reproduced
  identically across three separate runs. MCP-scoping (mitigation 0,
  implemented and verified: `OPENCLAUDE_DISABLED_MCP_SERVERS` in the
  `ollama` profile, 71 tools → 24) fixed per-case latency 2-3x but did
  **not** move accuracy at all — the hypothesis that scoping alone might
  be sufficient (as originally written above) was wrong. Tool-name
  validation (mitigation 1) was found already present in the codebase but
  doesn't cover the actual failure modes seen. Semantic pre-filtering
  (mitigation 3) and the qwen3:4b A/B (mitigation 5) were deliberately
  **not attempted** — the eval evidence points somewhere the plan didn't
  anticipate: 8/20 failures are the router producing **zero output
  tokens** under the full production request shape for certain
  math-shaped prompts (not a wrong-tool selection at all), which no
  amount of tool-list trimming or model upsizing obviously fixes without
  first understanding it. See `LOCAL_AI_STATUS.md`'s Session 3 for full
  detail — **this is now the single most important open item in the
  entire plan.**
- **Phase 2 — Finish the platform**: dedicated CUDA venv (confirmed
  2026-08-12 — build it; never touch the Debate venv); migrate BLIP +
  DistilBERT to real GPU device placement in `manager.py` (turning the
  existing device stub into the real thing); fast-follow: make the
  `test:provider` test gate hermetic (doesn't inherit the project's own
  `.env`) and move `toolCallRecoveryIntegration.test.ts`'s live 90s
  VibeThinker call behind the same opt-in `*.live.test.ts` convention
  already used elsewhere, so it stops being nondeterministic inside a
  blocking gate.
  *Gate: stress test — 6 specialist invocations in sequence (mixed CPU
  and GPU), no OOM, no regression on the Phase-0/1 evals.*
  **Status 2026-08-12: done.** Dedicated CUDA venv built and is the
  default (`python-bridge/venv`, `torch==2.12.1+cu130`); BLIP + DistilBERT
  on real `device="cuda", fp16=True` placement, fp16 output verified
  against the fp32-CPU baseline for quality regression (none found);
  `test:provider` hermetic (env-isolated + the live VibeThinker test
  actually excluded via `--path-ignore-patterns`, not just renamed —
  the `*.live.test.ts` convention turned out to be documentation-only,
  not mechanically enforced, until this fix).
- **Phase 3 — Data & tables** (cheapest wins in the library, confirmed
  green-lit 2026-08-12): TabPFN, TAPAS, Chronos behind `DataAnalyze` — the
  first real gateway tool, arriving exactly when tool count would
  otherwise start growing again.
  *Gate: TabPFN beats a frontier-model prompt on ≥1 real small-tabular
  benchmark — the flagship "local beats frontier" demo.*
  **Status 2026-08-12: routes wired and live-verified; a dedicated eval
  (`scripts/eval/dataAnalyzeEval.ts`, `bun run eval:data-analyze`,
  superseding the earlier manual spot-checks below) quantified all three
  models — the true frontier-vs-TabPFN benchmark for this gate still
  hasn't been run, but per-model accuracy is now real data, not anecdote.**
  TabPFN: 3/4 (classification solid at >99% confidence both cases;
  regression degrades at far-out-of-range extrapolation — expected
  behavior, not a bug). TAPAS: 6/8 — same-column lookups solid (2/2),
  cross-column and aggregation questions unreliable (3/4, 1/2) — a real,
  uneven capability limit, not an integration bug (confirmed: the
  original "revenue of Gadget" spot-check failure reproduces exactly).
  Chronos: 1/3 — **narrows an earlier claim**: uncertainty bounds are
  reliably correct (3/3 both eval runs), but point forecasts on an
  obvious linear trend plateau rather than continuing it (2/2 trend
  cases failed both runs) — the earlier "looked correct" spot-check
  characterization was too generous; lean on the bounds, not the point
  forecast, until this is understood better. See `LOCAL_AI_STATUS.md`
  Session 4 for full detail.
- **Phase 4 — Hearing**: silero-vad ONNX (re-download, ~2 MB), Whisper
  turbo on GPU, `AudioAnalyze` + `TranscribeAndSummarize`.
  *Gate: transcription spot-check vs a cloud STT on 3 real recordings.*
- **Phase 5 — Full vision suite**: CLIP, OWLv2, CLIPSeg, DINOv2, ViTPose
  behind `VisionAnalyze`; fold BLIP in; CLIP image memory.
  *Gate: vision eval set (classification, detection, "find X in image").*
- **Phase 6 — Voice out & generation** (optional): Qwen3-TTS feasibility
  spike → wire if transformers supports it; SD 1.5 on GPU; MusicGen last.
  *Gate: TTS round-trip (type → hear) at acceptable latency, or documented
  park decision.*
- **Continuous, from Phase 1 onward**: delegation ledger, routing tuned
  from logs, eval suite (both specialist and routing) grows into a real
  regression harness.

### On fixing pre-existing bugs found along the way

Two unrelated pre-existing bugs surfaced during session 2's test triage
(`providerConfig.ts`'s codexplan-alias resolution, `withRetry.ts`'s
rate-limit-header parsing) — both proven pre-existing via revert-and-rerun
by independent agents, neither caused by any local-AI work. Confirmed
2026-08-12: the sibling `E:\Allan Project\Git Repo Project\openclaude`
repo (no "-main" suffix) is the actively-developed parent this project
forked from, and is available as a **read-only reference** for what the
fixed/current version of shared code looks like — the hard boundary is
still never *write* to that repo, but *reading* it to port a specific fix
is fine and explicitly endorsed. Caution: `openclaude`'s versions of
these files have diverged substantially (its `providerConfig.ts` is
~3.5x the size of `openclaude-main`'s) — port the specific fix logic,
never wholesale-replace a file, or session 2's local-AI-specific changes
(`isLocalProviderUrl`-gated `reasoning_effort`, etc.) get silently
destroyed.

## 9. Risk register

| Risk | Mitigation |
|---|---|
| transformers v5 API breakage (hit twice already) | Concrete model classes, pinned versions, smoke test per model at bridge startup |
| Venv corruption (happened once) | New dedicated venv; `--no-deps` + exact pins for any addition |
| Router degrades with tool count | **Materialized, not just a risk anymore** (~65 tools, confirmed hallucinated tool call). MCP-scoping first (free), then tool-name validation, gateways, pre-filter, 4b upgrade — all eval-measured against the new routing eval, §6/§8 |
| OOM with multiple loaded models | Model manager budget + LRU + heavy-exclusivity before any heavy model is wired |
| Bun 300s fetch timeout | Always `createCombinedAbortSignal` (never bare `AbortSignal.timeout`) |
| Stale `dist/` build | `bun run build` after any `src/` change — no exceptions |
| Qwen3-TTS / VideoMAE unknowns | Time-boxed research spikes before committing; park on failure |
| 4 GB VRAM ceiling | fp16 + attention slicing; CPU fallback per model; never co-resident heavies |

## 10. Anti-goals (explicit, to keep the project honest)

- **Not** trying to out-reason frontier models generally — the router stays
  a dispatcher, and hard general reasoning remains out of scope.
- **Not** fine-tuning anything — zero-shot composition only; the
  "self-improvement" loop is routing/eval iteration, not training.
- **Not** wiring models because they're downloaded — the parked list stays
  parked without a use case *and* an eval win.
- **Not** touching `openclaude` (no "-main") — ever, for any of this.
