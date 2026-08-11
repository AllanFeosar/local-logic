/**
 * MIGRATION NOTICE
 * ────────────────────────────────────────────────────────────────────────────
 * This file (client.ts) has been MIGRATED to the Backend.
 *
 * Provider clients now live in:
 *   mcp-openclaude/LlmBackend/backend/router/
 *     ├─ anthropicRouter.js  — Direct Anthropic API
 *     ├─ bedrockRouter.js    — AWS Bedrock
 *     ├─ vertexRouter.js     — Google Vertex AI   ← NEW
 *     ├─ azureRouter.js      — Azure AI Foundry   ← NEW
 *     └─ claudeRouter.js     — Unified router (picks the right one)
 *
 * Frontend code should NOT import this file.
 * Instead, use backendClient.ts:
 *
 *   import { backendClient } from '../backendClient.js'
 *   for await (const chunk of backendClient.streamChat(modelId, messages)) {
 *     // handle chunk
 *   }
 *
 * The backendClient calls POST http://localhost:3001/api/chat
 * which routes to the correct provider on the Backend.
 *
 * DO NOT add new API client code here.
 * DO NOT restore SDK imports here.
 */
