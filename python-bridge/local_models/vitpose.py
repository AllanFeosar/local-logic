"""Human pose estimation (keypoints) via the locally-downloaded
vitpose-plus-base checkpoint (usyd-community/vitpose-plus-base architecture,
`VitPoseForPoseEstimation`/`VitPoseConfig`, confirmed via its own
config.json's `architectures` field before writing any code).

Investigated up front, per the task's own instruction, whether this
checkpoint needs a person-detection stage first or can run on a full image
directly — **confirmed it needs both a bounding box AND a dataset index**:

1. **Top-down, box-required.** `VitPoseImageProcessor.preprocess()`'s own
   signature *requires* a `boxes` argument (COCO format: top_left_x,
   top_left_y, width, height per box) and internally crops/affine-warps the
   input to a fixed 256x192 patch per box before the model ever sees it
   (read `image_processing_vitpose.py`'s own `_preprocess()`/
   `box_to_center_and_scale()` source directly, not assumed from the model
   card alone). This is a genuine top-down architecture, not "runs on a
   full image and happens to work better with a box" — there is no
   unboxed code path through the standard processor call at all.
2. **This specific checkpoint is the "plus" mixture-of-experts variant.**
   Live-confirmed: calling the model without a `dataset_index` raises
   `ValueError: dataset_index must be provided when using multiple experts
   (num_experts=6)`. Per `modeling_vitpose_backbone.py`'s own forward()
   docstring ("This corresponds to the dataset index used during training,
   e.g. index 0 refers to COCO") and the model card's own worked example,
   `dataset_index=0` selects the COCO-pretrained expert — this module
   always uses `dataset_index=0` (COCO's standard 17-keypoint skeleton,
   matching this checkpoint's own `config.id2label`), since this bridge has
   no use case yet for the other 5 experts (AI Challenger, MPII, AP-10K,
   APT-36K, etc.).

**Real bug found in the library's own post-processing helper, worked
around (2026-08-13)**: `VitPoseImageProcessor.post_process_pose_estimation()`'s
returned `person["bbox"]` field is NOT a usable image-pixel-space box on
this transformers version — reading its source shows it's built from
`[center_x, center_y, *normalized* scale]` (scale divided by
`normalize_factor=200`, never multiplied back) run through
`coco_to_pascal_voc()` as if it were `[x, y, w, h]`, producing a box only
~1-3 pixels wide/tall regardless of the real input box size (directly
computed and confirmed: an input box of `[90, 30, 220, 480]` — ~220x480
pixels — comes back as `bbox=[200, 270, 201.25, 272]`, a ~1x2 pixel box).
`pose()` below does not use this field; it returns the caller's own
supplied box (or the full-image default) directly instead, which is
correct and meaningful.

The model card's own worked example composes this with a separate person
detector (RTDetr) as a first stage — that model isn't downloaded for this
project, and per this bridge's established "no multi-model pipelines inside
the bridge itself" precedent (`local_models/vad.py`'s/`transcribe.py`'s own
module docstrings and the `TranscribeAndSummarizeTool` contract note in
`.claude/contracts/tool-contract.md` — pipeline composition happens
tool-side, not bridge-side), `pose()` below accepts an **optional** `boxes`
argument and defaults to a single full-image box (`[0, 0, width, height]`)
when the caller doesn't supply one — a reasonable zero-config default for a
single, roughly-centered subject, with real accuracy trading off against
how loosely the box crops the actual person the wider the image gets. A
future `VisionAnalyze` gateway tool wanting real multi-person accuracy
should compose `owlv2.py`'s "a person" detection first and pass its boxes
here — left as a tool-side concern, not built in this dispatch.

**Live-verified mechanism, not real accuracy — honestly reported**: no real
human photo was available on this machine to test against (see
`LOCAL_AI_STATUS.md`'s Phase 5 session entry for what was searched — this
project's usual Windows-wallpaper test images are all abstract/landscape,
no people). A synthetic 400x600 stick-figure test image was used instead: it
produced 17 COCO keypoints with plausible *relative* positions (ankles
below knees below hips, ears above shoulders, etc.) but low per-keypoint
confidence scores (0.04-0.27) — expected and reported honestly, not a bug:
this model was trained on real human photos, and a crude hand-drawn stick
figure is a legitimate but weak input for it. This confirms the
box-crop -> MoE forward pass -> heatmap decode mechanism is wired
correctly; it does not demonstrate real-world pose accuracy, which would
need an actual human photo to assess.

Loading/eviction delegated to `local_models.manager`, same pattern as every
other module here.

Device placement (2026-08-13, live-benchmarked): CPU 200ms vs GPU fp16 27ms
(~7x). Kept on `device="cpu"` — 200ms is already comfortable for a single
interactive call, and (matching `clipseg.py`'s/`dinov2.py`'s own reasoning
in this same phase) this machine's tight GPU VRAM stays reserved for
`clip.py`'s/`owlv2.py`'s genuinely latency-motivated placements instead;
also typically a second stage behind a detector in real multi-person use,
so expected call frequency is lower than the two GPU-placed models here.
"""
import asyncio
import logging
import os

