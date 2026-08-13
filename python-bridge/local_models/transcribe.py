"""Speech-to-text via the locally-downloaded whisper-large-v3-turbo
checkpoint (a standard `transformers` Whisper checkpoint — safetensors,
`model_type: whisper`, `torch_dtype: float16` in its own config.json).

Auto-class resolution check (2026-08-13, per this project's standing rule
of verifying rather than assuming after two prior transformers-v5 Auto*/
pipeline() breakages — see document_qa.py/image_caption.py): **both
`AutoProcessor`/`AutoModelForSpeechSeq2Seq` were live-tested against this
exact checkpoint on transformers 5.12.1 and resolved cleanly** (to
`WhisperProcessor`/`WhisperForConditionalGeneration`, no "unrecognized"
errors like BLIP hit). Whisper is NOT in the broken set. This module still
imports the concrete `Whisper*` classes directly rather than `Auto*`
anyway, for the same reason table_qa.py does: consistency with the rest of
this package, and because they're the exact classes the model card itself
names — not because Auto* was observed broken here.

`pipeline("automatic-speech-recognition", ...)` was deliberately NOT tried
or used — this project's established rule is concrete classes over
pipeline() given the prior breakage history, and manual generate() also
gives direct control over `return_timestamps`/`language`/GPU+fp16 tensor
placement that a pipeline call would obscure.

Long-form audio (>30s): live-verified this session that calling the
feature extractor with `truncation=False, padding="longest"` (instead of
its default fixed 30s window) combined with `generate(...,
return_timestamps=True)` correctly engages transformers' built-in
long-form generation loop — a 48-second synthesized test clip was
transcribed in full across three correctly-boundaried segments, not
silently truncated to the first 30s. This is what this module always uses,
not just for audio known in advance to be long.

**Bug found and fixed live this session**: combining that `padding=
"longest"` long-form path with `language=None` (auto-detect) crashes
inside transformers' own `_retrieve_init_tokens` -> `detect_language`,
which hard-requires the *standard* fixed-3000-mel-frame (30s) padding for
its own internal probe forward pass — "Whisper expects the mel input
features to be of length 3000, but found <n>". Fixed by never letting
`language=None` reach the long-form generate() call: `transcribe()` below
always resolves a concrete language first, either the caller-supplied one
or (when omitted) a separate `model.detect_language()` call against a
standard-padded feature array, decoded (`"<|en|>"` -> `"en"`) and fed into
the long-form call explicitly. The resolved language is also returned in
the response (`language` field) since it's now available "for free".

Segment/timestamp extraction: `generate(..., return_timestamps=True)`
followed by `processor.tokenizer.decode(ids, skip_special_tokens=True,
output_offsets=True)` (per-sequence, not `processor.batch_decode` — that
was tried first and silently returned empty offsets; decoding one sequence
at a time through the tokenizer directly is what actually works on this
version) returns `{"text": ..., "offsets": [{"text", "timestamp": (start,
end)}, ...]}` "for free" alongside the generation call already needed for
plain transcription — no extra model pass. This module always returns
segments in the response.

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here.

Device placement (2026-08-13): registered device="cuda", fp16=True.
Live-verified: `torch.cuda.memory_allocated()` after loading was ~1544MB,
`memory_reserved()` ~1674MB (this checkpoint's weights are already stored
as fp16 on disk per its own config.json, so `.half()` here is close to a
no-op on the load, not a further halving) — comfortably inside this
machine's 4096MB VRAM budget alongside the existing BLIP (~900MB estimated
fp16 actual) and DistilBERT (~125MB estimated fp16 actual) GPU models,
though all three were not measured co-resident simultaneously this session
(see LOCAL_AI_STATUS.md for exactly what composition was and wasn't
verified live). Falls back to CPU automatically if CUDA isn't available at
runtime, per manager.py's `_resolve_device()` — no bespoke fallback here.
"""
import asyncio
import logging
import os

from local_models.audio_utils import load_wav_mono_16k
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "transcribe"
_MODEL_PATH = os.environ.get(
    "TRANSCRIBE_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\whisper-large-v3-turbo",
)

# Checkpoint is ~1.6GB on disk (already fp16 dtype); live-verified real CUDA
# fp16 resident footprint was ~1674MB reserved (see module docstring).
# ~2200MB estimated_mb budgets modest extra margin for the encoder/decoder
# activations and generation KV-cache during long-form generate() calls,
# matching this project's "err toward the larger number" convention for
# this bookkeeping figure (see local_models/manager.py's ModelSpec
# docstring for what this number is/isn't used for).
_ESTIMATED_MB = 2200.0

