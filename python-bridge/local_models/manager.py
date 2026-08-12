"""Shared lazy-load model registry/manager for the bridge.

Every model module (`document_qa.py`, `image_caption.py`, and any future
`local_models/*.py`) registers a `ModelSpec` with the module-level `manager`
singleton at import time, then wraps its inference call in
`with manager.use(name) as handle: ...` instead of maintaining its own
`_model`/`_tokenizer` globals + hand-rolled lazy-load-on-first-call. The
manager is the single source of truth for what's currently resident.

What this gives every registered model for free:

- **Budget cap + LRU eviction.** The manager tracks a declared
  `estimated_mb` per model (see each module's registration for how that
  number was derived) and a configurable total budget
  (`MODEL_BRIDGE_BUDGET_MB` env var, default ~4.5 GB — see
  LOCAL_AI_MASTER_PLAN.md §5). Loading a model that would push the
  estimated total over budget evicts least-recently-used *idle* models
  first (never a model mid-inference — see `in_use` below).
- **Single-flight loading.** Each model name has its own `threading.Lock`.
  Concurrent requests for a not-yet-loaded model block on that lock; only
  the first one actually loads it, the rest just get the cached handle.
  This mirrors the pre-manager behavior's race (harmless there because the
  old code only ever *read* an already-set global) but now makes it
  correct on purpose instead of by luck.
- **Heavy-model exclusivity.** `ModelSpec(heavy=True)` means: on load,
  evict every other currently-loaded model first (best-effort — an
  in-use model is never forcibly evicted, a warning is logged instead)
  and load this one alone. No heavy models are registered yet; this is
  the mechanism Tier C models (SD, MusicGen, TTS) will opt into.
- **Device placement config (stub).** `ModelSpec(device=..., fp16=...)` is
  informational only right now — surfaced in `/status`, logged on load —
  and does NOT actually place anything on a GPU. This venv's torch build
  is CPU-only; wiring real CUDA placement is an explicit separate decision
  (LOCAL_AI_MASTER_PLAN.md §5: needs a new dedicated venv). Loaders should
  keep loading onto CPU regardless of what a spec declares for now.
- **`/status` support.** `manager.status()` returns what's loaded, the
  declared/estimated committed MB, and a real current-process RSS reading
  (via `get_process_rss_mb()` below — stdlib-only, no `psutil`; see that
  function's docstring for why).

Known simplification (documented on purpose, not hidden): if every loaded
model happens to be `in_use` (mid-inference) at the moment a new load needs
room, eviction can't free anything without yanking a model out from under
an active request, so the manager logs a warning and loads the new model
anyway, temporarily exceeding budget rather than blocking or corrupting an
in-flight inference. With the two small models wired today this can't
realistically happen; revisit if/when concurrent heavy models make it
plausible.
"""
from __future__ import annotations

import gc
import logging
import os
import platform
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger("model_bridge.manager")

# ~4.5 GB default per LOCAL_AI_MASTER_PLAN.md §5. Override with
# MODEL_BRIDGE_BUDGET_MB (megabytes) if the project owner wants a different
# cap for this machine.
DEFAULT_BUDGET_MB = float(os.environ.get("MODEL_BRIDGE_BUDGET_MB", "4608"))


@dataclass(frozen=True)
class ModelSpec:
    name: str
    loader: Callable[[], object]
    # Declared footprint estimate in MB, used for budget/eviction decisions
    # (see the registering module for how this was derived — typically
    # on-disk weight size plus a runtime-overhead margin). This is a static
    # estimate, not a measurement of this specific model's actual
    # contribution to process RSS — attributing RSS deltas to one model in
    # a shared process reliably is more machinery than this phase needs;
    # `/status`'s `process_rss_mb` is the real number, this is only for
    # eviction bookkeeping.
    estimated_mb: float
    # Optional cleanup hook run with the loader's returned handle right
    # before it's dropped. Default (None): just drop the reference and
    # gc.collect() — sufficient for CPU tensors. A future CUDA-placed model
    # would want this to call torch.cuda.empty_cache() too (TODO once
    # device="cuda" is real, not a stub).
    unloader: Optional[Callable[[object], None]] = None
    # Heavy models evict everything else and load alone. No heavy models
    # are registered yet — this is the flag Tier C models opt into later.
    heavy: bool = False
    # "cpu" | "cuda" — placement stub, see module docstring. Not enforced.
    device: str = "cpu"
    # TODO: honored once device="cuda" is real; no-op on cpu.
    fp16: bool = False