import torch

from local_models.image_utils import load_image
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "vitpose"
_MODEL_PATH = os.environ.get(
    "VITPOSE_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\vitpose-plus-base",
)

# Checkpoint is ~501 MB on disk; ~600 MB budgets margin for runtime/
# activation overhead (CPU device — see module docstring for why GPU wasn't
# chosen despite a real measured speedup).
_ESTIMATED_MB = 600.0

# This checkpoint's own worked example (and modeling_vitpose_backbone.py's
# own docstring) — dataset_index=0 is the COCO-pretrained expert, matching
# this checkpoint's own 17-keypoint config.id2label. See module docstring.
_DATASET_INDEX_COCO = 0


def _do_load(device: str):
    from transformers import VitPoseForPoseEstimation, VitPoseImageProcessor

    logger.info("Loading vitpose model from %s (device=%s)", _MODEL_PATH, device)
    processor = VitPoseImageProcessor.from_pretrained(_MODEL_PATH)
    model = VitPoseForPoseEstimation.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
    logger.info("vitpose model ready")
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


class InvalidVitposeInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as every other Invalid*Input in this
    package.
    """


def pose(image_path: str, boxes: "list[list[float]] | None" = None) -> dict:
    image = load_image(image_path)
    width, height = image.size

    if boxes is None:
        # No detector composed at this layer — see module docstring. A
        # single full-image box is a reasonable zero-config default for one
        # roughly-centered subject.
        boxes = [[0.0, 0.0, float(width), float(height)]]
    else:
        if not boxes:
            raise InvalidVitposeInput("boxes, if supplied, must not be an empty list")
        for b in boxes:
            if len(b) != 4:
                raise InvalidVitposeInput(
                    "each box must be [x, y, width, height] (COCO format, 4 numbers)"
                )
    boxes_batch = [boxes]  # one image in this call, so one list of boxes

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(images=image, boxes=boxes_batch, return_tensors="pt")
        inputs = inputs.to(device)
        # One dataset_index entry per box — box preprocessing turns each box
        # into its own 256x192 crop in the pixel_values batch dimension, so
        # this tensor must match that count, not the image count. See
        # module docstring point 2.
        dataset_index = torch.tensor([_DATASET_INDEX_COCO] * len(boxes), device=device)
        with torch.no_grad():
            outputs = model(**inputs, dataset_index=dataset_index)
        results = processor.post_process_pose_estimation(outputs, boxes=boxes_batch, threshold=None)[0]
        id2label = model.config.id2label

    # NOT using person["bbox"] from post_process_pose_estimation() here — a
    # real, live-confirmed finding (2026-08-13): on this transformers
    # version that field is NOT a usable image-pixel-space box. Reading
    # image_processing_vitpose.py's own post_process_pose_estimation()
    # source shows it's built from [center_x, center_y, *normalized* scale]
    # (scale divided by normalize_factor=200, never multiplied back), then
    # run through coco_to_pascal_voc() as if it were [x, y, w, h] — the
    # result is a box only ~1-3 pixels wide/tall regardless of the real
    # input box size (confirmed by direct computation:
    # box_to_center_and_scale([90,30,220,480], ...) -> center [200,270],
    # scale [2.25,3.0] -> "bbox" [200,270,201.25,272], not remotely close to
    # the real ~220x480 region). Returning the caller's own supplied box
    # (or the full-image default used) instead is correct, meaningful, and
    # matches what the person was actually cropped from.
    people = []
    for person, box in zip(results, boxes):
        keypoints = [
            {
                "name": id2label[int(label)],
                "x": float(kp[0]),
                "y": float(kp[1]),
                "score": float(score),
            }
            for kp, score, label in zip(person["keypoints"], person["scores"], person["labels"])
        ]
        x, y, w, h = box
        people.append(
            {
                "box": {"x1": float(x), "y1": float(y), "x2": float(x + w), "y2": float(y + h)},
                "keypoints": keypoints,
            }
        )

    return {"people": people}


async def pose_async(image_path: str, boxes: "list[list[float]] | None" = None) -> dict:
    return await asyncio.to_thread(pose, image_path, boxes)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("vitpose model warmed up")
