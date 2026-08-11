"""Extractive question-answering over a supplied text passage, via the
locally-downloaded distilbert-base-cased-distilled-squad checkpoint.

NOTE: transformers v5 dropped the old pipeline("question-answering", ...)
task entirely (confirmed empirically — check_task() raises KeyError, "
question-answering" isn't in the supported task list on transformers
5.12.1). This does the span extraction manually instead: run the model,
take the argmax of the start/end logits, decode that token span. This is
what the old pipeline did internally anyway, minus n-best/no-answer
handling, which this simple QA use case doesn't need.

Lazy-load pattern otherwise matches Debate/backend/app/infrastructure/
local_models/claimbuster.py: singleton model+tokenizer, sync function, and
an asyncio.to_thread-wrapped async version for use inside FastAPI without
blocking the event loop during CPU-bound inference.
"""
import asyncio
import logging
import os

logger = logging.getLogger(__name__)

_MODEL_PATH = os.environ.get(
    "DOCUMENT_QA_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\distilbert-base-cased-distilled-squad",
)

_model = None
_tokenizer = None


def _load():
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer

    from transformers import AutoModelForQuestionAnswering, AutoTokenizer

    logger.info("Loading document-qa model from %s", _MODEL_PATH)
    _tokenizer = AutoTokenizer.from_pretrained(_MODEL_PATH)
    _model = AutoModelForQuestionAnswering.from_pretrained(_MODEL_PATH)
    _model.eval()
    logger.info("document-qa model ready")
    return _model, _tokenizer


def answer(question: str, context: str) -> dict:
    import torch

    model, tokenizer = _load()
    inputs = tokenizer(question, context, return_tensors="pt", truncation=True, max_length=384)
    with torch.no_grad():
        outputs = model(**inputs)

    start_logits = outputs.start_logits[0]
    end_logits = outputs.end_logits[0]
    start_idx = int(torch.argmax(start_logits))
    end_idx = int(torch.argmax(end_logits))
    if end_idx < start_idx:
        end_idx = start_idx

    input_ids = inputs["input_ids"][0]
    answer_text = tokenizer.decode(input_ids[start_idx : end_idx + 1], skip_special_tokens=True).strip()

    start_prob = float(torch.softmax(start_logits, dim=0)[start_idx])
    end_prob = float(torch.softmax(end_logits, dim=0)[end_idx])

    return {"answer": answer_text, "score": start_prob * end_prob}


async def answer_async(question: str, context: str) -> dict:
    return await asyncio.to_thread(answer, question, context)


def warmup() -> None:
    _load()
    logger.info("document-qa model warmed up")
