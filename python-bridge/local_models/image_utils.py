"""Shared local image-loading helper for the Phase 5 "vision suite" modules
added in this dispatch (`clip.py`, `clipseg.py`, `dinov2.py`, `owlv2.py`,
`vitpose.py`) — all five need the exact same "open a local image file as
RGB; missing and unreadable both collapse to the same generic condition"
logic. Deliberately not a new per-model abstraction layer (each module still
owns its own loading, inference, and `ModelSpec` registration) — this is
shared plumbing five models in the same dispatch happen to need identically,
the same spirit `local_models/audio_utils.py` was justified on for
`transcribe.py`/`vad.py` in Phase 4.

`image_caption.py` (pre-existing, predates this helper) still inlines the
identical two-line check itself rather than importing this — not refactored
to use this helper as part of this dispatch (out of surgical scope for a
working, already-tested module); the logic here is intentionally kept
byte-for-byte equivalent to `image_caption.py`'s own inline version so
behavior doesn't drift between the two. See `image_caption.py`'s own
`caption()` docstring for the original security reasoning this mirrors.
"""
import os

from PIL import Image


def load_image(image_path: str) -> Image.Image:
    """Open a local image file as RGB.

    Raises `FileNotFoundError` if the path doesn't exist. Lets PIL's
    `OSError` (including `UnidentifiedImageError`, a subclass) propagate for
    a path that exists but isn't a loadable image. Both are deliberately
    collapsed into the same generic 404 by each route in `server.py` that
    calls a function using this helper — an unauthenticated local endpoint
    telling "doesn't exist" apart from "exists but isn't an image" would
    hand a caller a free filesystem existence oracle for arbitrary paths
    readable by this process's user (same reasoning `image_caption.py`'s
    `caption()` documents for the identical collapse there).
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"No such file: {image_path}")
    return Image.open(image_path).convert("RGB")
