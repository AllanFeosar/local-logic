# Local model bridge

Serves the downloaded Hugging Face / PyTorch mini models over a small local
HTTP API for `openclaude-main`'s tools to call — the same role Ollama plays
for the math model, but for models that aren't GGUF/Ollama-servable.

## Why this exists

Most of the ~24 small task-specific models downloaded for this project
(TAPAS, DistilBERT-QA, BLIP, CLIP, Whisper, etc.) are raw HF/PyTorch
checkpoints, not GGUF files, so Ollama can't serve them. `openclaude-main`
is Bun/TypeScript and can't run PyTorch inference natively either. This
bridge is the missing piece: a small Python process the TS tools talk to
over HTTP, exactly like they already talk to Ollama.

## Running it

```
.\start.ps1
```

By default this reuses the **Debate project's venv**
(`Debate Project/Debate/backend/venv`), which already has
`torch`/`transformers`/`fastapi`/`uvicorn` installed — nothing to
pip-install to get started. Point it at a different interpreter with
`$env:MODEL_BRIDGE_PYTHON` if you'd rather use a dedicated venv (see
`requirements.txt` for what it needs).

Listens on `http://127.0.0.1:8756` by default (override with
`$env:MODEL_BRIDGE_PORT`).

**Known limitation:** the reused venv's torch build is CPU-only
(`torch.cuda.is_available() == False`) — inference runs on CPU, not GPU.
Fine for the small models wired up so far; worth revisiting (a CUDA-enabled
torch install) if larger/slower models get added here later.

## Current endpoints

- `POST /document-qa` — `{question, context}` → `{answer, score}`
  (distilbert-base-cased-distilled-squad, extractive QA over a text passage)
- `POST /image-caption` — `{image_path}` → `{caption}`
  (blip-image-captioning-large, captions a local image file)
- `GET /status` — what's currently loaded (name, estimated MB, heavy/
  device/fp16 flags, in-use count, how long it's been resident), the
  committed-MB estimate against the configured budget, and a real current
  process RSS reading. For debugging and for the eval harness.
- `GET /health` — liveness check

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
- a **device placement config stub** (`device`/`fp16` on `ModelSpec`) —
  informational only today; this venv's torch is CPU-only, so it's logged
  and surfaced in `/status` but not acted on. Wiring real CUDA placement is
  a separate, explicit decision (a dedicated CUDA venv — see
  `LOCAL_AI_MASTER_PLAN.md` §5), not attempted here.

`/status`'s process RSS reading is stdlib-only (`ctypes` + the Windows API
on this platform) — deliberately **not** `psutil`, to avoid adding any new
dependency to the shared/reused venv (see "Why this exists" above re: the
`torchvision` incident).

## Adding another model

1. Copy `local_models/document_qa.py` or `local_models/image_caption.py` as
   a template:
   - a `_do_load()` that imports concrete model classes (not `Auto*`/
     `pipeline()` — see the transformers-v5 breakage notes in those files)
     and returns a handle,
   - a `manager.register(ModelSpec(name=..., loader=_do_load,
     estimated_mb=..., heavy=..., device=..., fp16=...))` call at import
     time,
   - a sync inference function that does `with manager.use(name) as
     handle: ...` instead of a private `_model` global,
   - the same `asyncio.to_thread`-wrapped async version so CPU-bound
     inference doesn't block the event loop.
   Don't reintroduce a bespoke per-module lazy-singleton — it'll drift out
   of sync with the shared budget/LRU/heavy-exclusivity bookkeeping.
2. Add one route in `server.py` that calls the async version.
3. Add a matching Tool in `openclaude-main/src/tools/` that fetches this
   endpoint — see `src/tools/DocumentQATool/` for the reference shape
   (mirrors `src/tools/AskMathModelTool/`, which talks to Ollama instead of
   this bridge).

That's the whole extension surface — no other file needs to change.

## Models downloaded but not yet wired up

`tapas-mini-finetuned-wtq` (table QA), `whisper-large-v3-turbo`
(speech-to-text), `clip-vit-large-patch14` / `clipseg-rd64-refined`
(image-text matching / segmentation), `TabPFN-v2-clf` / `TabPFN-v2-reg`
(tabular prediction), and others in
`C:\Users\allge\AI Models\huggingface\` are downloaded but have no
`local_models/*.py` module or route yet. Follow the same pattern above to
add them as needed — they weren't all wired up mechanically since each has
a different input shape (audio file, table + question, image pair, etc.)
worth designing deliberately rather than rubber-stamping.
