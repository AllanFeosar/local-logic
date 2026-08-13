# Local model bridge

Serves the downloaded Hugging Face / PyTorch mini models over a small local
HTTP API for `openclaude-main`'s tools to call — the same role Ollama plays
for the math model, but for models that aren't GGUF/Ollama-servable.

## Why this exists

Most of the ~24 small task-specific models downloaded for this project
(TAPAS, DistilBERT-QA, BLIP, CLIP, Whisper, TabPFN, Chronos, etc.) are raw
HF/PyTorch checkpoints, not GGUF files, so Ollama can't serve them.
`openclaude-main` is Bun/TypeScript and can't run PyTorch inference
natively either. This bridge is the missing piece: a small Python process
the TS tools talk to over HTTP, exactly like they already talk to Ollama.

## Running it

```
.\start.ps1
```

By default this uses the **dedicated CUDA venv** at `python-bridge\venv`
(built 2026-08-12 — see "The venv" below for exactly what's in it and how
it was built/verified). Point it at a different interpreter with
`$env:MODEL_BRIDGE_PYTHON` — e.g. to fall back to a CPU-only venv, or the
old borrowed Debate venv (`E:\Allan Project\Debate Project\Debate\backend\venv`,
kept working but no longer the default; **never `pip install` into it** —
see the "Bug #5" history note below).

Listens on `http://127.0.0.1:8756` by default (override with
`$env:MODEL_BRIDGE_PORT`).

## The venv

`python-bridge\venv` is a **dedicated** venv (Python 3.11, via `py -3.11 -m
venv venv`) — not shared with any other project, unlike the old Debate-venv
arrangement. It has a CUDA-enabled torch build and is the default
`start.ps1` target as of 2026-08-12.

**GPU**: NVIDIA RTX 3050 Laptop (4 GB VRAM), driver 610.88, which reports
CUDA UMD version 13.3 — comfortably covers the `cu130` PyTorch wheel index
(`torch==2.12.1+cu130`, `torchvision==0.27.1+cu130`, matching the exact
`2.12.1`/`0.27.1` version pair the old CPU-only Debate venv used, just the
CUDA build instead of `+cpu`). `torch.cuda.is_available()` is `True` in
this venv; `torch.version.cuda` reports `13.0`.

**Rebuilding from scratch** (only needed if `venv/` is deleted/corrupted —
this venv is dedicated to the bridge, so there's no "don't touch it, it's
shared" risk the way there was with the Debate venv, but the same
`--no-deps` + exact-pin discipline is still used, both out of habit and
because it makes `requirements.txt` a reliable "this exact set of versions
is known to work together" record rather than whatever pip's resolver
picks on a given day):
```powershell
py -3.11 -m venv venv
venv\Scripts\python.exe -m pip install --no-deps --index-url https://download.pytorch.org/whl/cu130 torch==2.12.1+cu130 torchvision==0.27.1+cu130
venv\Scripts\python.exe -m pip install --no-deps -r requirements.txt
```
See `requirements.txt` for the full pinned list (resolved once with normal
pip dependency resolution in a throwaway venv, verified working live
against every model below, then transcribed and reinstalled with
`--no-deps` into the real venv).

