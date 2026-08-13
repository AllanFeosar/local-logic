"""Zero-shot image classification + image embeddings via the locally-
downloaded clip-vit-large-patch14 checkpoint (openai/clip-vit-large-patch14
architecture, `CLIPModel`/`CLIPConfig`, confirmed via its own config.json's
`architectures` field before writing any code).

Auto-class resolution check (2026-08-13, per this project's standing rule of
verifying rather than assuming after prior transformers-v5 `Auto*`/
`pipeline()` breakages — see `document_qa.py`/`image_caption.py`):
`AutoProcessor`/`AutoModel` both resolved cleanly against this checkpoint,
live-tested (to `CLIPProcessor`/`CLIPModel`) — CLIP is NOT in this project's
broken set. This module still loads the concrete `CLIPProcessor`/`CLIPModel`
classes directly anyway, for consistency with the rest of this package (same
reasoning `table_qa.py`/`transcribe.py` already documented for their own
not-actually-broken Auto* checks).

**Real, non-obvious API finding worth documenting (2026-08-13)**:
`CLIPModel.get_image_features()` on this transformers version does NOT
return a plain embedding tensor the way its own docstring example implies
(`image_features = model.get_image_features(**inputs)` used directly) —
reading `modeling_clip.py`'s own source shows it returns a
`BaseModelOutputWithPooling` whose `.pooler_output` holds the actual
post-`visual_projection` embedding (the method re-assigns
`vision_outputs.pooler_output = self.visual_projection(pooled_output)` and
returns the whole wrapped object, not the tensor alone). Confirmed live:
naively treating the return value as a tensor raises `AttributeError:
'BaseModelOutputWithPooling' object has no attribute 'norm'` the moment you
try to L2-normalize it. `embed()` below unwraps `.pooler_output` explicitly.

Two capabilities from the one loaded model (no separate `ModelSpec` needed):
- `classify()`: zero-shot image classification against caller-supplied
  candidate text labels — CLIP's canonical, best-supported `transformers`
  use case. Uses the full forward pass's `logits_per_image`
  (temperature-scaled image-text similarity), softmax-normalized across the
  candidate labels so scores sum to 1 and rank meaningfully against each
  other (not calibrated probabilities against an open/unbounded label set).
- `embed()`: the raw CLIP image embedding vector, L2-normalized (so cosine
  similarity between two calls' outputs reduces to a plain dot product) —
  this is the "CLIP image memory" building block the master plan names
  (`LOCAL_AI_MASTER_PLAN.md` §7). A genuine persistent embedding
  store/retrieval layer on top of this vector is a separate, substantial
  design decision (storage format, indexing, integration with the existing
  memdir/all-minilm text-memory system or a new one) — deliberately NOT
  built in this dispatch; see `LOCAL_AI_STATUS.md`'s Phase 5 session entry
  for the explicit scoping call. This function only exposes the embedding
  primitive itself, which is the part that was asked for.

Loading/eviction delegated to `local_models.manager`, same pattern as every
other module here.

Device placement (2026-08-13, live-benchmarked against this exact
checkpoint on this machine, not defaulted): CPU 579ms vs GPU fp16 57ms per
`classify()` call (~10x). Registered `device="cuda", fp16=True`. Real fp16
VRAM measured ~882MB (`torch.cuda.memory_allocated()` immediately after
load). Chosen over CPU because this is expected to be a frequently-called,
general-purpose capability — both classification and the memory-embedding
path plausibly get called many times in a session (e.g. indexing several
images), so the ~10x per-call saving compounds — unlike `clipseg.py`/
`dinov2.py`/`vitpose.py` in this same phase, which measured CPU latency
already comfortable for a single interactive call and were kept on CPU to
preserve this machine's tight GPU VRAM headroom (`LOCAL_AI_STATUS.md`
Sessions 19-20 measured ~3600-3641MB of this card's 4096MB already in use
with 3 existing GPU models loaded together) — see each of those modules' own
docstrings, and `LOCAL_AI_STATUS.md`'s Phase 5 session entry, for every
model's benchmark numbers side by side and the full reasoning.
"""
import asyncio
import logging
import os

import torch

from local_models.image_utils import load_image
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "clip"
_MODEL_PATH = os.environ.get(
    "CLIP_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\clip-vit-large-patch14",
)

# Checkpoint is ~1.63 GB on disk (fp32 weights); ~1800 MB budgets modest
# margin for the tokenizer + runtime/activation overhead, following this
# project's "err toward the larger fp32/CPU-fallback figure" convention for
# this bookkeeping number (see manager.py's ModelSpec docstring and
# image_caption.py's own comment on the same reasoning — fp16-on-GPU's
# smaller real footprint is not what this estimate tracks).
_ESTIMATED_MB = 1800.0


def _do_load(device: str):
    from transformers import CLIPModel, CLIPProcessor

    logger.info("Loading clip model from %s (device=%s)", _MODEL_PATH, device)
    processor = CLIPProcessor.from_pretrained(_MODEL_PATH)
    model = CLIPModel.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
        model = model.half()  # fp16 — see ModelSpec(fp16=True) below
    logger.info("clip model ready")
    return model, processor, device


manager.register(
    ModelSpec(
        name=_MODEL_NAME,
        loader=_do_load,
        estimated_mb=_ESTIMATED_MB,
        heavy=False,
        device="cuda",
        fp16=True,
    )
)


class InvalidClipInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as every other Invalid*Input in this
    package.
    """


def _move_inputs(inputs, device: str) -> dict:
    """Move a processor's BatchEncoding to `device`, casting only the
    floating-point tensors (pixel_values) to fp16 on cuda — input_ids/
    attention_mask are integer token ids and must stay integer, same
    reasoning document_qa.py's answer() already documents for its own
    tokenizer output.
    """
    moved = {}
    for k, v in inputs.items():
        if device == "cuda" and v.dtype.is_floating_point:
            moved[k] = v.to(device=device, dtype=torch.float16)
        else:
            moved[k] = v.to(device=device)
    return moved


def classify(image_path: str, labels: "list[str]") -> dict:
    labels = [label.strip() for label in labels if label and label.strip()]
    if not labels:
        raise InvalidClipInput("labels must contain at least one non-empty string")

    image = load_image(image_path)

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(text=labels, images=image, return_tensors="pt", padding=True)
        inputs = _move_inputs(inputs, device)
        with torch.no_grad():
            outputs = model(**inputs)
        probs = outputs.logits_per_image.softmax(dim=1)[0].float().cpu().tolist()

    ranked = sorted(zip(labels, probs), key=lambda pair: pair[1], reverse=True)
    return {"predictions": [{"label": label, "score": score} for label, score in ranked]}


def embed(image_path: str) -> dict:
    image = load_image(image_path)

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(images=image, return_tensors="pt")
        inputs = _move_inputs(inputs, device)
        with torch.no_grad():
            # .pooler_output — see module docstring's "Real, non-obvious API
            # finding" note. get_image_features() itself returns a
            # BaseModelOutputWithPooling wrapper on this transformers
            # version, not a plain tensor.
            image_features = model.get_image_features(**inputs).pooler_output
        image_features = image_features / image_features.norm(p=2, dim=-1, keepdim=True)
        embedding = image_features[0].float().cpu().tolist()

    return {"embedding": embedding}


async def classify_async(image_path: str, labels: "list[str]") -> dict:
    return await asyncio.to_thread(classify, image_path, labels)


async def embed_async(image_path: str) -> dict:
    return await asyncio.to_thread(embed, image_path)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("clip model warmed up")
