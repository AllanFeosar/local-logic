"""
Local model bridge for openclaude-main.

Serves the downloaded HF/PyTorch mini models (the ones that aren't
Ollama-servable GGUF files) over a small local HTTP API, so tools in the
Bun/TypeScript agentic app can call out to them the same way they call out
to Ollama for the math model.

Run with:  python server.py   (or via start.ps1, which points at an existing
venv with fastapi/uvicorn/transformers/torch already installed).

Extending to another downloaded model: copy local_models/document_qa.py or
local_models/image_caption.py as a template (lazy-load singleton + sync fn +
asyncio.to_thread async wrapper), then add one route below that calls it.
That's the whole pattern — no other file needs to change.
"""
import logging
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from local_models import document_qa, image_caption

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("model_bridge")

app = FastAPI(title="openclaude-main local model bridge")


@app.get("/health")
async def health():
    return {"status": "ok"}


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
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return ImageCaptionResponse(caption=result)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MODEL_BRIDGE_PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port)
