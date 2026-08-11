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

Lazy-load pattern otherwise matches document_qa.py / Debate's
local_models/claimbuster.py.
"""
import asyncio
import logging
import os

logger = logging.getLogger(__name__)

_MODEL_PATH = os.environ.get(
    "IMAGE_CAPTION_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\blip-image-captioning-large",
)

_model = None
_processor = None


def _load():
    global _model, _processor
    if _model is not None:
        return _model, _processor

    from transformers import BlipForConditionalGeneration, BlipProcessor

    logger.info("Loading image-caption model from %s", _MODEL_PATH)
    _processor = BlipProcessor.from_pretrained(_MODEL_PATH)
    _model = BlipForConditionalGeneration.from_pretrained(_MODEL_PATH)
    _model.eval()
    logger.info("image-caption model ready")
    return _model, _processor


def caption(image_path: str) -> str:
    import torch
    from PIL import Image

    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"No such file: {image_path}")

    model, processor = _load()
    image = Image.open(image_path).convert("RGB")
    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        output_ids = model.generate(**inputs, max_new_tokens=50)
    return processor.decode(output_ids[0], skip_special_tokens=True).strip()


async def caption_async(image_path: str) -> str:
    return await asyncio.to_thread(caption, image_path)


def warmup() -> None:
    _load()
    logger.info("image-caption model warmed up")
