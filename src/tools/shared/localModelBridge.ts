/**
 * Shared config for tools that call the Python local model bridge
 * (python-bridge/server.py) — the FastAPI service that serves the
 * downloaded HF/PyTorch mini models that aren't Ollama-servable GGUF
 * files. See python-bridge/README.md for what's running there and how to
 * start it.
 */
export const MODEL_BRIDGE_BASE_URL =
  process.env.MODEL_BRIDGE_BASE_URL ?? 'http://127.0.0.1:8756'

/**
 * These are small CPU-bound pipelines (not a multi-minute reasoning trace
 * like the math model) — generous enough to cover a cold first-call model
 * load (weights read from disk) without being so long a genuinely-down
 * bridge hangs the agent for minutes.
 */
export const MODEL_BRIDGE_TIMEOUT_MS = 120_000

export function modelBridgeUnavailableMessage(cause: unknown): string {
  return (
    `Could not reach the local model bridge at ${MODEL_BRIDGE_BASE_URL}. ` +
    `Is it running? Start it with python-bridge/start.ps1. (${String(cause)})`
  )
}
