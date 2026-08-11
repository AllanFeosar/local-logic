/**
 * MIGRATION NOTICE
 * ────────────────────────────────────────────────────────────────────────────
 * This file (openaiShim.ts) has been MIGRATED to the Backend.
 *
 * OpenAI-compatible provider handling now lives in:
 *   mcp-openclaude/LlmBackend/backend/router/openaiRouter.js
 *
 * Providers handled by openaiRouter.js:
 *   • OpenAI (gpt-4o, gpt-4o-mini)
 *   • Groq (llama-3.3-70b, mixtral)
 *   • Ollama (local models)
 *   • DeepSeek, OpenRouter, Mistral, Together, Fireworks
 *   • GitHub Models
 *
 * Frontend code should NOT import this file.
 * Use backendClient.ts instead.
 *
 * DO NOT restore OpenAI SDK imports here.
 */
