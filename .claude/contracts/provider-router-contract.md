# Provider Router Contract — OpenClaude

> Maintained by **provider-router-agent**. Read by **tools-execution-agent**
> (how a tool call's result gets fed back through the query engine to the
> model), **commands-skills-agent** (how a command triggers a query), and
> **tui-agent** (what shape streamed output arrives in for rendering).
> Format: provider adapter interface → request/response shapes → supported
> providers → error handling. Overwritten in place as the router changes —
> living document, not a changelog. Point-in-time integration reports belong
> in `.claude/contracts/handoffs/`, not here.

---

## 1. Provider adapter shape (Strategy pattern, `src/services/api/`)

```typescript
interface ProviderRouter {
  call(params: CallParams): Promise<Response>
  getAvailableModels(): Model[]
}
```
Concrete adapters: an OpenAI-compatible wrapper (covers OpenAI, OpenRouter,
DeepSeek, Groq, Mistral, LM Studio, Ollama, Atomic Chat, Together AI, Azure
OpenAI, GitHub Models — anything speaking the OpenAI Chat Completions
shape), `codexShim.ts` (ChatGPT/Codex `codex_responses` transport, distinct
from chat completions), plus Bedrock/Vertex/Foundry SDK-backed paths. Adding
a provider means adding an adapter here and registering it in provider
discovery — never special-casing a provider inside `QueryEngine.ts`.

### `ResolvedProviderRequest` (`src/services/api/providerConfig.ts`)
```typescript
export type ProviderTransport = 'chat_completions' | 'codex_responses'

export type ResolvedProviderRequest = {
  transport: ProviderTransport
  requestedModel: string
  resolvedModel: string
  baseUrl: string
  reasoning?: { effort: 'low' | 'medium' | 'high' | 'xhigh' }
}
```
Model aliases resolve through a table (e.g. `codexplan` → `gpt-5.4` at
`high` reasoning, `codexspark` → `gpt-5.3-codex-spark`) — see
`CODEX_ALIAS_MODELS` in `providerConfig.ts` for the live list; extend it
there, not with ad hoc string matching elsewhere.

### `ResolvedCodexCredentials`
```typescript
export type ResolvedCodexCredentials = {
  apiKey: string
  accountId?: string
  authPath?: string
  source: 'env' | 'auth.json' | 'none'
}
```
Codex credentials resolve in this order: `CODEX_API_KEY` env var → 
`~/.codex/auth.json` (or `CODEX_AUTH_JSON_PATH` override) → none. Never log
`apiKey`.

---

## 2. Streaming shape (`services/remoteAgentService.ts` house style)

Every provider-facing streaming function is an `async function*` yielding
`AsyncGenerator<string>` — **not** a Promise-wrapped buffer, and not an
`async function` merely typed as returning `AsyncGenerator` (that shape
doesn't actually produce an iterable and was a real build-blocking bug
here previously).
```typescript
export async function* invokeRemoteAgent(
  request: RemoteAgentRequest,
): AsyncGenerator<string> {
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(request) })
  for await (const chunk of parseSSE(response.body)) {
    yield chunk.content
  }
}
```
Consumers iterate with `for await (const chunk of ...)` — `tui-agent`'s
REPL rendering and any command handler awaiting a query both rely on this
shape being a real async iterable, not a resolved array.

---

## 3. Supported providers (env-var configuration surface)

| Provider | Base URL | Key required |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` (default) | Yes |
| Ollama | `http://localhost:11434/v1` | No |
| DeepSeek | `https://api.deepseek.com/v1` | Yes |
| Gemini (via OpenRouter) | `https://openrouter.ai/api/v1` | Yes |
| Groq | `https://api.groq.com/openai/v1` | Yes |
| AWS Bedrock | — (uses AWS credential chain) | AWS creds |
| LM Studio | `http://localhost:1234/v1` | No |
| Atomic Chat | `http://127.0.0.1:1337/v1` | No |
| Together AI | `https://api.together.xyz/v1` | Yes |
| Azure OpenAI | `https://<resource>.openai.azure.com/...` | Yes |
| GitHub Models | `https://models.inference.ai.azure.com` | PAT |
| Codex (ChatGPT auth) | `https://chatgpt.com/backend-api/codex` | Codex/ChatGPT auth |

Core env vars: `CLAUDE_CODE_USE_OPENAI`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
`OPENAI_BASE_URL`, `ANTHROPIC_MODEL` (fallback if `OPENAI_MODEL` unset),
`CODEX_API_KEY`/`CODEX_AUTH_JSON_PATH`/`CODEX_HOME`. Full table with
per-provider setup snippets: `.claude/contracts/project-docs.md` §3.

Local providers (base URL on `localhost`/`127.0.0.1`) are exempt from the
key requirement — `doctor:runtime` (`scripts/system-check.ts`) enforces
this distinction and fails fast on a placeholder key for a non-local URL.

---

## 4. Error handling contract

```typescript
try {
  // provider call
} catch (error) {
  if (error instanceof ValidationError) {
    // bad request shape — surface to the command layer, don't retry
  } else if (error instanceof ProviderError) {
    // provider failure — services/api/withRetry.ts governs retry policy;
    // FallbackTriggeredError (services/api/withRetry.js) signals a
    // fallback-provider switch was attempted
  } else {
    // log via services/api/logging.ts, then rethrow
  }
}
```
Never surface a raw provider error message containing a credential value —
`errorUtils.ts` sanitization is the existing pattern to extend, not
bypass.

---

## 5. Agent-to-provider routing (`~/.claude/settings.json`)

Per-agent model overrides layer on top of the global provider (see
`project-docs.md` §3 for the full config shape and priority order:
`name` > `subagent_type` > `"default"` > global env vars). This agent
(`provider-router-agent`) owns the resolution logic; the config file itself
is user-owned, not generated or written by any agent.

---

## 6. Not yet implemented / planned
> `provider-router-agent` adds entries here as new providers/transports are
> added.

(none tracked yet — this scaffold was generated before any post-scaffold
provider work began)
