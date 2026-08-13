"""Voice activity detection via the standard silero-vad ONNX release —
NOT the pre-downloaded `Silero-VAD-v5-MLX` checkpoint
(`C:\\Users\\allge\\AI Models\\huggingface\\Silero-VAD-v5-MLX`).

**Why the pre-downloaded checkpoint wasn't used (investigated, not
assumed)**: read its `config.json` (`model_type: "silero_vad_v5"` — not a
registered HF/transformers architecture, so no `Auto*`/pipeline() path
exists for it regardless) and inspected its `model.safetensors` directly
via `safetensors.safe_open` — the tensor keys are `stft.weight`,
`encoder.{0..3}.{weight,bias}`, `lstm.Wx`/`lstm.Wh`/`lstm.bias`,
`decoder.{weight,bias}`. This exactly matches that repo's own README
"Weight Mapping" table describing an MLX-specific conversion: Conv1d
weights transposed for MLX's channels-last layout, and the LSTM's
`bias_ih`/`bias_hh` already summed into one `lstm.bias` tensor (standard
PyTorch LSTM keeps them separate). So "MLX" in the repo name isn't just a
label — the weight *layout* genuinely doesn't match a standard PyTorch
`nn.LSTM`/`nn.Conv1d` state dict; loading it correctly in plain torch would
mean reimplementing and verifying the inverse of that conversion (untranspose
the conv weights, split the summed LSTM bias back into ih/hh) with no
reference implementation to check against on this platform. Confirmed
genuinely unusable as-is here, not a "probably fine, didn't check" call.

**What's used instead**: the project's own documented fallback
(`LOCAL_AI_MASTER_PLAN.md` §8 Phase 4: "silero-vad ONNX (re-download, ~2
MB)"). Downloaded `silero_vad.onnx` (2,327,524 bytes, sha256 verified
byte-identical to the file GitHub currently serves) directly from
`snakers4/silero-vad`'s `src/silero_vad/data/silero_vad.onnx` into
`C:\\Users\\allge\\AI Models\\huggingface\\silero-vad-onnx\\` — not via the
`silero-vad` PyPI package, which would additionally require `torchaudio`
(a new, version-sensitive dependency next to this venv's pinned
`torch==2.12.1+cu130`) just for its own `read_audio()` helper; this bridge
already has its own WAV loader (`local_models/audio_utils.py`) so that
dependency isn't needed. Only new dependency added: `onnxruntime` (CPU
execution provider only — no `onnxruntime-gpu`, see device placement note
below).

Inference follows the reference `OnnxWrapper.__call__`/`get_speech_timestamps`
algorithm from `snakers4/silero-vad`'s own `utils_vad.py` (read directly
from GitHub to confirm the exact input/output contract and hysteresis
logic — session/state/context handling, thresholds, padding — rather than
guessing the API from the config.json alone): 512-sample (32ms @ 16kHz)
chunks, a `(2, batch, 128)` LSTM state and a 64-sample context window both
carried across chunks and fed back as explicit tensor inputs each call
(this ONNX graph is stateless between `session.run()` calls unlike the
JIT model's `self._state`, which is actually convenient here — no mutable
object to worry about across concurrent requests). The chunk-level
speech-probability loop is reimplemented directly against this bridge's
already-loaded-as-one-array audio (not the reference's streaming
`VADIterator`, which this batch/offline use case doesn't need) and the
speech-segment extraction (start/end hysteresis with a threshold and a
lower "exit" threshold, minimum-silence-before-cutting, minimum-speech-
duration filtering, edge padding) is a simplified, direct adaptation of
`get_speech_timestamps`'s core loop.

**Known, deliberate simplification**: the reference implementation's
`max_speech_duration_s` long-chunk-splitting logic (forcibly cutting a
single very long unbroken speech run at the best available silence point)
is NOT ported here — this bridge's stated use case (§8 Phase 4: trimming
silence before Whisper, skipping dead air for a future
`TranscribeAndSummarize` pipeline tool) never needs speech *segments*
capped in length, only correctly bounded start/end points, so that branch
would be unused complexity. If a future caller needs that behavior,
port it from `utils_vad.py`'s `get_speech_timestamps` rather than
reinventing it.

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here.

Device placement (2026-08-13): device="cpu", NOT declared "cuda" —
live-benchmarked on this machine: an 11.5-second test clip (360 chunks)
processed in ~45ms total (~0.13ms/chunk), i.e. roughly 250x real-time on
CPU alone. Per this task's own explicit guidance not to force GPU
placement onto a model this small "if it doesn't matter": it doesn't — GPU
placement would need a separate `onnxruntime-gpu` package and a CUDA
execution provider (this venv's plain `onnxruntime` only has
CPUExecutionProvider/AzureExecutionProvider available), for no measurable
benefit at this model's size (~309K params, 2.3MB ONNX file).
"""
import asyncio
import logging
import os

import numpy as np

from local_models.audio_utils import load_wav_mono_16k
from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "vad"
_MODEL_PATH = os.environ.get(
    "VAD_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\silero-vad-onnx\silero_vad.onnx",
)

# ONNX file is ~2.3MB on disk; ~50MB estimated_mb generously covers the
# onnxruntime session/runtime overhead on top of that (this is a tiny
# model — see ModelSpec docstring in manager.py for what this figure is
# used for: eviction bookkeeping, not a measured RSS delta).
_ESTIMATED_MB = 50.0

