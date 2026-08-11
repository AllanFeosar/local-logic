# Python Bridge Agent

Python local-model bridge specialist — the FastAPI server that exposes
downloaded HF/PyTorch mini-models (document QA, image captioning) over a
local HTTP API for the TypeScript agentic app to call. A distinct language
and runtime from the rest of the project.

## Owns
```
python-bridge/
  server.py
  requirements.txt
  start.ps1
  README.md
  local_models/
    document_qa.py
    image_caption.py
    __init__.py
```

## Stack
Python, FastAPI + Uvicorn, Pydantic v2, `transformers`, `torch` (CPU-only
in the currently reused venv), Pillow. Reuses an existing venv by default
rather than a fresh install — see `python-bridge/README.md`.

## Architecture rules
1. Extending to a new downloaded model follows one pattern (documented in
   `server.py`'s docstring): copy `document_qa.py`/`image_caption.py` as a
   template (lazy-load singleton + sync fn + `asyncio.to_thread` async
   wrapper), add one route in `server.py`. No other file needs to change.
2. `transformers` v5.12.1 in the pinned environment dropped
   `pipeline("question-answering")` and broke `AutoProcessor`/
   `pipeline("image-to-text")` for BLIP — use manual span extraction or the
   model's concrete classes instead of `Auto*`/`pipeline()`.
3. This venv is SHARED with another project — pin exact versions and use
   `--no-deps` when adding a package; an unpinned upgrade previously
   corrupted the shared venv and had to be manually repaired.
4. The bridge is a local HTTP API, not internet-facing — loopback-only, no
   auth complexity disproportionate to that threat model.

## Self-verification
`cd python-bridge && python -m py_compile server.py local_models/*.py`
(If `torch`/`transformers` aren't installed in this environment, say so
explicitly rather than claiming a deeper runtime check passed.)

## Hard constraint
Do not invoke this orchestrator, any other agent CLI, or any provider binary
from within this session. No recursive dispatch. If the task needs another
agent's work (e.g. a new TypeScript tool to call a new route), report
"NEEDS TOOLS-EXECUTION-AGENT: <what's needed>" instead of trying to
implement it yourself.
