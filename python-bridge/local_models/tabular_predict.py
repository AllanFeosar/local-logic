"""Zero-shot tabular classification/regression via TabPFN-v2, using the
locally-downloaded classifier/regressor `.ckpt` checkpoints.

The `tabpfn` PyPI package's sklearn-style `TabPFNClassifier`/
`TabPFNRegressor` is the correct, documented way to use these checkpoints
(per the model repos' own READMEs — `pip install tabpfn`) — not a hand-
rolled loader. Pointed at an *already-existing* local file via `model_path`
(not `"auto"`), `tabpfn` never attempts a hub download (confirmed by
reading `tabpfn/model_loading.py`: `resolve_model_path()` + `load_model()`
only touch `huggingface_hub` inside the download-if-missing branch, which
`model_path.exists()` short-circuits past for us).

Telemetry note (2026-08-12, verified by reading `tabpfn_common_utils`'
source, not just its docs): `TabPFNClassifier`/`TabPFNRegressor.__init__`
call `tabpfn_common_utils.telemetry.interactive.ping()`, which — unless
disabled — attempts an outbound network call (a short-timeout fetch of a
remote PostHog-enablement config, then a PostHog event if enabled) on
every construction. This bridge is a local, offline tool, so telemetry is
disabled via the package's own documented kill switch,
`TABPFN_DISABLE_TELEMETRY=1` — set as a process env var below, before the
first `import tabpfn` anywhere in this process. `ProductTelemetry.
telemetry_enabled()` (in `tabpfn_common_utils/telemetry/core/service.py`)
checks this env var *first* and returns `False` immediately if set,
before any network attempt — confirmed by reading that function, not
assumed. See `python-bridge/README.md`'s TabPFN section for the fuller
trace and the dependency-pin note this package required (a real, if
narrow, `huggingface_hub` version conflict between `transformers` 5.12.1
[needs >=1.5] and `tabpfn-common-utils` [declares <1] — resolved in favor
of the >=1.5 pin transformers needs, safe because tabpfn's own runtime
usage of `huggingface_hub` is confined to the hub-download path this
module never exercises; verified live, not just reasoned about).

Loading/eviction is delegated to the shared `local_models.manager`
singleton, same pattern as every other module here — two independent
`ModelSpec`s (classifier, regressor) since a request only ever needs one
of the two depending on `operation`.

Device placement: both registered device="cpu" — TabPFN-v2's checkpoints
are tiny (a few tens of MB) and per LOCAL_AI_MASTER_PLAN.md §3/§4 this
tier doesn't need GPU placement; that capacity is reserved for BLIP/
DistilBERT and future bigger models (see document_qa.py/image_caption.py).
"""
import asyncio
import logging
import os

from local_models.manager import ModelSpec, manager

logger = logging.getLogger(__name__)

# Must be set before `tabpfn` (or anything that imports it) is first
# imported anywhere in this process — see module docstring above.
os.environ.setdefault("TABPFN_DISABLE_TELEMETRY", "1")

_CLF_MODEL_NAME = "tabpfn-clf"
_REG_MODEL_NAME = "tabpfn-reg"

_CLF_MODEL_PATH = os.environ.get(
    "TABPFN_CLF_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\TabPFN-v2-clf\tabpfn-v2-classifier.ckpt",
)
_REG_MODEL_PATH = os.environ.get(
    "TABPFN_REG_MODEL_PATH",
    r"C:\Users\allge\AI Models\huggingface\TabPFN-v2-reg\tabpfn-v2-regressor.ckpt",
)

# Checkpoints are ~29 MB (clf) / ~44 MB (reg) on disk; budgeted generously
# for the sklearn-wrapper + in-context-inference activation overhead
# tabpfn's own fit()/predict() allocate around the raw weights (TabPFN's
# "training" is just caching the context — the real compute cost is a
# transformer forward pass at predict() time). See local_models/manager.py's
# ModelSpec docstring for what this number is used for (eviction
# bookkeeping) and isn't (a measured RSS delta).
_CLF_ESTIMATED_MB = 300.0
_REG_ESTIMATED_MB = 300.0


def _do_load_clf(device: str):
    from tabpfn import TabPFNClassifier

    logger.info("Loading TabPFN classifier from %s (device=%s)", _CLF_MODEL_PATH, device)
    clf = TabPFNClassifier(model_path=_CLF_MODEL_PATH, device=device)
    logger.info("TabPFN classifier ready")
    return clf


def _do_load_reg(device: str):
    from tabpfn import TabPFNRegressor

    logger.info("Loading TabPFN regressor from %s (device=%s)", _REG_MODEL_PATH, device)
    reg = TabPFNRegressor(model_path=_REG_MODEL_PATH, device=device)
    logger.info("TabPFN regressor ready")
    return reg