class _Entry:
    __slots__ = ("spec", "handle", "in_use", "loaded_at")

    def __init__(self, spec: ModelSpec, handle: object):
        self.spec = spec
        self.handle = handle
        self.in_use = 0
        self.loaded_at = time.time()


class ModelManager:
    def __init__(self, budget_mb: float = DEFAULT_BUDGET_MB):
        self.budget_mb = budget_mb
        self._specs: "dict[str, ModelSpec]" = {}
        self._locks: "dict[str, threading.Lock]" = {}
        # OrderedDict preserves insertion/move-to-end order = LRU order,
        # oldest (least-recently-used) first.
        self._loaded: "OrderedDict[str, _Entry]" = OrderedDict()
        # Protects _loaded (and is held only for short, non-blocking
        # dict operations — never across a model load, which can take
        # seconds to minutes).
        self._state_lock = threading.Lock()

    def register(self, spec: ModelSpec) -> None:
        if spec.name in self._specs:
            raise ValueError(f"model {spec.name!r} already registered")
        self._specs[spec.name] = spec
        self._locks[spec.name] = threading.Lock()
        logger.info(
            "registered model %r (estimated_mb=%.0f heavy=%s device=%s fp16=%s)",
            spec.name, spec.estimated_mb, spec.heavy, spec.device, spec.fp16,
        )

    @contextmanager
    def use(self, name: str):
        """Get the loaded handle for `name`, loading it if needed
        (single-flight per name; budget/LRU or heavy eviction happens
        before the load). Marks the entry in-use for the `with` block's
        duration so it can't be evicted mid-inference.
        """
        spec = self._specs.get(name)
        if spec is None:
            raise KeyError(f"no model registered as {name!r}")

        lock = self._locks[name]
        with lock:  # single-flight: only one thread loads `name` at a time
            with self._state_lock:
                entry = self._loaded.get(name)
                if entry is not None:
                    self._loaded.move_to_end(name)  # touch = most recently used
                    entry.in_use += 1

            if entry is None:
                self._make_room_for(spec)
                if spec.device != "cpu":
                    logger.warning(
                        "model %r declares device=%r but device placement is a "
                        "no-op stub in this venv (CPU-only torch) — loading on "
                        "CPU regardless. See LOCAL_AI_MASTER_PLAN.md §5.",
                        name, spec.device,
                    )
                logger.info("loading model %r (~%.0f MB estimated)", name, spec.estimated_mb)
                handle = spec.loader()
                entry = _Entry(spec, handle)
                with self._state_lock:
                    self._loaded[name] = entry
                    self._loaded.move_to_end(name)
                    entry.in_use += 1
                logger.info("model %r ready", name)

        try:
            yield entry.handle
        finally:
            with self._state_lock:
                entry.in_use -= 1

    def _make_room_for(self, spec: ModelSpec) -> None:
        """Caller already holds spec's per-model lock, so `spec` itself
        can't be concurrently loaded/evicted while this runs.
        """
        if spec.heavy:
            for victim_name in list(self._loaded.keys()):
                self._evict(victim_name)
            return

        while True:
            with self._state_lock:
                committed = sum(e.spec.estimated_mb for e in self._loaded.values())
                if committed + spec.estimated_mb <= self.budget_mb or not self._loaded:
                    return
                victim_name = next(
                    (n for n, e in self._loaded.items() if e.in_use == 0), None
                )
            if victim_name is None:
                logger.warning(
                    "budget exceeded (committed=%.0f MB + incoming=%.0f MB > "
                    "budget=%.0f MB) but every loaded model is in-use — "
                    "loading %r anyway rather than evicting an active model",
                    committed, spec.estimated_mb, self.budget_mb, spec.name,
                )
                return
            self._evict(victim_name)

    def _evict(self, name: str) -> None:
        with self._state_lock:
            entry = self._loaded.pop(name, None)
        if entry is None:
            return
        logger.info("evicting model %r (LRU/heavy-exclusivity, was resident %.0fs)",
                    name, time.time() - entry.loaded_at)
        if entry.spec.unloader is not None:
            try:
                entry.spec.unloader(entry.handle)
            except Exception:
                logger.exception("unloader for %r raised", name)
        del entry
        gc.collect()

    def status(self) -> dict:
        with self._state_lock:
            loaded = [
                {
                    "name": n,
                    "estimated_mb": e.spec.estimated_mb,
                    "heavy": e.spec.heavy,
                    "device": e.spec.device,
                    "fp16": e.spec.fp16,
                    "in_use": e.in_use,
                    "loaded_at": e.loaded_at,
                    "resident_seconds": round(time.time() - e.loaded_at, 1),
                }
                for n, e in self._loaded.items()
            ]
            committed_mb = sum(e.spec.estimated_mb for e in self._loaded.values())
        rss_mb, rss_source = get_process_rss_mb()
        return {
            "budget_mb": self.budget_mb,
            "committed_mb_estimated": committed_mb,
            "process_rss_mb": rss_mb,
            "rss_source": rss_source,
            "loaded": loaded,
            "registered": sorted(self._specs.keys()),
        }


