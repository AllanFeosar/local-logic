"""Extractive question-answering over a supplied text passage, via the
locally-downloaded distilbert-base-cased-distilled-squad checkpoint.

NOTE: transformers v5 dropped the old pipeline("question-answering", ...)
task entirely (confirmed empirically — check_task() raises KeyError, "
question-answering" isn't in the supported task list on transformers
5.12.1). This does the span extraction manually instead: run the model,
take the argmax of the start/end logits, decode that token span. This is
what the old pipeline did internally anyway, minus n-best/no-answer
handling, which this simple QA use case doesn't need.

Loading/eviction is delegated to the shared `local_models.manager`
singleton (see that module's docstring for the full pattern: budget cap +
LRU eviction, single-flight loading, heavy-model exclusivity, device stub,
/status support) instead of a private module-level `_model`/`_tokenizer`
singleton. This module only owns: where the model lives on disk, how to
load it, and how to run inference on an already-loaded handle.
"""
import asyncio
import logging
import os

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "document-qa"
_MODEL_PATH = os.environ.get(
    "DOCUMENT_QA_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\distilbert-base-cased-distilled-squad",
)

# Checkpoint is ~249 MB on disk (fp32 weights); ~300 MB budgets in some
# margin for the tokenizer + runtime/activation overhead. See
# local_models/manager.py's ModelSpec docstring for what this number is
# used for (eviction bookkeeping) and isn't (a measured RSS delta).
_ESTIMATED_MB = 300.0


def _do_load():
    from transformers import AutoModelForQuestionAnswering, AutoTokenizer

    logger.info("Loading document-qa model from %s", _MODEL_PATH)
    tokenizer = AutoTokenizer.from_pretrained(_MODEL_PATH)
    model = AutoModelForQuestionAnswering.from_pretrained(_MODEL_PATH)
    model.eval()
    logger.info("document-qa model ready")
    return model, tokenizer


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


def answer(question: str, context: str) -> dict:
    import torch

    with manager.use(_MODEL_NAME) as (model, tokenizer):
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
    with manager.use(_MODEL_NAME):
        pass
    logger.info("document-qa model warmed up")
