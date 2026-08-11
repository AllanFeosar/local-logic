/**
 * MIGRATION NOTICE
 * ────────────────────────────────────────────────────────────────────────────
 * This file (auth.ts) has been MIGRATED to the Backend.
 *
 * Credential management now lives in:
 *   mcp-openclaude/LlmBackend/backend/services/credentialManager.js
 *
 * credentialManager.js handles:
 *   • Anthropic API key
 *   • OpenAI API key + base URL
 *   • AWS Bedrock (access key + secret + session token)
 *   • Google Vertex AI (project ID + credentials file)
 *   • Azure Foundry (resource name + API key or AD token)
 *   • OpenRouter, GitHub Models, Groq, Ollama, NVIDIA, Bytez
 *   • Codex API key or ~/.codex/auth.json
 *
 * The Frontend only receives availability flags via GET /api/provider-status:
 *   {
 *     providers: {
 *       anthropic: { available: true, name: 'Anthropic Claude' },
 *       openai:    { available: false, ... },
 *       ...
 *     }
 *   }
 *
 * The Frontend NEVER receives actual API keys or credentials.
 *
 * OAuth token handling for Claude.ai remains partially in the Frontend
 * (src/services/oauth/) for the authorization code flow. The Backend
 * proxies OAuth-authenticated API calls via:
 *   services/usageProxy.js
 *   services/filesProxy.js
 *   services/groveProxy.js
 *
 * DO NOT restore credential management here.
 * DO NOT add API keys to Frontend environment variables.
 */