def get_process_rss_mb() -> "tuple[Optional[float], str]":
    """Best-effort current-process resident memory in MB, stdlib only.

    Deliberately does NOT use `psutil` — this bridge reuses a shared venv
    (borrowed from the Debate project) that was corrupted once already by
    an unpinned dependency install, and a Windows-API `ctypes` call covers
    the one thing `/status` actually needs (current working-set size)
    without adding any new dependency to that venv at all.

    Returns (value_or_None, source_tag) so callers/`/status` can tell a
    real reading from "not available on this platform" rather than
    silently reporting 0.
    """
    system = platform.system()
    try:
        if system == "Windows":
            import ctypes
            import ctypes.wintypes as wintypes

            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            # NB: argtypes/restype must be declared explicitly here. Without
            # them, ctypes' default marshaling treats the return value as a
            # plain c_int, which silently mishandles the pointer-sized
            # HANDLE on 64-bit Windows (GetCurrentProcess's -1 pseudo-handle
            # gets mangled) — the call then just returns FALSE with no
            # Python exception raised, so this is easy to get wrong quietly.
            # Confirmed by direct repro during this feature's own
            # verification: identical code with vs. without these two lines
            # is the difference between a working /status RSS reading and a
            # silently-null one.
            kernel32 = ctypes.windll.kernel32
            psapi = ctypes.windll.psapi
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.GetCurrentProcess.argtypes = []
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            psapi.GetProcessMemoryInfo.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
                wintypes.DWORD,
            ]

            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            handle = kernel32.GetCurrentProcess()
            ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            if not ok:
                return None, "unavailable"
            return counters.WorkingSetSize / (1024 * 1024), "windows_working_set"

        # POSIX fallback (not the deployment target today, but keeps this
        # honest if the bridge is ever run on Linux/macOS dev machines).
        import resource

        usage_kb_or_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if system == "Darwin":
            return usage_kb_or_bytes / (1024 * 1024), "posix_rusage"
        return usage_kb_or_bytes / 1024, "posix_rusage"
    except Exception:
        logger.exception("failed to read process RSS")
        return None, "unavailable"


manager = ModelManager()
