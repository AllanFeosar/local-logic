"""Text-to-music generation via the locally-downloaded musicgen-small
checkpoint (`facebook/musicgen-small`, `MusicgenForConditionalGeneration`
architecture, confirmed via its own config.json's `architectures` field
before writing any code).

**Investigated before writing any code (2026-08-13):** unlike Qwen3-TTS
(researched the same session — see `LOCAL_AI_STATUS.md`'s Phase 6 session
entry for the full park writeup), MusicGen needed **zero new dependencies**.
`AutoProcessor`/`MusicgenForConditionalGeneration` both resolved cleanly
against this checkpoint on this venv's pinned `transformers==5.12.1` —
live-verified by import before committing to the concrete classes below
(same "verify, don't assume the v5-breakage pattern generalizes" discipline
`clip.py`/`transcribe.py` already documented for their own checkpoints).
This module still uses the concrete classes anyway, for consistency with
the rest of this package, not because `Auto*` was found broken here.

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here.

**Device placement, live-benchmarked, not defaulted (2026-08-13):**
generating ~5s of audio (256 new tokens at the model's own 50 tokens/sec
codec rate — confirmed exactly: 256/50=5.12s, matched the actual returned
audio duration) took **13.0s on GPU fp16** (~1.26 GB VRAM allocated /
~2.43 GB reserved) vs **~12s on CPU fp32 for only 100 new tokens (~2s
audio)** — extrapolating, CPU is roughly 2-3x slower per second of audio
than GPU fp16 here. Smaller gap than CLIP/OWLv2's 10x/25x (Phase 5) or SD's
GPU-vs-CPU-thrashing cliff, but real, reproducible, and the model comfortably
fits this card's VRAM with headroom to spare (unlike `image_generate.py`).
Registered `device="cuda", fp16=True`, and — unlike `image_generate.py` —
**not** flagged `heavy=True`: peak measured VRAM (~2.43 GB reserved) leaves
enough of this card's 4 GB for at least one smaller GPU model to coexist,
so exclusive eviction isn't warranted the way it is for the much tighter
Stable Diffusion case. LRU eviction under real budget pressure still applies
normally.

**A real, documented upstream quirk (2026-08-13, harmless but worth
recording so it isn't mistaken for a bug in this module):** this
checkpoint's own shipped `generation_config.json` declares
`pad_token_id`/`bos_token_id` = 2048, one past the codec vocabulary's valid
range (`[0, 2047]`) — transformers logs a warning
(`"pad_token_id must be None or an integer within the vocabulary..."`) on
every load. Live-verified this does not affect generation quality (the
5s-audio test produced 99.6% non-silent samples with amplitude in a normal
[-1, 1]-ish range, not degenerate/garbled output) — this is the model
card's own shipped config, not something this module's loading code
introduced, and not worth suppressing/patching around.

**Output shape** — same new-for-this-bridge decision as
`image_generate.py`'s PNG case: base64-encoded WAV bytes in the JSON
response (`audio_base64`), not a written-to-disk path. WAV encoding uses the
stdlib `wave` module only (mono, 16-bit PCM) — no new audio-encoding
dependency, consistent with `audio_utils.py`'s own "no ffmpeg/codec
dependency added" precedent for the *input* side of this bridge's audio
handling.
"""
import asyncio
import io
import logging
import os
import wave

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "music-generate"
_MODEL_PATH = os.environ.get(
    "MUSIC_GENERATE_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\musicgen-small",
)

# Checkpoint is ~2.4 GB on disk (fp32 weights: the 300M-param decoder LM plus
# the EnCodec audio tokenizer); ~2600 MB budgets modest margin for the
# runtime/activation overhead of autoregressive generation, following this
# package's "err toward the larger fp32/CPU-fallback figure" convention (see
# manager.py's ModelSpec docstring and image_caption.py's/clip.py's own
# comments on the same reasoning).
_ESTIMATED_MB = 2600.0

# The model's own codec operates at 50 autoregressive steps per second of
# audio (confirmed live: 256 max_new_tokens produced exactly 5.12s of audio
# at the model's 32kHz output sampling rate) and its shipped
# generation_config.json defaults max_length to 1500 (=30s) — used as this
# module's own duration cap rather than inventing an arbitrary number.
_TOKENS_PER_SECOND = 50
_MAX_DURATION_SECONDS = 30.0
_MIN_DURATION_SECONDS = 1.0
_MAX_GUIDANCE_SCALE = 15.0


def _do_load(device: str):
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    logger.info("Loading music-generate model from %s (device=%s)", _MODEL_PATH, device)
    processor = AutoProcessor.from_pretrained(_MODEL_PATH)
    model = MusicgenForConditionalGeneration.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
        model = model.half()  # fp16 — see ModelSpec(fp16=True) below
    logger.info("music-generate model ready")
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


class InvalidMusicGenerateInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as every other Invalid*Input in this
    package.
    """


def _validate(prompt: str, duration_seconds: float, guidance_scale: float) -> None:
    if not prompt or not prompt.strip():
        raise InvalidMusicGenerateInput("prompt must not be empty")
    if not (_MIN_DURATION_SECONDS <= duration_seconds <= _MAX_DURATION_SECONDS):
        raise InvalidMusicGenerateInput(
            f"duration_seconds must be between {_MIN_DURATION_SECONDS} and {_MAX_DURATION_SECONDS}"
        )
    if not (0 < guidance_scale <= _MAX_GUIDANCE_SCALE):
        raise InvalidMusicGenerateInput(f"guidance_scale must be between 0 (exclusive) and {_MAX_GUIDANCE_SCALE}")


def _encode_wav(audio_f32, sample_rate: int) -> bytes:
    """Mono 16-bit PCM WAV, stdlib `wave` only — mirrors audio_utils.py's
    load-side format choice on the write side.
    """
    import numpy as np

    clipped = np.clip(audio_f32, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def generate(prompt: str, duration_seconds: float = 8.0, guidance_scale: float = 3.0) -> dict:
    import base64

    import torch

    _validate(prompt, duration_seconds, guidance_scale)
    max_new_tokens = int(round(duration_seconds * _TOKENS_PER_SECOND))

    with manager.use(_MODEL_NAME) as (model, processor, device):
        inputs = processor(text=[prompt], padding=True, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            audio_values = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=True,
                guidance_scale=guidance_scale,
            )
        sample_rate = model.config.audio_encoder.sampling_rate
        audio = audio_values[0, 0].float().cpu().numpy()

    wav_bytes = _encode_wav(audio, sample_rate)
    encoded = base64.b64encode(wav_bytes).decode("ascii")
    return {
        "audio_base64": encoded,
        "sample_rate": sample_rate,
        "duration_seconds": len(audio) / sample_rate,
    }


async def generate_async(prompt: str, duration_seconds: float = 8.0, guidance_scale: float = 3.0) -> dict:
    return await asyncio.to_thread(generate, prompt, duration_seconds, guidance_scale)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("music-generate model warmed up")
