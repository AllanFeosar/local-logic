"""Text-prompted image segmentation via the locally-downloaded
clipseg-rd64-refined checkpoint (CIDAS/clipseg-rd64-refined architecture,
`CLIPSegForImageSegmentation`/`CLIPSegConfig`, confirmed via its own
config.json's `architectures` field before writing any code).

Auto-class resolution check (2026-08-13): `AutoModelForImageSegmentation`
does **not** support this checkpoint on this transformers version —
confirmed live: raises `ValueError: Unrecognized configuration class ...
for this kind of AutoModel: AutoModelForImageSegmentation. Model type should
be one of DetrConfig.` (that Auto* class is scoped to DETR-family
segmentation models only; CLIPSeg was never a candidate for it). This
module uses the concrete `CLIPSegProcessor`/`CLIPSegForImageSegmentation`
classes directly, both per this project's established rule and because the
Auto* path is confirmed broken here — unlike CLIP/DINOv2 in this same
phase, which the project verified DO resolve cleanly through Auto* on this
version (see those modules' own docstrings; don't assume either way,
verify per model).

**Return shape — a deliberate design decision** (the task's own
instructions left this open, since a full per-pixel mask is impractical to
return over JSON — 352x352 floats is ~124K numbers per call at this model's
native output resolution): this module returns a **bounding box derived
from the thresholded mask**, in the *original* input image's pixel
coordinate space (the raw 352x352 mask is bilinearly upsampled back to the
input image's real size *before* thresholding, so the box is directly
usable against `image_path` without the caller needing to know the model's
internal working resolution), plus `confidence` (mean sigmoid probability
inside the thresholded region) and `coverage` (fraction of the image's
pixels above threshold — a cheap "how much of the image this covers" signal
independent of the box). A full base64-encoded mask was considered and
rejected: every other route in this bridge returns small, structured JSON
facts, never an embedded image blob, and no currently-planned caller has a
stated need for pixel-level detail — a dedicated route could add that later
if a real use case needs it, without touching this one.

**Live-verified accuracy, and an honestly-reported limitation** (synthetic
shapes test image — a white canvas with a drawn red circle and blue
rectangle at known coordinates; see `LOCAL_AI_STATUS.md`'s Phase 5 session
entry for exact numbers): prompting "a red circle" / "a blue rectangle"
recovered bounding boxes within a few pixels of the true shape extents.
**Also confirmed, worth knowing before trusting the default threshold**:
prompting for an object that ISN'T in the image ("a green triangle",
absent from the test image) did not reliably come back `found: false` — it
produced a mask with confidence just above the default 0.5 threshold,
sitting on top of the unrelated blue rectangle. This is a genuine
model-uncertainty characteristic, not a wiring bug (matches this project's
established pattern of reporting specialist limitations honestly — see
TAPAS's/Chronos's own documented weak spots in `LOCAL_AI_STATUS.md`).
Callers wanting fewer false "found" positives should pass a higher
`threshold`; this module does not attempt to auto-tune it.

Loading/eviction delegated to `local_models.manager`, same pattern as every
other module here.

Device placement (2026-08-13, live-benchmarked): CPU 296ms vs GPU fp16 38ms
(~8x). Kept on `device="cpu"` — 296ms is already comfortable for a single
interactive call, and this machine's GPU VRAM is tight (`LOCAL_AI_STATUS.md`
Sessions 19-20); the ~313MB this would cost on the GPU was judged not worth
it against `clip.py`'s/`owlv2.py`'s genuinely latency-motivated GPU
placements in this same phase — see `clip.py`'s own docstring for every
model's benchmark numbers side by side.
"""
import asyncio
import logging
import os

import torch
import torch.nn.functional as F

from local_models.image_utils import load_image
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "clipseg"
_MODEL_PATH = os.environ.get(
    "CLIPSEG_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\clipseg-rd64-refined",
)

# Checkpoint is ~575 MB on disk; ~700 MB budgets modest margin for the
# tokenizer + runtime/activation overhead (CPU device — see module
# docstring for why GPU wasn't chosen despite a real measured speedup).
_ESTIMATED_MB = 700.0


def _do_load(device: str):
    from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor

    logger.info("Loading clipseg model from %s (device=%s)", _MODEL_PATH, device)
    processor = CLIPSegProcessor.from_pretrained(_MODEL_PATH)
    model = CLIPSegForImageSegmentation.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
    logger.info("clipseg model ready")
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


class InvalidClipsegInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as every other Invalid*Input in this
    package.
    """


def segment(image_path: str, prompt: str, threshold: float = 0.5) -> dict:
    if not prompt or not prompt.strip():
        raise InvalidClipsegInput("prompt must not be empty")

    image = load_image(image_path)
    width, height = image.size

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(text=[prompt], images=[image], return_tensors="pt")
        inputs = inputs.to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        logits = outputs.logits
        if logits.dim() == 2:
            # A single-prompt call squeezes the batch dim away entirely
            # (confirmed live: shape (352, 352) for one prompt vs. (N, 352,
            # 352) for N) — restore it so the interpolate() call below has a
            # consistent (batch, H, W) shape to work with regardless of N.
            logits = logits.unsqueeze(0)
        probs = torch.sigmoid(logits)  # (1, 352, 352) at the model's native working resolution
        # Upsample back to the *original* image's pixel size so the box
        # returned below is directly usable against image_path, not the
        # model's fixed 352x352 internal resolution — see module docstring.
        probs = F.interpolate(
            probs.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False
        )[0, 0].cpu()

    mask = probs >= threshold
    coverage = float(mask.float().mean())
    if not bool(mask.any()):
        return {"found": False, "box": None, "confidence": 0.0, "coverage": coverage}

    ys, xs = torch.where(mask)
    box = {
        "x1": int(xs.min()),
        "y1": int(ys.min()),
        "x2": int(xs.max()),
        "y2": int(ys.max()),
    }
    confidence = float(probs[mask].mean())
    return {"found": True, "box": box, "confidence": confidence, "coverage": coverage}


async def segment_async(image_path: str, prompt: str, threshold: float = 0.5) -> dict:
    return await asyncio.to_thread(segment, image_path, prompt, threshold)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("clipseg model warmed up")