# Defensive cap on a single request's audio length — not part of the fixed
# contract, same spirit as forecast.py's _MAX_HORIZON: long-form generate()
# cost scales with audio length, so this stops one request from tying up
# the model for an unbounded amount of time. Raise if a real use case needs
# longer recordings transcribed in one call.
_MAX_AUDIO_SECONDS = 1200.0  # 20 minutes
_MIN_AUDIO_SECONDS = 0.1


def _do_load(device: str):
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    logger.info("Loading transcribe (Whisper) model from %s (device=%s)", _MODEL_PATH, device)
    processor = WhisperProcessor.from_pretrained(_MODEL_PATH)
    model = WhisperForConditionalGeneration.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
        model = model.half()  # fp16 — see ModelSpec(fp16=True) below
    logger.info("transcribe model ready")
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


class InvalidAudioInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as InvalidTableInput/InvalidForecastInput/
    InvalidTabularInput in the other modules.
    """


def transcribe(audio_path: str, language: "str | None" = None) -> dict:
    import torch

    # FileNotFoundError / UnsupportedAudioError both propagate up to
    # server.py, which collapses both into the same generic 404 — see
    # audio_utils.py's UnsupportedAudioError docstring for why.
    audio = load_wav_mono_16k(audio_path)

    duration_s = len(audio) / 16000.0
    if duration_s < _MIN_AUDIO_SECONDS:
        raise InvalidAudioInput(f"audio is too short to transcribe (< {_MIN_AUDIO_SECONDS}s)")
    if duration_s > _MAX_AUDIO_SECONDS:
        raise InvalidAudioInput(
            f"audio is {duration_s:.0f}s, longer than the {_MAX_AUDIO_SECONDS:.0f}s cap for a single /transcribe request"
        )

    with manager.use(_MODEL_NAME) as (model, processor, device):
        detected_language = language

        # Live bug found and fixed this session: passing `padding="longest"`
        # (needed below for correct long-form generation on audio >30s — see
        # module docstring) together with language=None crashes deep inside
        # transformers' own auto-language-detection path
        # (`_retrieve_init_tokens` -> `detect_language` -> the encoder
        # forward pass) with "Whisper expects the mel input features to be
        # of length 3000, but found <shorter>" — `detect_language()`
        # hard-requires the *standard* fixed-3000-frame (30s) padding it
        # never gets when the outer call already used "longest" padding for
        # a shorter clip. Fixed by doing language ID as its own explicit,
        # separate step against a standard-padded (first ~30s) feature
        # array — exactly how Whisper's own long-form pipeline does
        # detection in practice (assume one detected language for the whole
        # clip) — then feeding that concrete language into the actual
        # long-form generate() call below, never leaving `language=None` to
        # reach the long-form path itself.
        if not detected_language:
            lang_inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
            lang_features = lang_inputs.input_features
            if device == "cuda":
                lang_features = lang_features.to(device=device, dtype=torch.float16)
            with torch.no_grad():
                lang_ids = model.detect_language(input_features=lang_features)
            # e.g. "<|en|>" -> "en"
            detected_language = processor.tokenizer.decode(lang_ids).strip().strip("<|>")

        inputs = processor(
            audio,
            sampling_rate=16000,
            return_tensors="pt",
            truncation=False,
            padding="longest",
            return_attention_mask=True,
        )
        input_features = inputs.input_features
        attention_mask = inputs.attention_mask
        if device == "cuda":
            input_features = input_features.to(device=device, dtype=torch.float16)
            attention_mask = attention_mask.to(device=device)

        try:
            with torch.no_grad():
                predicted_ids = model.generate(
                    input_features,
                    attention_mask=attention_mask,
                    task="transcribe",
                    language=detected_language,
                    return_timestamps=True,
                )
        except ValueError as e:
            # The only ValueError generate() itself raises on otherwise-valid
            # input is an unrecognized `language` string (live-confirmed
            # message: "Unsupported language: ..."). Only reachable when the
            # caller supplied `language` explicitly — the auto-detect path
            # above always produces a value generate() itself already
            # recognizes. Surface as a 400, not a 500.
            if language:
                raise InvalidAudioInput(f"invalid language {language!r}: {e}") from e
            raise

        seq = predicted_ids[0].tolist()
        decoded = processor.tokenizer.decode(seq, skip_special_tokens=True, output_offsets=True)

    segments = []
    for seg in decoded["offsets"]:
        start, end = seg["timestamp"]
        segments.append({
            "text": seg["text"].strip(),
            "start": float(start) if start is not None else 0.0,
            # A final segment can come back with no closing timestamp token
            # if generation was cut off — fall back to the clip's own
            # duration rather than emitting a null end.
            "end": float(end) if end is not None else duration_s,
        })

    return {
        "text": decoded["text"].strip(),
        "language": detected_language,
        "segments": segments,
    }


async def transcribe_async(audio_path: str, language: "str | None" = None) -> dict:
    return await asyncio.to_thread(transcribe, audio_path, language)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("transcribe model warmed up")
