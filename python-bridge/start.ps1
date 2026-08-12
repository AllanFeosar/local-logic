# Starts the local model bridge server. Reuses the Debate project's venv by
# default (it already has torch/transformers/fastapi installed — see
# requirements.txt for what's needed if pointing this at a fresh venv instead
# via $env:MODEL_BRIDGE_PYTHON before running this script).

$defaultPython = "E:\Allan Project\Debate Project\Debate\backend\venv\Scripts\python.exe"
$python = if ($env:MODEL_BRIDGE_PYTHON) { $env:MODEL_BRIDGE_PYTHON } else { $defaultPython }

if (-not (Test-Path $python)) {
    Write-Error "Python interpreter not found at $python. Set `$env:MODEL_BRIDGE_PYTHON to a venv's python.exe (needs fastapi, uvicorn, transformers, torch — see requirements.txt)."
    exit 1
}

Set-Location $PSScriptRoot
& $python server.py