**TabPFN telemetry note** (read before touching `tabular_predict.py`):
the `tabpfn` PyPI package's `TabPFNClassifier`/`TabPFNRegressor`
constructors ping an external usage-tracking endpoint via
`tabpfn_common_utils` unless disabled — confirmed by reading that
package's source, not just assumed. `local_models/tabular_predict.py` sets
`TABPFN_DISABLE_TELEMETRY=1` (the package's own documented kill switch)
before the first `import tabpfn`, which its telemetry service checks
*before* attempting any network call. Verified live: constructing
`TabPFNClassifier` with this set takes ~0.03s with no network activity.
Don't remove that env-var line without re-verifying telemetry stays off.

**Known, deliberate dependency-pin deviation**: `tabpfn-common-utils`
(a `tabpfn` dependency) declares `huggingface-hub<1`, but `transformers`
5.12.1 needs `huggingface-hub>=1.5`. `requirements.txt` pins
`huggingface_hub==1.27.0` (the version `transformers` needs) rather than
downgrading — verified by reading `tabpfn`'s source that its own runtime
usage of `huggingface_hub` (`tabpfn/model_loading.py`'s
`_try_huggingface_downloads()`) is confined to the "model file doesn't
exist locally, download it" branch, which this bridge never exercises
(`tabular_predict.py` always points `model_path` at an already-downloaded
local `.ckpt` file). `pip check` reports this as a conflict — that's
expected, not a bug; see `requirements.txt`'s comment on it.

**fp16 verification**: before committing `document_qa.py`/
`image_caption.py` to `device="cuda", fp16=True`, both were live-tested
GPU+fp16 vs. the previous CPU+fp32 baseline for output-quality regression
(not just speed) — DistilBERT-QA's extracted answer/confidence and BLIP's
generated captions were compared side by side. No regression was found in
either, which is why fp16 was kept as the default rather than
`fp16=False, device="cuda"` (fp32-on-GPU).

## Current endpoints

- `POST /document-qa` — `{question, context}` → `{answer, score}`
  (distilbert-base-cased-distilled-squad, extractive QA over a text
  passage; GPU+fp16 by default, see "The venv" above)
- `POST /image-caption` — `{image_path}` → `{caption}`
  (blip-image-captioning-large, captions a local image file; GPU+fp16 by
  default)
- `POST /tabular-predict` — `{operation: "classify"|"regress",
  train_features, train_labels, test_features}` → `{predictions,
  probabilities?}` (TabPFN-v2, zero-shot tabular classification/
  regression from a local `.ckpt`; CPU, see LOCAL_AI_MASTER_PLAN.md §3/§4
  on why this tier doesn't need GPU placement). 400 on malformed input
  (empty/ragged tables, mismatched train_features/train_labels length).
- `POST /table-qa` — `{question, table: {columns, rows}}` → `{answer,
  cells}` (tapas-mini-finetuned-wtq, answers a question grounded in
  specific table cells; CPU). 400 on malformed input (empty table, ragged
  rows, table larger than the model's max_num_rows/max_num_columns).
- `POST /forecast` — `{series, horizon}` → `{forecast, low?, high?}`
  (chronos-t5-tiny, zero-shot time-series forecasting; CPU). 400 on
  malformed input (empty/too-short series, non-positive or excessive
  horizon).
- `POST /transcribe` — `{audio_path, language?}` → `{text, language,
  segments: [{text, start, end}]}` (whisper-large-v3-turbo, speech-to-text;
  GPU+fp16 by default). `language` omitted lets Whisper auto-detect the
  spoken language (the detected code is echoed back in the response either
  way); an unrecognized requested value returns 400. Handles long-form audio
  (>30s) correctly via transformers' built-in long-form generation loop,
  not a naive 30s truncation — see `local_models/transcribe.py`'s module
  docstring for the live verification. 404 on a missing/unreadable/
  unsupported-format audio file (same collapsed-existence-oracle reasoning
  as `/image-caption`); 400 on audio that's too short (<0.1s) or over the
  20-minute defensive cap.
- `POST /vad` — `{audio_path, threshold?, min_speech_duration_ms?,
  min_silence_duration_ms?, speech_pad_ms?}` → `{segments: [{start, end}]}`
  (silero-vad ONNX, voice activity detection — speech segment timestamps in
  seconds, not a transcription; CPU, ~250x real-time). Same 404/400
  conventions as `/transcribe`. See `local_models/vad.py`'s module
  docstring for why the ONNX release is used instead of the pre-downloaded
  `Silero-VAD-v5-MLX` checkpoint (confirmed genuinely MLX-specific weight
  layout, not just a naming label).
- `POST /clip-classify` — `{image_path, labels}` → `{predictions:
  [{label, score}]}` (clip-vit-large-patch14, zero-shot image
  classification against caller-supplied text labels, sorted descending by
  score; GPU+fp16 by default — see `local_models/clip.py`'s module
  docstring for the live-benchmarked device-placement reasoning). 400 on
  an empty/all-blank `labels` list.
- `POST /clip-embed` — `{image_path}` → `{embedding}` (same model, the
  L2-normalized 768-dim CLIP image embedding vector — the "CLIP image
  memory" building block; see `local_models/clip.py`'s module docstring for
  why a persistent store/retrieval layer on top of this vector is
  explicitly out of scope for this phase).
- `POST /clipseg-segment` — `{image_path, prompt, threshold?}` → `{found,
  box: {x1,y1,x2,y2} | null, confidence, coverage}` (clipseg-rd64-refined,
  text-prompted segmentation; CPU). Returns a bounding box derived from the
  thresholded mask (upsampled to the original image's pixel coordinates),
  not a raw pixel mask — see `local_models/clipseg.py`'s module docstring
  for why, and for an honestly-reported false-positive caveat at the
  default threshold. 400 on an empty `prompt`.
- `POST /dinov2-embed` — `{image_path}` → `{embedding}` (dinov2-small, the
  L2-normalized 384-dim DINOv2 image embedding — NOT comparable to the CLIP
  embedding above, different model/space; CPU).
- `POST /owlv2-detect` — `{image_path, queries, threshold?}` → `{detections:
  [{label, score, box: {x1,y1,x2,y2}}]}` (owlv2-base-patch16-ensemble,
  open-vocabulary object detection via
  `Owlv2Processor.post_process_grounded_object_detection`; GPU+fp16 by
  default — the largest CPU/GPU gap measured in this phase, ~25x, see
  `local_models/owlv2.py`'s module docstring). 400 on an empty/all-blank
  `queries` list.
- `POST /vitpose-pose` — `{image_path, boxes?}` → `{people: [{box:
  {x1,y1,x2,y2}, keypoints: [{name, x, y, score}]}]}` (vitpose-plus-base,
  top-down human pose estimation, COCO 17-keypoint skeleton; CPU). `boxes`
  (COCO format `[x, y, width, height]` per box) is optional — omitted
  defaults to a single full-image box, since this bridge doesn't compose a
  person-detector stage internally (see `local_models/vitpose.py`'s module
  docstring for why, and for the mixture-of-experts `dataset_index`
  finding). 400 on a malformed box (not exactly 4 numbers).
- `POST /image-generate` — `{prompt, negative_prompt?, steps?, width?,
  height?, guidance_scale?, seed?}` → `{image_base64, width, height}`
  (stable-diffusion-v1-5, text-to-image; GPU+fp16, `heavy=True` exclusivity
  — see `local_models/image_generate.py`'s module docstring for the
  live-benchmarked VRAM cliff above 512x512 that sets this route's
  width/height cap). `steps` defaults to 25 (range 1-75), `width`/`height`
  default to 512 (range 64-512, must be a multiple of 8), `guidance_scale`
  defaults to 7.5 (range >0-30). Returns base64-encoded PNG bytes — the
  first route in this bridge to return generated binary media rather than
  structured facts; see that module's docstring for the output-shape
  decision. 400 on empty `prompt`, out-of-range `steps`/`width`/`height`/
  `guidance_scale`, or a `width`/`height` not a multiple of 8.
- `POST /music-generate` — `{prompt, duration_seconds?, guidance_scale?}` →
  `{audio_base64, sample_rate, duration_seconds}` (musicgen-small,
  text-to-music; GPU+fp16, not `heavy` — see
  `local_models/music_generate.py`'s module docstring for the VRAM
  headroom reasoning). `duration_seconds` defaults to 8.0 (range 1-30,
  matching the model's own shipped `generation_config.json` max_length of
  1500 codec steps at 50 steps/sec), `guidance_scale` defaults to 3.0
  (range >0-15). Returns base64-encoded mono 16-bit PCM WAV bytes (stdlib
  `wave`, no new audio-encoding dependency). 400 on empty `prompt` or
  out-of-range `duration_seconds`/`guidance_scale`.
- `GET /status` — what's currently loaded (name, estimated MB, heavy/
  device/fp16 flags — `device`/`fp16` reflect the *actual resolved*
  placement, not just what a model declared; `declared_device` is what it
  asked for — see `local_models/manager.py`), in-use count, how long it's
  been resident, the committed-MB estimate against the configured budget,
  and a real current process RSS reading. For debugging and for the eval
  harness.
- `GET /health` — liveness check

Request/response shapes for all fifteen `POST` routes are the contract
`tools-execution-agent`'s tools build against — see
`.claude/contracts/tool-contract.md` §3. Any shape change here must be
reflected there in the same change.

## The model manager

`local_models/manager.py` is a shared lazy-load registry every model
module registers into (see its own docstring for the full design). It
gives every model, for free:

- a configurable **RAM budget** (`MODEL_BRIDGE_BUDGET_MB` env var, default
  ~4.5 GB) with **LRU eviction** when loading a new model would exceed it,
- **single-flight loading** (concurrent requests for a not-yet-loaded
  model share one load instead of racing),
- a **heavy-model exclusivity flag** (`ModelSpec(heavy=True)`) that evicts
  everything else and loads alone — no heavy models use this yet, it's the
  mechanism Tier C models (SD, MusicGen, TTS) opt into later,
- **real device placement** (`ModelSpec(device=..., fp16=...)`) — as of
  the dedicated CUDA venv this is no longer a stub: `device="cuda"` is
  resolved against actual `torch.cuda.is_available()` at load time and
  falls back to `"cpu"` automatically (driver issue, no GPU, whatever) 
  rather than crashing the bridge. `fp16` is only honored when the
  resolved device is `"cuda"`. `/status`'s `device`/`fp16` fields report
  what actually happened, not just what a `ModelSpec` declared. Loader
  callables now take the resolved device string as their one argument
  (`_do_load(device: str)`), not zero-arg — see manager.py's docstring for
  the full design and `document_qa.py`/`image_caption.py` for the
  reference GPU+fp16 pattern, or `table_qa.py`/`tabular_predict.py`/
  `forecast.py` for the reference CPU-only pattern (declare
  `device="cpu"`; the loader still takes the `device` argument per the
  shared signature, it just never sees anything but `"cpu"`).

`/status`'s process RSS reading is stdlib-only (`ctypes` + the Windows API
on this platform) — deliberately **not** `psutil` for `process_rss_mb`
(kept for the original reason: avoiding a new dependency in what was then
a shared/reused venv). Note `psutil` *is* now a pinned dependency of this
venv regardless — `accelerate` (a `chronos-forecasting` dependency) needs
it — but `manager.py`'s RSS reader still doesn't use it, on the theory
that the raw `ctypes` reader is already written, tested, and correct, and
introducing a second reading mechanism only one caller needs would be
pure churn.

## Adding another model

1. Copy `local_models/document_qa.py`/`image_caption.py` (GPU-capable
   pattern) or `local_models/table_qa.py`/`tabular_predict.py`/
   `forecast.py` (CPU-only pattern) as a template:
   - a `_do_load(device)` that imports concrete model classes (not
     `Auto*`/`pipeline()` — see the transformers-v5 breakage notes in
     `document_qa.py`/`image_caption.py`) and returns a handle (include
     `device` in the returned handle tuple if the inference function needs
     to move input tensors onto it),
   - a `manager.register(ModelSpec(name=..., loader=_do_load,
     estimated_mb=..., heavy=..., device=..., fp16=...))` call at import
     time,
   - a sync inference function that does `with manager.use(name) as
     handle: ...` instead of a private `_model` global,
   - the same `asyncio.to_thread`-wrapped async version so CPU-bound
     inference doesn't block the event loop,
   - for routes that need input validation beyond what Pydantic's schema
     already catches (ragged rows, empty lists, out-of-range values): raise
     a module-local `ValueError` subclass (see `InvalidTabularInput`/
     `InvalidTableInput`/`InvalidForecastInput`) and catch it in the
     `server.py` route to return a 400, never a raw 500 — see those three
     modules for the pattern.
   Don't reintroduce a bespoke per-module lazy-singleton — it'll drift out
   of sync with the shared budget/LRU/heavy-exclusivity/device-resolution
   bookkeeping.
2. Add one route in `server.py` that calls the async version.
3. If a new external PyPI package is needed: pin its exact version (and
   every new transitive dependency it needs — see `requirements.txt`'s
   comment on how the current list was resolved) and add it to
   `requirements.txt` with a note on why. This venv is dedicated (not
   shared), so an unpinned install won't corrupt another project the way
   the old Debate-venv incident did — but pin it anyway; it's what makes
   this file a reliable rebuild record.
4. If the route will be called from TypeScript: add the shape to
   `.claude/contracts/tool-contract.md` §3 *before* or *alongside* building
   it, and add a matching Tool in `openclaude-main/src/tools/` — see
   `src/tools/DocumentQATool/` for the reference shape (mirrors
   `src/tools/AskMathModelTool/`, which talks to Ollama instead of this
   bridge).

That's the whole extension surface — no other file needs to change.

## Models downloaded but not yet wired up

`whisper-large-v3-turbo` (Phase 4, 2026-08-13) is wired up — see
`/transcribe` above and `local_models/transcribe.py`. The `TranscribeAndSummarize`/
`AudioAnalyze` TypeScript-side tools that call `/transcribe` and `/vad` were
built in a separate, later dispatch (`tools-execution-agent`, same day).

`clip-vit-large-patch14` / `clipseg-rd64-refined` / `dinov2-small` /
`owlv2-base-patch16-ensemble` / `vitpose-plus-base` (Phase 5, 2026-08-13,
"the vision suite") are now wired up — see `/clip-classify`, `/clip-embed`,
`/clipseg-segment`, `/dinov2-embed`, `/owlv2-detect`, `/vitpose-pose` above
and `local_models/clip.py`/`clipseg.py`/`dinov2.py`/`owlv2.py`/`vitpose.py`.
A `VisionAnalyze` TypeScript-side gateway tool that composes these routes is
planned but not yet built — a separate, later dispatch, per
`LOCAL_AI_MASTER_PLAN.md`'s own phasing (this session's task explicitly
scoped it out: bridge side only).

`stable-diffusion-v1-5` and `musicgen-small` (Phase 6, 2026-08-13, "voice out
& generation") are now wired up — see `/image-generate`/`/music-generate`
above and `local_models/image_generate.py`/`music_generate.py`.
`Qwen3-TTS-12Hz-1.7B-CustomVoice` (+ its `Qwen3-TTS-Tokenizer-12Hz` sibling,
confirmed identical to the CustomVoice checkpoint's own embedded
`speech_tokenizer/` subfolder — byte-for-byte same `model.safetensors` size,
so the separate download is redundant, not a second thing that needs
loading) was investigated and **deliberately parked** — see
`LOCAL_AI_STATUS.md`'s Phase 6 session entry for the full, evidence-based
reasoning (short version: its official inference package hard-pins
`transformers==4.57.3`, directly conflicting with this venv's load-bearing
`transformers==5.12.1`, and its module graph additionally requires
`torchaudio`, for which no PyPI wheel exists matching this venv's pinned
`torch==2.12.1+cu130`). Image-generate/music-generate TypeScript-side tools
are a separate, later dispatch, per this session's own scope (bridge side
only).

`videomae-base` and the rest of the remaining unwired models in
`C:\Users\allge\AI Models\huggingface\` still have no `local_models/*.py`
module or route. Follow the same pattern above to add them as needed — see
`LOCAL_AI_MASTER_PLAN.md`'s phased plan for what's next.

## History (bugs found and fixed, don't reintroduce)

- **Bug #5 (pre-2026-08-12, in the old borrowed-venv arrangement):**
  installing `torchvision` without pinning into the shared Debate venv
  pulled a `torch` upgrade and corrupted it. Root cause of the
  `--no-deps` + exact-pin discipline used throughout this project since.
  The dedicated venv built 2026-08-12 removes the *sharing* risk entirely
  (nothing else uses `python-bridge\venv`), but the pinning discipline is
  kept anyway — see "Rebuilding from scratch" above for why.
- **transformers v5.12.1 dropped `pipeline("question-answering")`** and
  broke `AutoProcessor`/`pipeline("image-to-text")` for BLIP — both fixed
  by using concrete model classes instead (`AutoModelForQuestionAnswering`/
  `AutoTokenizer` for DistilBERT, `BlipProcessor`/
  `BlipForConditionalGeneration` for BLIP). Still relevant in the new venv
  (same transformers version); TAPAS/TabPFN/Chronos added 2026-08-12 follow
  the same concrete-classes rule.
- **Not every transformers-v5 Auto* path is actually broken — verify per
  model, don't assume the pattern generalizes (2026-08-13).** Whisper was
  explicitly checked before committing to concrete classes:
  `AutoProcessor`/`AutoModelForSpeechSeq2Seq` both resolved cleanly against
  `whisper-large-v3-turbo` on this exact transformers version (unlike
  BLIP/DistilBERT). `local_models/transcribe.py` still uses the concrete
  `Whisper*` classes anyway, for consistency with the rest of this package
  — but the decision was based on a live check, not a copy-pasted
  assumption from the BLIP/DistilBERT breakage. See that module's own
  docstring for the full verification note.
- **A pre-downloaded checkpoint's repo name/tag can be a real, verifiable
  signal, not just cosmetic (2026-08-13).** `Silero-VAD-v5-MLX`'s "MLX" in
  the name turned out to describe a genuine weight-layout difference
  (transposed Conv1d weights, summed LSTM biases) confirmed by reading its
  `model.safetensors` tensor keys directly against its own README's
  documented conversion mapping — not loadable as a standard PyTorch state
  dict without reimplementing that conversion. Used the project's own
  documented fallback instead (re-download the standard silero-vad ONNX
  release) rather than attempting an unverified reverse-engineering fix.
  See `local_models/vad.py`'s module docstring for the full investigation.
- **`AutoModelForImageSegmentation` does not support CLIPSeg (2026-08-13).**
  Live-confirmed: raises `ValueError: Unrecognized configuration class ...
  Model type should be one of DetrConfig` — that Auto* class is scoped to
  DETR-family segmentation models only. `local_models/clipseg.py` uses the
  concrete `CLIPSegProcessor`/`CLIPSegForImageSegmentation` classes; CLIP/
  DINOv2 in the same phase, by contrast, both resolved cleanly through
  `Auto*` when checked (don't assume either way for a new model — verify).
- **`CLIPModel.get_image_features()` does not return a plain tensor on this
  transformers version (2026-08-13)**, despite its own docstring example
  implying `image_features = model.get_image_features(**inputs)` is usable
  directly. It returns a `BaseModelOutputWithPooling` whose `.pooler_output`
  holds the actual embedding (confirmed by reading `modeling_clip.py`'s
  source: it re-assigns `vision_outputs.pooler_output =
  self.visual_projection(pooled_output)` and returns the whole wrapped
  object). `local_models/clip.py`'s `embed()` unwraps `.pooler_output`
  explicitly. Live-confirmed by the naive pattern raising `AttributeError:
  'BaseModelOutputWithPooling' object has no attribute 'norm'`.
- **`vitpose-plus-base` is a mixture-of-experts checkpoint that requires an
  explicit `dataset_index`, not just a bounding box (2026-08-13).**
  Confirmed live: calling the model without one raises `ValueError:
  dataset_index must be provided when using multiple experts
  (num_experts=6)`. `local_models/vitpose.py` always passes
  `dataset_index=0` (the COCO-pretrained expert, per
  `modeling_vitpose_backbone.py`'s own forward() docstring and this
  checkpoint's model-card example) — this bridge has no use case yet for
  the other 5 experts. Separately confirmed this checkpoint is genuinely
  top-down (requires `boxes` at the processor level; there is no unboxed
  code path) — `/vitpose-pose` defaults to a full-image box when the caller
  doesn't supply one, since no person-detector stage is composed at the
  bridge layer (see `local_models/vitpose.py`'s module docstring).
- **GPU device placement in Phase 5 was decided per-model from live
  benchmarks, not defaulted (2026-08-13)** — `clip.py`/`owlv2.py` measured
  large enough CPU/GPU gaps (10x and ~25x respectively) to justify
  `device="cuda"`; `clipseg.py`/`dinov2.py`/`vitpose.py` measured CPU
  latency already comfortable for a single interactive call (55-296ms) and
  were kept on `device="cpu"` to preserve this machine's tight GPU VRAM
  headroom instead. See `clip.py`'s module docstring for every model's
  exact benchmark numbers side by side, and `LOCAL_AI_STATUS.md`'s Phase 5
  session entry for live co-residency measurements.
- **A single-combined-checkpoint directory can look like the standard
  diffusers multi-component layout without actually being loadable as one
  (2026-08-13).** `stable-diffusion-v1-5`'s directory has every subfolder
  `model_index.json` expects (`unet`/`vae`/`text_encoder`/etc.), but each
  subfolder only contains a `config.json` — no weight file. The one
  `v1-5-pruned-emaonly.safetensors` at the directory root carries every
  component's actual weights (the classic "original Stable Diffusion"
  single-file format). `StableDiffusionPipeline.from_pretrained(dir)` does
  NOT work against this layout; `StableDiffusionPipeline.from_single_file
  (checkpoint_path, config=dir, local_files_only=True)` does — confirmed by
  directly listing the directory tree before writing any loading code, not
  assumed from the presence of the subfolders. See
  `local_models/image_generate.py`'s module docstring.
- **A resolution increase that "just" completes slower can actually be a
  VRAM-pressure cliff, not real compute scaling (2026-08-13).** Doubling
  Stable Diffusion's output resolution from 512x512 to 768x768 (2.25x the
  pixels, 1.33x the steps in the test) took **11x longer** (23s → 268s) and
  pushed reserved VRAM to ~4.16 GB — essentially the entire physical 4 GB
  card. The image still came out correctly (visually confirmed, not an
  OOM crash), but the wildly disproportionate slowdown is the signature of
  Windows' driver-level "shared GPU memory" fallback silently kicking in
  under VRAM pressure rather than a clean error. `/image-generate` caps
  width/height at 512 as a direct consequence of this measurement, not a
  guessed-conservative number.
- **Qwen3-TTS's official `qwen-tts` inference package is NOT modularly
  separable by tokenizer variant, discovered by live import tracing, not
  assumed from reading its file list (2026-08-13).** The package ships its
  own concrete model classes (no `trust_remote_code`/`AutoModel` support in
  this venv's `transformers==5.12.1` — confirmed, `Qwen3TTSForConditional
  Generation` doesn't exist in it). This checkpoint (`...-CustomVoice`) only
  needs the 12Hz tokenizer path, but `qwen_tts/core/__init__.py`
  unconditionally imports the legacy 25Hz tokenizer path too, and that path
  hard-imports `sox` (needs the system SoX CLI binary) and `torchaudio` —
  for which no PyPI wheel exists matching this venv's pinned
  `torch==2.12.1+cu130` (verified live against the official cu130 wheel
  index: latest available is `torchaudio==2.11.0+cu130`). Combined with the
  package's own hard pin on `transformers==4.57.3` (vs. this venv's
  load-bearing `5.12.1`), this was parked rather than worked around by
  patching the vendored source — see `LOCAL_AI_STATUS.md`'s Phase 6 session
  entry for the full investigation and reasoning.