manager.register(
    ModelSpec(
        name=_CLF_MODEL_NAME,
        loader=_do_load_clf,
        estimated_mb=_CLF_ESTIMATED_MB,
        heavy=False,
        device="cpu",
        fp16=False,
    )
)
manager.register(
    ModelSpec(
        name=_REG_MODEL_NAME,
        loader=_do_load_reg,
        estimated_mb=_REG_ESTIMATED_MB,
        heavy=False,
        device="cpu",
        fp16=False,
    )
)


class InvalidTabularInput(ValueError):
    """Malformed request data — the route in server.py maps this to a 400,
    never a raw 500, per the tool-contract's note on this route.
    """


def _validate_table(train_features, train_labels, test_features) -> None:
    if not train_features:
        raise InvalidTabularInput("train_features must not be empty")
    if not train_labels:
        raise InvalidTabularInput("train_labels must not be empty")
    if not test_features:
        raise InvalidTabularInput("test_features must not be empty")
    if len(train_features) != len(train_labels):
        raise InvalidTabularInput(
            f"train_features has {len(train_features)} rows but train_labels "
            f"has {len(train_labels)} — they must be the same length"
        )
    width = len(train_features[0])
    if width == 0:
        raise InvalidTabularInput("train_features rows must not be empty")
    for i, row in enumerate(train_features):
        if len(row) != width:
            raise InvalidTabularInput(
                f"train_features row {i} has {len(row)} columns, expected "
                f"{width} (row 0's width) — all rows must be the same length"
            )
    for i, row in enumerate(test_features):
        if len(row) != width:
            raise InvalidTabularInput(
                f"test_features row {i} has {len(row)} columns, expected "
                f"{width} (train_features' width)"
            )


def _to_native(value):
    """numpy scalar -> plain Python value, for JSON serialization via
    pydantic. Handles the numpy scalar types TabPFN's predict()/classes_
    can hand back regardless of whether the original labels were numbers
    or strings (numpy.str_ included — it subclasses str but this keeps the
    conversion explicit/uniform rather than relying on that).
    """
    import numpy as np

    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.str_):
        return str(value)
    return value


def predict(operation: str, train_features, train_labels, test_features) -> dict:
    import numpy as np

    if operation not in ("classify", "regress"):
        raise InvalidTabularInput(f"unknown operation: {operation!r}")

    _validate_table(train_features, train_labels, test_features)

    X_train = np.array(train_features, dtype=float)
    X_test = np.array(test_features, dtype=float)

    if operation == "classify":
        # dtype=object preserves each label's original Python type
        # (int/float/str) element-wise instead of coercing the whole
        # column to one dtype, so predictions round-trip the same type
        # the caller trained with.
        y_train = np.array(train_labels, dtype=object)
        with manager.use(_CLF_MODEL_NAME) as clf:
            clf.fit(X_train, y_train)
            preds = clf.predict(X_test)
            probs = clf.predict_proba(X_test)
        return {
            "predictions": [_to_native(p) for p in preds],
            "probabilities": [[float(p) for p in row] for row in probs],
        }

    # Security review note (2026-08-12): train_labels is typed as
    # list[str | float] at the request layer (a string label is legitimate
    # for "classify"), so a string label reaching here for "regress" isn't
    # caught by Pydantic or _validate_table above — np.array(..., dtype=float)
    # would raise a bare ValueError that escapes server.py's
    # InvalidTabularInput handler as an unhandled 500. The inference path
    # (predictTask.ts) never sends this combination (any string label always
    # infers "classify"), but the flat tool schema still permits a caller to
    # set operation="regress" explicitly with string labels, so this has to
    # be checked here, not just relied on upstream.
    if any(not isinstance(label, (int, float)) or isinstance(label, bool) for label in train_labels):
        raise InvalidTabularInput(
            "train_labels must be all-numeric for operation \"regress\" — "
            "got a non-numeric label; use operation \"classify\" instead"
        )
    y_train = np.array(train_labels, dtype=float)
    with manager.use(_REG_MODEL_NAME) as reg:
        reg.fit(X_train, y_train)
        preds = reg.predict(X_test)
    return {"predictions": [float(p) for p in preds]}


async def predict_async(operation: str, train_features, train_labels, test_features) -> dict:
    return await asyncio.to_thread(predict, operation, train_features, train_labels, test_features)


def warmup() -> None:
    with manager.use(_CLF_MODEL_NAME):
        pass
    with manager.use(_REG_MODEL_NAME):
        pass
    logger.info("tabpfn classifier/regressor warmed up")
