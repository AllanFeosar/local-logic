"""Shared local WAV-file loading helper for the two audio bridge modules
added in this dispatch (`transcribe.py`, `vad.py`).

Both Whisper's feature extractor and Silero VAD need the exact same input
shape — a plain float32 numpy array, mono, resampled to 16kHz — so this one
small helper avoids duplicating and independently maintaining that
WAV-parsing/resampling logic in two places. This is deliberately *not* a
new per-model abstraction layer (each module still owns its own loading,
inference, and `ModelSpec` registration per the established pattern) — it's
shared plumbing two models in the same dispatch happen to need identically,
the same spirit as `local_models/manager.py` being shared infrastructure
rather than something each model reimplements.

Format support — what was actually verified live vs. what's merely
implemented by extrapolation (see LOCAL_AI_STATUS.md's Phase 4 session
entry for the live verification this claim is based on):

- **Tested, live**: mono 16-bit PCM WAV (`wave` module's `sampwidth == 2`),
  both at 16kHz-native and at an off-rate (22050Hz, Windows SAPI TTS
  output, resampled by this module) — transcribed correctly through
  Whisper and correctly segmented by Silero VAD.
- **Implemented but not live-tested this session**: 8-bit unsigned PCM WAV
  (`sampwidth == 1`) — same code path, different unpack logic, no real
  8-bit audio file was available to exercise it.
- **Deliberately not supported**: compressed WAV (ADPCM etc. — the stdlib
  `wave` module can't parse these at all, raises `wave.Error`), and any
  non-WAV container (mp3/m4a/ogg/flac/webm). No `ffmpeg`/codec dependency
  was added this session to widen this — that's a real, deliberate
  dependency decision for whoever picks up broader format support next,
  not an oversight. A caller with a non-WAV recording needs to convert to
  WAV first.
"""
import os
import wave

import numpy as np

# What both Whisper's feature extractor and Silero VAD expect their input
# array to already be sampled at.
TARGET_SAMPLE_RATE = 16000


class UnsupportedAudioError(ValueError):
    """A file exists and is readable but isn't a supported audio format
    (not a valid/PCM WAV, corrupted header, unsupported sample width,
    empty). The route in server.py deliberately catches this together with
    FileNotFoundError and returns the same generic 404 for both — same
    collapsed-existence-oracle reasoning as image_caption.py's caption()
    docstring: this bridge has no auth, so distinguishing "doesn't exist"
    from "exists but broken" would hand an unauthenticated local caller a
    free filesystem existence oracle for arbitrary paths.
    """


def load_wav_mono_16k(path: str) -> "np.ndarray":
    """Load a WAV file as mono float32 PCM in [-1, 1], resampled to
    TARGET_SAMPLE_RATE (16kHz).

    Raises FileNotFoundError if the path doesn't exist. Raises
    UnsupportedAudioError for anything that exists but can't be parsed as a
    supported WAV — see module docstring for exactly what's supported.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"No such file: {path}")

    try:
        with wave.open(path, "rb") as w:
            n_channels = w.getnchannels()
            sampwidth = w.getsampwidth()
            framerate = w.getframerate()
            n_frames = w.getnframes()
            raw = w.readframes(n_frames)
    except (wave.Error, EOFError) as e:
        raise UnsupportedAudioError(f"not a readable PCM WAV file: {e}") from e

    if sampwidth == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 1:
        # 8-bit WAV PCM is unsigned with 128 == silence, unlike 16-bit's
        # signed representation — see module docstring: implemented for
        # completeness, not live-tested.
        audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise UnsupportedAudioError(
            f"unsupported WAV sample width ({sampwidth * 8}-bit) — only 8-bit "
            "and 16-bit PCM WAV are supported"
        )

    if n_channels > 1:
        if len(audio) % n_channels != 0:
            raise UnsupportedAudioError("malformed multi-channel WAV data (frame count doesn't divide evenly by channel count)")
        audio = audio.reshape(-1, n_channels).mean(axis=1)

    if len(audio) == 0:
        raise UnsupportedAudioError("WAV file contains no audio frames")

    if framerate != TARGET_SAMPLE_RATE:
        # Simple linear-interpolation resample — not a proper bandlimited
        # resampler (no anti-aliasing filter), but live-verified good
        # enough for speech: a 22050Hz Windows-SAPI-synthesized test file
        # resampled this way transcribed correctly through Whisper with no
        # audible quality-related errors (see LOCAL_AI_STATUS.md). A real
        # resampler (e.g. torchaudio's, which this venv doesn't have) would
        # be a reasonable upgrade if this ever shows up as a real quality
        # problem, not assumed necessary up front.
        duration = len(audio) / framerate
        n_target = max(1, int(round(duration * TARGET_SAMPLE_RATE)))
        x_old = np.linspace(0, duration, num=len(audio), endpoint=False)
        x_new = np.linspace(0, duration, num=n_target, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)

    return audio
