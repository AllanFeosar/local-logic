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
- `GET /status` — what's currently loaded (name, estimated MB, heavy/
  device/fp16 flags — `device`/`fp16` reflect the *actual resolved*
  placement, not just what a model declared; `declared_device` is what it
  asked for — see `local_models/manager.py`), in-use count, how long it's
  been resident, the committed-MB estimate against the configured budget,
  and a real current process RSS reading. For debugging and for the eval
  harness.
- `GET /health` — liveness check

Request/response shapes for all seven `POST` routes are the contract
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

`clip-vit-large-patch14` / `clipseg-rd64-refined` (image-text matching /
segmentation), and others in `C:\Users\allge\AI Models\huggingface\` are
downloaded but have no `local_models/*.py` module or route yet. Follow the
same pattern above to add them as needed — they weren't all wired up
mechanically since each has a different input shape (image pair, etc.)
worth designing deliberately rather than rubber-stamping. See
`LOCAL_AI_MASTER_PLAN.md`'s phased plan for what's next (Phase 5: the
vision suite).

`whisper-large-v3-turbo` (Phase 4, 2026-08-13) is now wired up — see
`/transcribe` above and `local_models/transcribe.py`. The `TranscribeAndSummarize`/
`AudioAnalyze` TypeScript-side tools that will call `/transcribe` and
`/vad` are a separate, later dispatch (not built in this one — this
session is the bridge side only).

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
