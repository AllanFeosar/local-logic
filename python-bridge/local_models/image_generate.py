"""Text-to-image generation via the locally-downloaded stable-diffusion-v1-5
checkpoint, using the `diffusers` PyPI package's `StableDiffusionPipeline`
(new dependency this phase — see requirements.txt/README.md for the exact
pin and why `--no-deps` was safe here).

**Investigated before writing any code (2026-08-13, per this project's
standing "investigate the real API" discipline):**

- This checkpoint's on-disk layout is the standard diffusers multi-component
  directory (`model_index.json` naming `StableDiffusionPipeline` + `unet`/
  `vae`/`text_encoder`/`tokenizer`/`scheduler`/`safety_checker`/
  `feature_extractor` subfolders), but — confirmed by listing every file in
  the directory tree — **the subfolders only contain `config.json`, not
  weight files**. The only weights on disk are the single combined
  `v1-5-pruned-emaonly.safetensors` at the directory root (the classic
  "original Stable Diffusion" checkpoint format). This means the ordinary
  `StableDiffusionPipeline.from_pretrained(dir)` loader (which expects each
  subfolder to carry its own weight file) does NOT work against this
  directory as-is — confirmed by inspection, not assumed.
- The correct loader for this layout is `StableDiffusionPipeline.
  from_single_file(checkpoint_path, config=component_config_dir,
  local_files_only=True)` — diffusers' single-file loader, which parses the
  combined checkpoint's tensor keys and reconstructs the multi-component
  pipeline in memory, using the local `config.json` files already present in
  each subfolder (so no Hugging Face Hub network call happens, keeping this
  fully offline like every other route in this bridge). Live-verified
  end-to-end (see below) — this is not a guess.
- `diffusers==0.39.0` was verified compatible with this venv's existing pins
  before installing: its own PyPI metadata declares `torch>=2.6` (have
  2.12.1) and `transformers>=4.41.2` (have 5.12.1) as *optional extras* (not
  hard dependencies of the base package), and its actual core dependency set
  (`huggingface-hub<2.0,>=0.34.0`, `safetensors>=0.8.0`, `Pillow`, `numpy`,
  `regex`, `requests`, `filelock`, `httpx<1.0.0`) was already satisfied by
  this venv's existing pins. A plain `pip install diffusers` (no `[torch]`/
  `[test]` extras) pulled exactly two new lightweight packages
  (`importlib_metadata`, `zipp`) and touched neither `torch` nor
  `torchvision` — confirmed live before pinning, so this did not risk the
  kind of torch-upgrade venv corruption `README.md`'s "Bug #5" history note
  warns about.

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here.

**Heavy-model exclusivity (2026-08-13) — the first model in this bridge to
actually use it.** `ModelSpec(heavy=True)`: the manager evicts every other
loaded model before loading this one, and this one loads alone. This isn't
speculative — live-measured peak VRAM for a single 512x512 generation was
~2.9 GB reserved on this machine's 4 GB card (see below), which leaves no
real headroom for co-residency with anything else GPU-resident.

**Device placement + resolution cap, live-benchmarked, not defaulted
(2026-08-13):**
- 512x512, 15 steps, GPU fp16 + attention slicing: ~23s wall time,
  ~2.06 GB VRAM allocated / ~2.94 GB reserved. Registered
  `device="cuda", fp16=True`.
- **768x768, 20 steps, same GPU/settings: ~268s wall time (11x longer for
  only 2.25x the pixels and 1.33x the steps) and ~4.16 GB VRAM reserved —
  essentially the entire physical 4 GB card.** The output image was still
  valid (visually confirmed), but the wildly disproportionate slowdown is
  the signature of VRAM-pressure thrashing (Windows' driver-level "shared
  GPU memory" fallback silently kicking in rather than a clean CUDA OOM),
  not real compute scaling. **Consequence: `/image-generate` caps
  width/height at 512 each** — not a made-up conservative number, the
  actual empirically-observed cliff on this card.
- Safety checker deliberately disabled (`safety_checker=None,
  requires_safety_checker=False`) — a deliberate call, not an oversight:
  this bridge is loopback-only with no auth (see `server.py`'s Host-header
  note), served to a single local operator, so the content-moderation layer
  a public-facing service would need adds real VRAM/latency cost here for a
  threat model that doesn't apply — consistent with this project's general
  "don't add complexity disproportionate to the threat model" stance
  (see `python-bridge-agent`'s own architecture rules).

**Output shape (2026-08-13) — genuinely new for this bridge.** Every prior
route here takes a path in and returns structured JSON facts out; this is
the first route that returns generated binary media. Decision: base64-
encoded PNG bytes inside the JSON response body (`image_base64`), not a
written-to-disk path — this bridge has no established "output directory"
convention, and returning bytes directly keeps the route stateless and
avoids inventing a new file-lifecycle/cleanup concern for a first use case
that doesn't need one. See `server.py`'s `/image-generate` route and
`.claude/contracts/tool-contract.md` §3 for the exact contract.
"""
import asyncio
import base64
import io
import logging
import os

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "image-generate"
_MODEL_DIR = os.environ.get(
    "IMAGE_GENERATE_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\stable-diffusion-v1-5",
)
_CHECKPOINT_PATH = os.path.join(_MODEL_DIR, "v1-5-pruned-emaonly.safetensors")

