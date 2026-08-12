"""
Local model bridge for openclaude-main.

Serves the downloaded HF/PyTorch mini models (the ones that aren't
Ollama-servable GGUF files) over a small local HTTP API, so tools in the
Bun/TypeScript agentic app can call out to them the same way they call out
to Ollama for the math model.

Run with:  python server.py   (or via start.ps1, which points at an existing
venv with fastapi/uvicorn/transformers/torch already installed).

Extending to another downloaded model: copy local_models/document_qa.py or
local_models/image_caption.py as a template — each one:
  1. defines a `_do_load()` that imports its (concrete, not Auto*/pipeline())
     model classes and returns a handle (any object — a tuple of
     model+tokenizer/processor is typical),
  2. registers a `local_models.manager.ModelSpec` for itself at import time
     (name, loader, an estimated_mb footprint, heavy/device/fp16 flags),
  3. wraps its sync inference function's model access in
     `with manager.use(name) as handle: ...` instead of a private
     `_model`/`_tokenizer` global,
  4. keeps the same asyncio.to_thread-wrapped async version for use inside
     FastAPI without blocking the event loop during CPU-bound inference.
Then add one route below that calls the async version. That's the whole
pattern — no other file needs to change. The shared `local_models.manager`
(see its own docstring) is what actually owns loading/eviction/budget
tracking across every registered model — don't reintroduce a per-module
lazy-singleton, it'll drift out of sync with budget/LRU/heavy-exclusivity.
"""
import logging
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from local_models import document_qa, image_caption
from local_models.manager import manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("model_bridge")

app = FastAPI(title="openclaude-main local model bridge")

# Security review note (2026-08-12): this bridge binds to 127.0.0.1 only
# (see uvicorn.run below) so it's never reachable off-machine directly, but
# loopback binding alone doesn't stop DNS rebinding — a page the machine's
# user has open in a browser can resolve an attacker-controlled hostname to
# 127.0.0.1 after the fact and issue same-origin requests here. Rejecting
# any request whose Host header isn't 127.0.0.1/localhost closes that route
# cheaply; the real TS caller always talks to this bridge by IP/port
# directly, so this has no legitimate-traffic cost.
_ALLOWED_HOSTS = {"127.0.0.1", "localhost"}


@app.middleware("http")
async def reject_unexpected_host(request: Request, call_next):
    host = request.headers.get("host", "").split(":", 1)[0].lower()
    if host not in _ALLOWED_HOSTS:
        logger.warning("rejected request with unexpected Host header: %r", host)
        return JSONResponse(status_code=403, content={"detail": "forbidden"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/status")
async def status():
    """What's currently loaded, the declared/estimated committed MB against
    the configured budget, and a real current-process RSS reading. For
    debugging and for the eval harness (scripts/eval/specialistEval.ts and
    successors) to check bridge memory behavior across a run.
    """
    return manager.status()


class DocumentQARequest(BaseModel):
    question: str
    context: str


class DocumentQAResponse(BaseModel):
    answer: str
    score: float


@app.post("/document-qa", response_model=DocumentQAResponse)
async def document_qa_endpoint(req: DocumentQARequest):
    if not req.context.strip():
        raise HTTPException(status_code=400, detail="context must not be empty")
    result = await document_qa.answer_async(req.question, req.context)
    return DocumentQAResponse(**result)


class ImageCaptionRequest(BaseModel):
    image_path: str


class ImageCaptionResponse(BaseModel):
    caption: str


@app.post("/image-caption", response_model=ImageCaptionResponse)
async def image_caption_endpoint(req: ImageCaptionRequest):
    try:
        result = await image_caption.caption_async(req.image_path)
    except FileNotFoundError:
        # Deliberately the same 404, with the same generic detail, as the
        # OSError case below — see image_caption.py's caption() docstring
        # note. Do not reintroduce a distinct message/status here; that
        # would resurrect the existence-oracle this collapse closes.
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        # Covers PIL.UnidentifiedImageError (an OSError subclass) and other
        # I/O failures opening an existing-but-unusable path — collapsed
        # into the same response as "not found" (see above).
        raise HTTPException(status_code=404, detail="image not found or not readable")
    return ImageCaptionResponse(caption=result)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MODEL_BRIDGE_PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port)
