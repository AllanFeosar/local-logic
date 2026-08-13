"""Image feature embeddings via the locally-downloaded dinov2-small
checkpoint (facebook/dinov2-small architecture, `Dinov2Model`/
`Dinov2Config`, confirmed via its own config.json's `architectures` field
before writing any code).

Auto-class resolution check (2026-08-13): `AutoImageProcessor`/`AutoModel`
both resolved cleanly against this checkpoint, live-tested (to
`BitImageProcessor`/`Dinov2Model` — this checkpoint's own
preprocessor_config.json genuinely declares `image_processor_type:
"BitImageProcessor"`, not a resolution bug or a DINOv2-specific class this
project failed to find). This module still loads the concrete
`BitImageProcessor`/`Dinov2Model` classes directly anyway, for consistency
with the rest of this package.

**Real API detail confirmed by reading source, not assumed (2026-08-13)**:
`Dinov2Model.forward()`'s own implementation
(`modeling_dinov2.py`) shows `pooler_output` is the **LayerNormed [CLS]
token** (`sequence_output = self.layernorm(last_hidden_state); pooled_output
= sequence_output[:, 0, :]`) — i.e. exactly the standard DINOv2 global image
descriptor, not a learned linear+tanh pooler the way BERT-family models use
the term. Using `pooler_output` directly as the embedding below is
therefore correct, not a guess from the field's name alone.

`embed()` returns this vector L2-normalized (cosine similarity between two
calls' outputs reduces to a plain dot product), matching `clip.py`'s own
embedding normalization choice for the same reason — **DINOv2 embeddings
and CLIP embeddings are NOT comparable to each other**, being different
models/spaces; each is only meaningful compared against another embedding
from the *same* model. See `clip.py`'s docstring for the "CLIP image
memory" scoping note — a persistent store/retrieval layer for either
embedding is a separate, unbuilt design decision, not this module's concern.

Loading/eviction delegated to `local_models.manager`, same pattern as every
other module here.

Device placement (2026-08-13, live-benchmarked): CPU 55ms vs GPU fp16 16ms.
Kept on `device="cpu"` — the same "GPU would add complexity for no
measurable benefit" case `local_models/vad.py` already established for a
small model; 55ms is trivially fast for a single interactive embedding
call, and this machine's tight GPU VRAM stays reserved for `clip.py`'s/
`owlv2.py`'s genuinely latency-motivated placements instead — see
`clip.py`'s own docstring for every model's benchmark numbers side by side.
"""
import asyncio
import logging
import os

from local_models.image_utils import load_image
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "dinov2"
_MODEL_PATH = os.environ.get(
    "DINOV2_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\dinov2-small",
)

# Checkpoint is ~88 MB on disk; ~150 MB budgets margin for runtime/
# activation overhead (CPU device — see module docstring for why GPU wasn't
# chosen despite a real, if small, measured speedup).
_ESTIMATED_MB = 150.0


def _do_load(device: str):
    from transformers import BitImageProcessor, Dinov2Model

    logger.info("Loading dinov2 model from %s (device=%s)", _MODEL_PATH, device)
    processor = BitImageProcessor.from_pretrained(_MODEL_PATH)
    model = Dinov2Model.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
    logger.info("dinov2 model ready")
    return model, processor, device


manager.register(
    ModelSpec(
        name=_MODEL_NAME,
        loader=_do_load,
        estimated_mb=_ESTIMATED_MB,
        heavy=False,
        device="cpu",
        fp16=False,
    )
)


def embed(image_path: str) -> dict:
    import torch

    image = load_image(image_path)

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(images=image, return_tensors="pt")
        inputs = inputs.to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        # .pooler_output — see module docstring: confirmed by reading
        # Dinov2Model.forward() to be the LayerNormed [CLS] token, the
        # standard DINOv2 global image descriptor.
        pooled = outputs.pooler_output
        pooled = pooled / pooled.norm(p=2, dim=-1, keepdim=True)
        embedding = pooled[0].float().cpu().tolist()

    return {"embedding": embedding}


async def embed_async(image_path: str) -> dict:
    return await asyncio.to_thread(embed, image_path)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("dinov2 model warmed up")