# Combined checkpoint is ~4.07 GB on disk (fp32 weights; UNet + VAE + CLIP
# text encoder). fp16-on-GPU roughly halves the real resident footprint (see
# the live VRAM numbers in the module docstring), but this estimate is left
# at the fp32/on-disk figure per this package's established "err toward the
# larger number" convention for eviction bookkeeping (see manager.py's
# ModelSpec docstring and image_caption.py's/clip.py's own comments on the
# same reasoning) — also the right number for a CPU-fallback load.
_ESTIMATED_MB = 4200.0

# Empirically-observed VRAM cliff (see module docstring) — not a guess.
_MAX_DIMENSION = 512
_MIN_DIMENSION = 64
_MAX_STEPS = 75
_MIN_STEPS = 1
_MAX_GUIDANCE_SCALE = 30.0


def _do_load(device: str):
    import torch
    from diffusers import StableDiffusionPipeline

    logger.info("Loading image-generate model from %s (device=%s)", _CHECKPOINT_PATH, device)
    dtype = torch.float16 if device == "cuda" else torch.float32
    pipe = StableDiffusionPipeline.from_single_file(
        _CHECKPOINT_PATH,
        config=_MODEL_DIR,
        local_files_only=True,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipe.set_progress_bar_config(disable=True)
    pipe = pipe.to(device)
    # Reduces peak attention-layer activation memory at a small speed cost —
    # live-verified worth keeping even on the 512x512 default given how
    # close to the VRAM ceiling this model already runs (see module
    # docstring's benchmark numbers).
    pipe.enable_attention_slicing()
    logger.info("image-generate model ready")
    return pipe, device


manager.register(
    ModelSpec(
        name=_MODEL_NAME,
        loader=_do_load,
        estimated_mb=_ESTIMATED_MB,
        heavy=True,
        device="cuda",
        fp16=True,
    )
)


class InvalidImageGenerateInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as every other Invalid*Input in this
    package.
    """


def _validate(prompt: str, steps: int, width: int, height: int, guidance_scale: float) -> None:
    if not prompt or not prompt.strip():
        raise InvalidImageGenerateInput("prompt must not be empty")
    if not (_MIN_STEPS <= steps <= _MAX_STEPS):
        raise InvalidImageGenerateInput(f"steps must be between {_MIN_STEPS} and {_MAX_STEPS}")
    for dim_name, dim in (("width", width), ("height", height)):
        if not (_MIN_DIMENSION <= dim <= _MAX_DIMENSION):
            raise InvalidImageGenerateInput(
                f"{dim_name} must be between {_MIN_DIMENSION} and {_MAX_DIMENSION} "
                f"(this card's live-benchmarked VRAM ceiling — see image_generate.py's module docstring)"
            )
        if dim % 8 != 0:
            raise InvalidImageGenerateInput(f"{dim_name} must be a multiple of 8")
    if not (0 < guidance_scale <= _MAX_GUIDANCE_SCALE):
        raise InvalidImageGenerateInput(f"guidance_scale must be between 0 (exclusive) and {_MAX_GUIDANCE_SCALE}")


def generate(
    prompt: str,
    negative_prompt: "str | None" = None,
    steps: int = 25,
    width: int = 512,
    height: int = 512,
    guidance_scale: float = 7.5,
    seed: "int | None" = None,
) -> dict:
    import torch

    _validate(prompt, steps, width, height, guidance_scale)

    with manager.use(_MODEL_NAME) as (pipe, device):
        generator = None
        if seed is not None:
            generator = torch.Generator(device=device).manual_seed(seed)
        with torch.no_grad():
            result = pipe(
                prompt,
                negative_prompt=negative_prompt or None,
                num_inference_steps=steps,
                width=width,
                height=height,
                guidance_scale=guidance_scale,
                generator=generator,
            )
        image = result.images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return {"image_base64": encoded, "width": image.width, "height": image.height}


async def generate_async(
    prompt: str,
    negative_prompt: "str | None" = None,
    steps: int = 25,
    width: int = 512,
    height: int = 512,
    guidance_scale: float = 7.5,
    seed: "int | None" = None,
) -> dict:
    return await asyncio.to_thread(
        generate, prompt, negative_prompt, steps, width, height, guidance_scale, seed
    )


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("image-generate model warmed up")
