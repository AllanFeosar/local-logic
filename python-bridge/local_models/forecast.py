"""Zero-shot time-series forecasting via the locally-downloaded
chronos-t5-tiny checkpoint, using the `chronos-forecasting` PyPI package's
`ChronosPipeline` (the model card's own documented usage — not a hand-
rolled T5 loader; Chronos' tokenization/detokenization of a time series
into T5 vocab tokens is package-internal and non-trivial to reimplement
correctly).

Note: `chronos-forecasting`'s PyPI releases before 2.0 declare
`transformers<5`, incompatible with this project's pinned transformers
5.12.1 — this module requires `chronos-forecasting>=2.0` (pinned exactly
in python-bridge/venv, see README.md), which declares `transformers<6,
>=4.41` and was live-verified against 5.12.1 before being pinned.

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here.

Device placement: device="cpu" — chronos-t5-tiny is ~34 MB on disk (8M
params), no GPU placement needed per LOCAL_AI_MASTER_PLAN.md §3/§4 (that
capacity is reserved for BLIP/DistilBERT and future bigger models).
"""
import asyncio
import logging
import os

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

_MODEL_NAME = "forecast"
_MODEL_PATH = os.environ.get(
    "FORECAST_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\chronos-t5-tiny",
)

# Checkpoint is ~34 MB on disk; ~200 MB budgets in some margin for the
# runtime/activation overhead of the sampling-based predict() (Chronos
# forecasts by sampling multiple trajectories, not a single forward pass).
# See local_models/manager.py's ModelSpec docstring for what this number is
# used for (eviction bookkeeping) and isn't (a measured RSS delta).
_ESTIMATED_MB = 200.0

# Sanity cap on requested horizon — these are small, fast, "quick answer"
# models per LOCAL_AI_MASTER_PLAN.md; an unbounded horizon would let one
# request force a very long autoregressive generation. Not part of the
# fixed contract, just a defensive limit; raise if a real use case needs
# more.
_MAX_HORIZON = 256

# Quantiles sampled for the low/high uncertainty band — matches the 80%
# interval used in the model card's own example.
_LOW_QUANTILE = 0.1
_HIGH_QUANTILE = 0.9


def _do_load(device: str):
    import torch
    from chronos import ChronosPipeline

    logger.info("Loading forecast model from %s (device=%s)", _MODEL_PATH, device)
    pipeline = ChronosPipeline.from_pretrained(_MODEL_PATH, device_map=device, dtype=torch.float32)
    logger.info("forecast model ready")
    return pipeline


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


class InvalidForecastInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, per the tool-contract's note on this route.
    """


def _validate(series, horizon) -> None:
    if not series:
        raise InvalidForecastInput("series must not be empty")
    if len(series) < 2:
        raise InvalidForecastInput("series must have at least 2 points")
    if not isinstance(horizon, int) or horizon <= 0:
        raise InvalidForecastInput("horizon must be a positive integer")
    if horizon > _MAX_HORIZON:
        raise InvalidForecastInput(f"horizon must be <= {_MAX_HORIZON}")


def forecast(series: "list[float]", horizon: int) -> dict:
    import numpy as np
    import torch

    _validate(series, horizon)

    context = torch.tensor(series, dtype=torch.float32)
    with manager.use(_MODEL_NAME) as pipeline:
        samples = pipeline.predict(context, prediction_length=horizon)

    # samples shape: [num_series=1, num_samples, horizon]
    low, median, high = np.quantile(
        samples[0].numpy(), [_LOW_QUANTILE, 0.5, _HIGH_QUANTILE], axis=0
    )
    return {
        "forecast": [float(v) for v in median],
        "low": [float(v) for v in low],
        "high": [float(v) for v in high],
    }


async def forecast_async(series: "list[float]", horizon: int) -> dict:
    return await asyncio.to_thread(forecast, series, horizon)


def warmup() -> None:
    with manager.use(_MODEL_NAME):
        pass
    logger.info("forecast model warmed up")
