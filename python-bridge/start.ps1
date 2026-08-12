# Starts the local model bridge server. Defaults to the dedicated CUDA venv
# at python-bridge/venv (built 2026-08-12 — see README.md's "The venv" for
# exactly what's pinned in it and why). Override with $env:MODEL_BRIDGE_PYTHON
# to point at a different interpreter instead (e.g. to fall back to the old
# borrowed Debate venv, or a from-scratch CPU-only venv per requirements.txt).

$defaultPython = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
$python = if ($env:MODEL_BRIDGE_PYTHON) { $env:MODEL_BRIDGE_PYTHON } else { $defaultPython }

if (-not (Test-Path $python)) {
    Write-Error "Python interpreter not found at $python. Either build the dedicated venv (see README.md's 'The venv' section) or set `$env:MODEL_BRIDGE_PYTHON to another venv's python.exe (needs fastapi, uvicorn, transformers, torch, tabpfn, chronos-forecasting — see README.md for the full pinned list)."
    exit 1
}

Set-Location $PSScriptRoot
& $python server.py
