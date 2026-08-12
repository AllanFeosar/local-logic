"""Image captioning via the locally-downloaded blip-image-captioning-large
checkpoint.

NOTE: pipeline("image-to-text", ...) and even AutoProcessor.from_pretrained
both fail on this transformers version (5.12.1) — image processor
auto-resolution errors with "Unrecognized image processor" even though the
checkpoint's preprocessor_config.json is fine. Root cause (confirmed): the
venv this project reuses (Debate/backend/venv) never had torchvision/pillow
installed (that project is text-only), and transformers silently surfaces
the missing-backend condition as a confusing "unrecognized" error deep in
the Auto* resolution path rather than a clear ImportError, until you try to
touch the class directly. Fixed by (a) installing pillow + a
torch-2.12.1-compatible torchvision into that venv, and (b) loading BLIP's
concrete classes (BlipProcessor / BlipForConditionalGeneration) directly
instead of going through AutoProcessor/pipeline(), which sidesteps the
resolution bug entirely.

Loading/eviction is delegated to the shared `local_models.manager`
singleton (see that module's docstring for the full pattern: budget cap +
LRU eviction, single-flight loading, heavy-model exclusivity, device stub,
/status support) instead of a private module-level `_model`/`_processor`
singleton. This module only owns: where the model lives on disk, how to
load it, and how to run inference on an already-loaded handle.
"""
import asyncio
import logging
import os

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "image-caption"
_MODEL_PATH = os.environ.get(
    "IMAGE_CAPTION_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\blip-image-captioning-large",
)

# Checkpoint is ~1.79 GB on disk (fp32 weights); ~2000 MB budgets in some
# margin for runtime/activation overhead. See local_models/manager.py's
# ModelSpec docstring for what this number is used for (eviction
# bookkeeping) and isn't (a measured RSS delta).
_ESTIMATED_MB = 2000.0


def _do_load():
    from transformers import BlipForConditionalGeneration, BlipProcessor

    logger.info("Loading image-caption model from %s", _MODEL_PATH)
    processor = BlipProcessor.from_pretrained(_MODEL_PATH)
    model = BlipForConditionalGeneration.from_pretrained(_MODEL_PATH)
    model.eval()
    logger.info("image-caption model ready")
    return model, processor


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


def caption(image_path: str) -> str:
    import torch
    from PIL import Image

    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"No such file: {image_path}")

    # Security review note (2026-08-12): a file that exists but isn't a
    # loadable image raises PIL.UnidentifiedImageError (an OSError
    # subclass) here, which the FastAPI route below collapses into the
    # same 404 as a genuinely missing file. Deliberately not distinguished
    # any further up the stack — this endpoint has no auth, and telling
    # "doesn't exist" apart from "exists but isn't an image" would hand an
    # unauthenticated local caller a free filesystem existence oracle for
    # arbitrary paths readable by this process's user.
    image = Image.open(image_path).convert("RGB")
    with manager.use(_MODEL_NAME) as (model, processor):
        inputs = processor(images=image, return_tensors="pt")
        with torch.no_grad():
            output_ids = model.generate(**inputs, max_new_tokens=50)
        return processor.decode(output_ids[0], skip_special_tokens=True).strip()


async def caption_async(image_path: str) -> str:
    return await asyncio.to_thread(caption, image_path)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("image-caption model warmed up")
