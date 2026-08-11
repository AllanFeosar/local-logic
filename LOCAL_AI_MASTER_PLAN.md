# Local AI Master Plan — All-Purpose Agentic AI from Small Local Models

Written 2026-08-11. Companion to [LOCAL_AI_STATUS.md](LOCAL_AI_STATUS.md)
(which tracks what is *actually built and verified*; this document is the
*theoretical roadmap*). If these documents move into an agents folder later,
they move together.

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
BLIP (captioning) · all-minilm (embedding pre-filter).

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
  the borrowed venv.
- **`/status` endpoint**: what's loaded, RAM/VRAM usage — feeds the eval
  harness and debugging.

Ollama-side models (qwen3, VibeThinker, reranker, all-minilm) need none of
this — Ollama already does keep_alive eviction. Tune `keep_alive` so
VibeThinker unloads after ~5 min idle instead of lingering.

## 6. The routing problem at scale (the core theoretical risk)

A 1.7B router choosing among ~10 tools works today. Among 25+ it will
degrade — small-model tool selection falls off with menu size. Mitigations,
in deployment order:

1. **Domain gateway tools** (biggest win, do first). Collapse each domain
   into one tool with an `operation` enum:
   - `VisionAnalyze(image, operation: caption|detect|segment|classify|pose|similarity, query?)`
   - `AudioAnalyze(file, operation: transcribe|classify)`
   - `DataAnalyze(table, operation: question|predict|forecast, query?)`
   The router picks among ~8 tools total; dispatch below the gateway is
   deterministic code, not model choice. A 1.7B model choosing 1-of-8 with
   a hint enum is a far better bet than 1-of-25.
2. **Semantic tool pre-filtering** (reuses existing infra). Embed tool
   descriptions with all-minilm at startup; per user turn, expose core
   tools + top-k semantically relevant ones. This is RAG-over-tools and
   replaces the abandoned `shouldDefer` mechanism with something a small
   router doesn't have to *know* about — the menu is just shorter.
3. **Fixed pipeline tools** for known multi-hop flows, so the router makes
   one call: `TranscribeAndSummarize` (VAD → Whisper → router summarizes),
   `DescribeImageFully` (caption + detect + classify → merged report).
4. **Router upgrade path**: qwen3:4b-instruct Q4 (~2.6 GB) still fits the
   budget and is markedly stronger at tool selection. Decide by eval
   (tool-selection accuracy on a fixed prompt set, 1.7b vs 4b), not vibes.
5. **(Experimental) planner/executor split**: for genuinely multi-step
   requests, one think-enabled qwen3 call drafts a numbered plan; the
   router executes it step by step. Only if gateways + pre-filtering prove
   insufficient — adds latency and failure modes.

## 7. Memory & self-improvement loop

- **Two-stage retrieval everywhere**: all-minilm recall → Qwen3-Reranker
  precision, replacing "embedding-only when >15 files". Later: extend the
  same pattern to codebase search and conversation history.
- **Image memory** (after Tier B): CLIP-embed images the agent has seen;
  "the screenshot with the red error dialog" becomes a retrieval query.
- **Delegation ledger**: log every tool delegation (query → tool chosen →
  outcome → latency). Two uses: (a) regression data for the eval harness,
  (b) evidence for tuning routing descriptions/rules. This is the cheap,
  honest version of "self-improvement" — no fine-tuning fantasy, just
  measured iteration.

## 8. Phases and gates

Each phase has an exit gate; don't start the next phase before the gate
passes. Order optimizes value-per-effort: cheap high-value wins first,
platform work before anything heavy, generative toys last.

- **Phase 0 — Harden what exists** (mostly done, finish it):
  re-run the interactive REPL delegation test post-`/think`-fix; wire
  Qwen3-Reranker into two-stage retrieval; build the eval harness skeleton
  (the already-agreed head-to-head: per-specialist test cases, local vs
  frontier, side by side).
  *Gate: existing 4 specialists pass delegation eval end-to-end in the REPL.*
- **Phase 1 — Platform**: bridge model manager (§5); dedicated CUDA venv;
  migrate BLIP + DistilBERT to it; gateway-tool pattern + semantic tool
  pre-filter infrastructure (§6).
  *Gate: stress test — 6 specialist invocations in sequence, no OOM, no
  regression on the Phase-0 eval.*
- **Phase 2 — Data & tables** (cheapest wins in the library): TabPFN,
  TAPAS, Chronos behind `DataAnalyze`.
  *Gate: TabPFN beats a frontier-model prompt on ≥1 real small-tabular
  benchmark — the flagship "local beats frontier" demo.*
- **Phase 3 — Hearing**: silero-vad ONNX (re-download, ~2 MB), Whisper
  turbo on GPU, `AudioAnalyze` + `TranscribeAndSummarize`.
  *Gate: transcription spot-check vs a cloud STT on 3 real recordings.*
- **Phase 4 — Full vision suite**: CLIP, OWLv2, CLIPSeg, DINOv2, ViTPose
  behind `VisionAnalyze`; fold BLIP in; CLIP image memory.
  *Gate: vision eval set (classification, detection, "find X in image").*
- **Phase 5 — Voice out & generation** (optional): Qwen3-TTS feasibility
  spike → wire if transformers supports it; SD 1.5 on GPU; MusicGen last.
  *Gate: TTS round-trip (type → hear) at acceptable latency, or documented
  park decision.*
- **Phase 6 — Ongoing**: delegation ledger, routing tuned from logs,
  eval suite grows into a regression harness, router 1.7b-vs-4b decision.

## 9. Risk register

| Risk | Mitigation |
|---|---|
| transformers v5 API breakage (hit twice already) | Concrete model classes, pinned versions, smoke test per model at bridge startup |
| Venv corruption (happened once) | New dedicated venv; `--no-deps` + exact pins for any addition |
| Router degrades with tool count | Gateways first, pre-filter second, 4b upgrade path, all eval-measured |
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
