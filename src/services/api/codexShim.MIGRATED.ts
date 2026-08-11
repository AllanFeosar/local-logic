/**
 * MIGRATION NOTICE
 * ────────────────────────────────────────────────────────────────────────────
 * This file (codexShim.ts) has been MIGRATED to the Backend.
 *
 * Codex/ChatGPT API handling now lives in:
 *   mcp-openclaude/LlmBackend/backend/router/codexRouter.js
 *
 * codexRouter.js handles:
 *   • Bearer token auth (CODEX_API_KEY)
 *   • ~/.codex/auth.json fallback
 *   • Anthropic → Codex Responses API format conversion
 *   • SSE streaming of Codex responses
 *   • Models: gpt-5.4, gpt-5.3, gpt-5.3-codex
 *
 * Frontend code should NOT import this file.
 * Use backendClient.ts instead.
 *
 * DO NOT restore Codex SDK imports here.
 */
