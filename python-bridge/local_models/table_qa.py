"""Table question-answering via the locally-downloaded
tapas-mini-finetuned-wtq checkpoint.

Standard transformers checkpoint (pytorch_model.bin + config.json,
architectures: ["TapasForQuestionAnswering"]) — loaded via TAPAS's
concrete classes (`TapasForQuestionAnswering`/`TapasTokenizer`) per this
project's established rule (two prior transformers-v5 `Auto*`/`pipeline()`
breakages — see document_qa.py/image_caption.py), though TAPAS itself
hasn't been observed broken through `Auto*` on this transformers version;
concrete classes are used anyway for consistency with the rest of this
package and because they're the classes the model card itself names.

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here.

Device placement: device="cpu" — this checkpoint is ~45 MB on disk, no GPU
placement needed per LOCAL_AI_MASTER_PLAN.md §3/§4 (that capacity is
reserved for BLIP/DistilBERT and future bigger models).
"""
import asyncio
import logging
import os

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "table-qa"
_MODEL_PATH = os.environ.get(
    "TABLE_QA_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\tapas-mini-finetuned-wtq",
)

# Checkpoint is ~45 MB on disk; ~200 MB budgets in some margin for the
# tokenizer + runtime/activation overhead. See local_models/manager.py's
# ModelSpec docstring for what this number is used for (eviction
# bookkeeping) and isn't (a measured RSS delta).
_ESTIMATED_MB = 200.0

# From the checkpoint's own config.json (max_num_rows / max_num_columns) —
# validated up front so an over-large table fails with a clear 400 instead
# of a confusing error surfacing from deep inside the tokenizer/model.
_MAX_ROWS = 64
_MAX_COLUMNS = 32

_AGGREGATION_LABELS = {0: "NONE", 1: "SUM", 2: "AVERAGE", 3: "COUNT"}


def _do_load(device: str):
    from transformers import TapasForQuestionAnswering, TapasTokenizer

    logger.info("Loading table-qa model from %s (device=%s)", _MODEL_PATH, device)
    tokenizer = TapasTokenizer.from_pretrained(_MODEL_PATH)
    model = TapasForQuestionAnswering.from_pretrained(_MODEL_PATH)
    model.eval()
    if device == "cuda":
        model = model.to(device)
    logger.info("table-qa model ready")
    return model, tokenizer, device


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


class InvalidTableInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, per the tool-contract's note on this route.
    """


def _validate_table(question: str, columns, rows) -> None:
    if not question or not question.strip():
        raise InvalidTableInput("question must not be empty")
    if not columns:
        raise InvalidTableInput("table.columns must not be empty")
    if not rows:
        raise InvalidTableInput("table.rows must not be empty")
    if len(columns) > _MAX_COLUMNS:
        raise InvalidTableInput(
            f"table has {len(columns)} columns, this model supports at most {_MAX_COLUMNS}"
        )
    if len(rows) > _MAX_ROWS:
        raise InvalidTableInput(
            f"table has {len(rows)} rows, this model supports at most {_MAX_ROWS}"
        )
    width = len(columns)
    for i, row in enumerate(rows):
        if len(row) != width:
            raise InvalidTableInput(
                f"table.rows[{i}] has {len(row)} cells, expected {width} "
                f"(table.columns' length) — every row must match the column count"
            )


def _format_answer(cell_values: "list[str]", aggregation: str) -> str:
    if aggregation == "NONE" or not cell_values:
        return ", ".join(cell_values)

    if aggregation == "COUNT":
        return str(len(cell_values))

    # SUM/AVERAGE need numeric cells; fall back to the raw joined cell
    # values if they don't parse cleanly rather than raising — a weird
    # aggregation prediction over non-numeric cells is a model-confidence
    # problem, not something this route should turn into a 500 for.
    try:
        numbers = [float(v.replace(",", "").strip()) for v in cell_values]
    except ValueError:
        return ", ".join(cell_values)

    if aggregation == "SUM":
        return str(sum(numbers))
    if aggregation == "AVERAGE":
        return str(sum(numbers) / len(numbers))
    return ", ".join(cell_values)


def answer(question: str, columns: "list[str]", rows: "list[list[str]]") -> dict:
    import pandas as pd
    import torch

    _validate_table(question, columns, rows)

    table = pd.DataFrame(rows, columns=columns, dtype=str)

    with manager.use(_MODEL_NAME) as (model, tokenizer, device):
        inputs = tokenizer(table=table, queries=[question], padding="max_length", truncation=True, return_tensors="pt")
        inputs = inputs.to(device)
        with torch.no_grad():
            outputs = model(**inputs)

        predicted_coordinates, predicted_aggregation_indices = tokenizer.convert_logits_to_predictions(
            dict(inputs),
            outputs.logits.detach().cpu(),
            outputs.logits_aggregation.detach().cpu(),
        )

    coordinates = predicted_coordinates[0] if predicted_coordinates else []
    aggregation = _AGGREGATION_LABELS.get(
        predicted_aggregation_indices[0] if predicted_aggregation_indices else 0, "NONE"
    )
    cell_values = [str(table.iat[r, c]) for r, c in coordinates]

    return {
        "answer": _format_answer(cell_values, aggregation),
        "cells": [{"row": r, "column": c} for r, c in coordinates],
    }


async def answer_async(question: str, columns: "list[str]", rows: "list[list[str]]") -> dict:
    return await asyncio.to_thread(answer, question, columns, rows)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("table-qa model warmed up")