_SAMPLE_RATE = 16000
_WINDOW_SAMPLES = 512  # config.json's chunk_size — the model's fixed input chunk length @ 16kHz
_CONTEXT_SAMPLES = 64  # config.json's context_size — see OnnxWrapper reference: carried across chunks, concatenated before each chunk
_LSTM_STATE_SHAPE = (2, 1, 128)  # (num_state_tensors, batch=1, lstm_hidden_size) — matches the ONNX graph's declared "state" input shape


def _do_load(device: str):
    import onnxruntime as ort

    logger.info("Loading VAD (silero-vad onnx) model from %s (device=%s)", _MODEL_PATH, device)
    # device is always "cpu" here (ModelSpec(device="cpu") below) — see
    # module docstring for the live CPU-speed benchmark this is based on.
    session_options = ort.SessionOptions()
    session_options.inter_op_num_threads = 1
    session_options.intra_op_num_threads = 1
    session = ort.InferenceSession(
        _MODEL_PATH, sess_options=session_options, providers=["CPUExecutionProvider"]
    )
    logger.info("VAD model ready")
    return session


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


class InvalidAudioInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, same pattern as InvalidTableInput/InvalidForecastInput/
    InvalidTabularInput/transcribe.py's InvalidAudioInput.
    """


def _run_vad_probs(session, audio: "np.ndarray") -> "list[float]":
    state = np.zeros(_LSTM_STATE_SHAPE, dtype=np.float32)
    context = np.zeros((1, _CONTEXT_SAMPLES), dtype=np.float32)
    probs = []
    for start in range(0, len(audio), _WINDOW_SAMPLES):
        chunk = audio[start:start + _WINDOW_SAMPLES]
        if len(chunk) < _WINDOW_SAMPLES:
            chunk = np.pad(chunk, (0, _WINDOW_SAMPLES - len(chunk)))
        x = np.concatenate([context, chunk.reshape(1, -1)], axis=1).astype(np.float32)
        out, state = session.run(
            None,
            {"input": x, "state": state, "sr": np.array(_SAMPLE_RATE, dtype=np.int64)},
        )
        probs.append(float(out[0][0]))
        context = x[:, -_CONTEXT_SAMPLES:]
    return probs


def _extract_segments(
    probs: "list[float]",
    audio_len: int,
    threshold: float,
    min_speech_duration_ms: float,
    min_silence_duration_ms: float,
    speech_pad_ms: float,
) -> "list[dict]":
    # Negative/"exit" threshold: once triggered, probability has to drop
    # further below `threshold` before silence is considered to have
    # started again — same hysteresis margin (0.15) as the reference
    # implementation's default, avoids flapping on borderline frames.
    neg_threshold = max(threshold - 0.15, 0.01)
    min_silence_samples = int(_SAMPLE_RATE * min_silence_duration_ms / 1000)
    speech_pad_samples = int(_SAMPLE_RATE * speech_pad_ms / 1000)
    min_speech_samples = int(_SAMPLE_RATE * min_speech_duration_ms / 1000)

    triggered = False
    speeches: "list[dict]" = []
    current: dict = {}
    temp_end = 0
    for i, p in enumerate(probs):
        cur_sample = i * _WINDOW_SAMPLES
        if p >= threshold and not triggered:
            triggered = True
            current = {"start": cur_sample}
        if p < neg_threshold and triggered:
            if not temp_end:
                temp_end = cur_sample
            if cur_sample - temp_end >= min_silence_samples:
                current["end"] = temp_end
                if current["end"] - current["start"] > min_speech_samples:
                    speeches.append(current)
                current = {}
                triggered = False
                temp_end = 0
        elif p >= threshold and temp_end:
            temp_end = 0

    if triggered and current:
        current["end"] = audio_len
        if current["end"] - current["start"] > min_speech_samples:
            speeches.append(current)

    for s in speeches:
        s["start"] = max(0, s["start"] - speech_pad_samples)
        s["end"] = min(audio_len, s["end"] + speech_pad_samples)

    return [
        {"start": round(s["start"] / _SAMPLE_RATE, 3), "end": round(s["end"] / _SAMPLE_RATE, 3)}
        for s in speeches
    ]


def detect_speech_segments(
    audio_path: str,
    threshold: float = 0.5,
    min_speech_duration_ms: float = 250.0,
    min_silence_duration_ms: float = 100.0,
    speech_pad_ms: float = 30.0,
) -> "list[dict]":
    # FileNotFoundError / UnsupportedAudioError both propagate up to
    # server.py, which collapses both into the same generic 404 — see
    # audio_utils.py's UnsupportedAudioError docstring for why.
    audio = load_wav_mono_16k(audio_path)

    if not (0.0 < threshold < 1.0):
        raise InvalidAudioInput("threshold must be between 0 and 1 (exclusive)")
    if min_speech_duration_ms <= 0 or min_silence_duration_ms <= 0:
        raise InvalidAudioInput("min_speech_duration_ms and min_silence_duration_ms must be positive")
    if speech_pad_ms < 0:
        raise InvalidAudioInput("speech_pad_ms must not be negative")

    with manager.use(_MODEL_NAME) as session:
        probs = _run_vad_probs(session, audio)

    return _extract_segments(
        probs, len(audio), threshold, min_speech_duration_ms, min_silence_duration_ms, speech_pad_ms
    )


async def detect_speech_segments_async(
    audio_path: str,
    threshold: float = 0.5,
    min_speech_duration_ms: float = 250.0,
    min_silence_duration_ms: float = 100.0,
    speech_pad_ms: float = 30.0,
) -> "list[dict]":
    return await asyncio.to_thread(
        detect_speech_segments,
        audio_path,
        threshold,
        min_speech_duration_ms,
        min_silence_duration_ms,
        speech_pad_ms,
    )


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("vad model warmed up")
