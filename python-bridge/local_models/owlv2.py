"""Open-vocabulary object detection via the locally-downloaded
owlv2-base-patch16-ensemble checkpoint (google/owlv2-base-patch16-ensemble
architecture, `Owlv2ForObjectDetection`/`Owlv2Config`, confirmed via its own
config.json's `architectures` field before writing any code).

Concrete classes (`Owlv2Processor`/`Owlv2ForObjectDetection`) used directly
per this project's established rule. Not separately Auto*-checked this
session — OWLv2's own HF model card/docs consistently use the concrete
classes for this exact reason: `post_process_grounded_object_detection`
(the documented, correct post-processing helper for this model family — box
decoding + label resolution, used below instead of hand-rolled decoding, per
the task's own instruction) is only exposed on the concrete `Owlv2Processor`
class, so there is no Auto*-only code path to fall back to here regardless.

`detect()` passes `text_labels=[queries]` into
`post_process_grounded_object_detection()` — live-confirmed this parameter
round-trips the original query strings back onto each detection directly
(`results[0]['text_labels']`), rather than requiring a manual
label-index -> query-string lookup the way a plain classification index
would.

Loading/eviction delegated to `local_models.manager`, same pattern as every
other module here.

Device placement (2026-08-13, live-benchmarked): CPU 3876ms vs GPU fp16
152ms (~25x) — by far the largest CPU/GPU gap measured across this phase's
five new models (see `clip.py`'s docstring for the other four's numbers side
by side), and the only one where CPU latency (~4 seconds for a single
detection call, at this model's native 960x960 working resolution) is a
genuine interactive-use problem rather than a "nice to have" speedup.
Registered `device="cuda", fp16=True` on that basis. Real fp16 VRAM measured
~323MB.
"""
import asyncio
import logging
import os

import torch

from local_models.image_utils import load_image
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "owlv2"
_MODEL_PATH = os.environ.get(
    "OWLV2_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\owlv2-base-patch16-ensemble",
)

# Checkpoint is ~591 MB on disk (fp32 weights); ~750 MB budgets margin for
# tokenizer + runtime/activation overhead, following this project's "err
# toward the larger fp32/CPU-fallback figure" convention (see manager.py's
# ModelSpec docstring — fp16-on-GPU's smaller real footprint is not what
# this estimate tracks).
_ESTIMATED_MB = 750.0


def _do_load(device: str):
    from transformers import Owlv2ForObjectDetection, Owlv2Processor

    logger.info("Loading owlv2 model from %s (device=%s)", _MODEL_PATH, device)
    processor = Owlv2Processor.from_pretrained(_MODEL_PATH)
    model = Owlv2ForObjectDetection.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
        model = model.half()  # fp16 — see ModelSpec(fp16=True) below
    logger.info("owlv2 model ready")
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


class InvalidOwlv2Input(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as every other Invalid*Input in this
    package.
    """


def detect(image_path: str, queries: "list[str]", threshold: float = 0.1) -> dict:
    queries = [q.strip() for q in queries if q and q.strip()]
    if not queries:
        raise InvalidOwlv2Input("queries must contain at least one non-empty string")

    image = load_image(image_path)
    width, height = image.size

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(text=[queries], images=image, return_tensors="pt")
        if device == "cuda":
            inputs = {
                k: (v.to(device=device, dtype=torch.float16) if v.dtype.is_floating_point else v.to(device))
                for k, v in inputs.items()
            }
        else:
            inputs = inputs.to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        target_sizes = torch.tensor([[height, width]])
        results = processor.post_process_grounded_object_detection(
            outputs=outputs, target_sizes=target_sizes, threshold=threshold, text_labels=[queries]
        )[0]

    detections = [
        {
            "label": label,
            "score": float(score),
            "box": {
                "x1": float(box[0]),
                "y1": float(box[1]),
                "x2": float(box[2]),
                "y2": float(box[3]),
            },
        }
        for label, score, box in zip(results["text_labels"], results["scores"], results["boxes"])
    ]
    detections.sort(key=lambda d: d["score"], reverse=True)
    return {"detections": detections}


async def detect_async(image_path: str, queries: "list[str]", threshold: float = 0.1) -> dict:
    return await asyncio.to_thread(detect, image_path, queries, threshold)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("owlv2 model warmed up")
