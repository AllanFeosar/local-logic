# OpenClaude — Project Documentation

Consolidated reference for OpenClaude (`@gitlawb/openclaude`), v0.1.7. This file
replaces the previously separate `docs/` folder plus the various root-level
status/report files (`ANDROID_INSTALL.md`, `FIXES_SUMMARY.md`,
`INTEGRATION_*.md`, `PHASE_2_STATUS_REPORT.md`, `PLAYBOOK.md`,
`TODAY_COMPLETION_REPORT.txt`) — their content has been merged and condensed
here. `README.md`, `LICENSE`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, and
`SECURITY.md` still live at the repo root, untouched.

This is a *living* document in the `.claude/contracts/` sense: agents working
on this project may read it for background, but it's project reference
material, not one of the per-layer contracts (`provider-router-contract.md`,
`tool-contract.md`) those agents actively read/write during a dispatch.

---

## 1. What OpenClaude Is

An open-source coding-agent CLI (a Claude-Code-shaped terminal agent) opened
up to 200+ LLM providers — OpenAI-compatible APIs, Gemini, GitHub Models,
Codex, Ollama, Atomic Chat, AWS Bedrock, Google Vertex, Azure OpenAI, and
more — while keeping the same terminal-first workflow: prompts, tools,
agents, MCP, slash commands, and streaming output.

- **Runtime:** Node.js 20+, Bun 1.3.11+ (build/bundle only)
- **Language:** TypeScript (strict mode), ~1,976 source files under `src/`
- **UI:** React 19 via React-Ink (terminal rendering)
- **Bundler:** Bun, single-file ESM output (`dist/cli.mjs`, ~19MB + source map)
- **Satellite stacks:** `python-bridge/` (FastAPI local-model server) and
  `vscode-extension/openclaude-vscode/` (separate VS Code extension)

---

## 2. Installation

### Option A — npm (simplest)
```bash
npm install -g @gitlawb/openclaude
openclaude
```
If npm reports `ripgrep not found`, install ripgrep system-wide (`brew
install ripgrep` / `scoop install ripgrep` / `choco install ripgrep` /
`sudo apt install ripgrep`) and confirm `rg --version` works before retrying.

### Option B — From source with Bun
```bash
git clone <repo-url>
cd openclaude
bun install
bun run build     # → dist/cli.mjs
npm link          # optional, exposes `openclaude` globally
```
Requires Bun 1.3.11+ — older versions can fail `bun run build`, especially
on Windows.

### Option C — Run directly with Bun (no link)
```bash
bun install
bun run dev        # builds then runs dist/cli.mjs
```

### Option D — Android (Termux)
Bun has no native Android build, so this runs Bun's Linux binary inside a
`proot-distro` Ubuntu environment under Termux:
```bash
pkg update && pkg upgrade
pkg install nodejs-lts git proot-distro
git clone <repo-url> && cd openclaude && npm install && npm link
proot-distro install ubuntu
proot-distro login ubuntu
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc
cd /data/data/com.termux/files/home/openclaude
bun run build
node dist/cli.mjs
```
Needs ~700MB free storage. Recommended free model for this path (as of the
last check): `qwen/qwen3.6-plus-preview:free` via OpenRouter (1M context,
native tool calling). Groq/Cerebras free tiers were tested and rejected —
their token-per-minute limits are too low for OpenClaude's ~50K-token system
prompt; OpenRouter free models have no TPM cap (only 20 req/min, 200/day).

**System requirements (all paths):** Node 20+, 4GB RAM minimum (8GB
recommended), 2GB free disk, Windows/macOS/Linux.

---

## 3. Provider Configuration

Set via `.env`, shell env vars, or the in-app `/provider` guided setup
(saves to `.openclaude-profile.json`, gitignored).

### Quick reference

| Provider | Free tier | Cost | Setup | Latency |
|---|---|---|---|---|
| OpenAI | No | $0.03–0.30/M tokens | 5 min | Low |
| Ollama | Yes | Free (local) | 10 min | Varies (hardware) |
| DeepSeek | Partial | $0.0015/M tokens | 5 min | Low |
| Google Gemini (via OpenRouter) | Limited | Free/Paid | 5 min | Low |
| Groq | Partial | Free tier | 5 min | Very low |
| Claude via AWS Bedrock | No | $3–30/M tokens | 15 min | Low |
| LM Studio | Yes | Free (local) | 15 min | Varies |
| Together AI | Partial | Free tier | 5 min | Low |
| Atomic Chat (Apple Silicon local) | Yes | Free (local) | 10 min | Varies |
| Codex (ChatGPT auth) | — | Existing Codex/ChatGPT plan | 5 min | Low |

### Core env vars

| Variable | Required | Notes |
|---|---|---|
| `CLAUDE_CODE_USE_OPENAI` | Yes for OpenAI-compatible | Set to `1` |
| `OPENAI_API_KEY` | Yes* | `*` not needed for local providers (Ollama, LM Studio, Atomic Chat) |
| `OPENAI_MODEL` | Yes | e.g. `gpt-4o`, `deepseek-chat`, `llama3.3:70b` |
| `OPENAI_BASE_URL` | No | Defaults to `https://api.openai.com/v1` |
| `ANTHROPIC_MODEL` | No | Alternate way to set model; `OPENAI_MODEL` wins if both set |
| `CODEX_API_KEY` / `CODEX_AUTH_JSON_PATH` / `CODEX_HOME` | Codex only | Reads `~/.codex/auth.json` automatically if present |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Bedrock only | Standard AWS credential chain also works |
| `FIRECRAWL_API_KEY` | No | Enables richer `WebSearch` + JS-aware `WebFetch`; falls back gracefully without it |
| `OPENCLAUDE_DISABLE_CO_AUTHORED_BY` | No | Suppresses the `Co-Authored-By` trailer on generated commits |

### Per-provider snippets

```bash
# OpenAI
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_MODEL=gpt-4o

# Ollama (local, no key)
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3.3:70b        # or qwen2.5-coder:7b for coding

# DeepSeek
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-deepseek-key
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat

# Gemini via OpenRouter
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-or-your-openrouter-key
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_MODEL=google/gemini-2.0-flash-001

# Groq
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=gsk_your-key
export OPENAI_BASE_URL=https://api.groq.com/openai/v1
export OPENAI_MODEL=llama-3.3-70b-versatile

# Codex (ChatGPT auth)
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_MODEL=codexplan     # maps to GPT-5.4 high-reasoning
# optional if ~/.codex/auth.json doesn't already exist:
export CODEX_API_KEY=...

# Atomic Chat (Apple Silicon local, no key)
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://127.0.0.1:1337/v1
export OPENAI_MODEL=your-model-name

# LM Studio (local, no key)
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=your-loaded-model-name

# AWS Bedrock (Claude 3 family)
# No OPENAI_* vars — uses ~/.aws/credentials or AWS_* env vars directly
```

Windows PowerShell uses `$env:VAR="value"` instead of `export VAR=value`.

### Provider launch profiles (`scripts/provider-*.ts`)

```bash
bun run profile:init -- --provider ollama --model llama3.1:8b
bun run profile:init -- --provider ollama --goal coding      # auto-pick a local model
bun run profile:recommend -- --goal coding --benchmark        # preview only, no save
bun run profile:auto -- --goal latency                        # auto-apply best local/openai pick
bun run profile:codex                                          # defaults to codexplan
bun run dev:profile          # launch using the persisted .openclaude-profile.json
bun run dev:openai / dev:ollama / dev:codex / dev:atomic-chat  # direct provider launchers
```
`dev:openai`, `dev:ollama`, `dev:atomic-chat`, and `dev:codex` all run
`doctor:runtime` first and only launch if checks pass.

### Choosing a provider
- **Quick testing:** Ollama (free, local) or Groq (fast free tier)
- **Production:** OpenAI (most reliable) or Claude via Bedrock (if already on AWS)
- **Budget:** DeepSeek (cheapest) or Ollama (free)
- **Speed:** Groq or local Ollama (no network latency)
- **Quality:** GPT-4o or Claude via Bedrock

### Runtime hardening / verification
```bash
bun run smoke              # quick build + version check
bun run doctor:runtime     # validates provider env + reachability
bun run doctor:runtime:json
bun run doctor:report      # writes reports/doctor-runtime.json
bun run hardening:check    # smoke + doctor:runtime
bun run hardening:strict   # + project-wide typecheck
```
`doctor:runtime` fails fast on a placeholder key or a missing key for a
non-local provider URL. Local providers (`localhost:11434`,
`127.0.0.1:1337`, etc.) are exempt from the key requirement.

### Agent-to-provider routing (per-agent model overrides)
Add to `~/.claude/settings.json` to route different *agents* to different
providers within the same session (e.g. cheap model for review, strong model
for complex coding):
```json
{
  "agentModels": {
    "deepseek-chat": { "base_url": "https://api.deepseek.com/v1", "api_key": "sk-your-key" },
    "gpt-4o": { "base_url": "https://api.openai.com/v1", "api_key": "sk-your-key" }
  },
  "agentRouting": {
    "Explore": "deepseek-chat",
    "Plan": "gpt-4o",
    "general-purpose": "gpt-4o",
    "default": "gpt-4o"
  }
}
```
Priority: `name` > `subagent_type` > `"default"` > global provider env vars.
Matching is case-insensitive, hyphen/underscore-equivalent. `api_key` values
here are stored in plaintext — keep `settings.json` private, never commit it.

---

## 4. Architecture

```
CLI Interface (src/entrypoints/, main.tsx)
        │
   ┌────┴─────┐
Commands    Services
(src/       (src/services/)
commands/)       │
   └────┬────────┘
        │
Multi-Provider Router Layer (OpenAI-compatible)
        │
  ┌─────┼─────┬──────┬───────┐
 OpenAI Bedrock Vertex MCP  ...
```

**Command layer** (`src/commands/`) — user-facing `/command` handlers
(`/agent`, `/provider`, `/query`, `/help`, 20+ more), each implementing
`{ name, description, handler(context) }`.

**Service layer** (`src/services/`) — the multi-provider differentiator:
- `remoteAgentService.ts` — async-generator streaming (`AsyncGenerator<string>`)
  for memory-efficient real-time output, iterated with `for await`.
- `mcp/` — Model Context Protocol client: tool discovery, resource access,
  prompt composition.
- `api/` — per-provider adapters (OpenAI-compatible wrapper, Bedrock,
  Vertex, retry logic).

**Multi-provider router** — Strategy pattern: a common `ProviderRouter`
interface (`call()`, `getAvailableModels()`) with per-provider
implementations, so adding a provider doesn't touch core dispatch code.

**Tool system** (`src/tools/`) — Registry + executor pattern, 40+ built-in
tools (`{ name, description, execute(input) }`) across Agent
(multi-agent orchestration), Web (browser automation), Code
(analysis/manipulation), and System (file/terminal) categories.

**Build system** — Bun bundler, single-bundle output, feature flags (all
disabled for the open build: `VOICE_MODE`, `PROACTIVE`, `KAIROS`,
`BRIDGE_MODE`, and 14 more) plus a plugin system that stubs internal/native
modules and OpenTelemetry, and converts `.md`/`.txt` assets to string
exports at build time.

### Data flow (a single user query)
1. User input → CLI input handler → parsed command → routed to handler
2. Command processing: validate input, load context, prepare system prompt
3. Provider selection: detect from env/config, get the matching router
4. API call: format message, call provider, get response (stream or batch)
5. Output processing: parse response, execute any tool calls, display
6. Session management: persist to history/state

### State, types, error handling
- **State** (`src/state/`): immutable updates, single source of truth per
  component (userProfile, sessionHistory, providerConfig, toolRegistry,
  preferences).
- **Types**: API boundary types (`ProviderRequest`/`ProviderResponse`),
  internal `Command<T>`, domain types (`Message = UserMessage |
  AssistantMessage | ToolMessage`, `Tool`).
- **Errors**: try/catch by error class (`ValidationError`, `ProviderError`
  with possible provider fallback, else log-and-rethrow) — fail gracefully,
  give actionable messages, log for debugging.

### Design patterns in use
| Pattern | Where |
|---|---|
| Strategy | Provider routers (`src/services/`) |
| Factory | Tool creation (`src/tools/`) |
| Observer | State changes (`src/state/`) |
| Command | CLI commands |
| Registry | Tool/command lookup (`src/tools.ts`, `src/commands.ts`) |
| Singleton | Global config (`src/constants/`) |
| Adapter | Provider API compatibility (`src/services/api/`) |

### Security architecture (as designed)
- Credentials via env vars only; `.env.example` ships with no real secrets;
  runtime config validation at startup (`doctor:runtime`).
- TypeScript typing + runtime validation for user input; sanitization for
  dangerous operations.
- HTTPS-only provider communication with TLS validation.
- No `eval()`/dynamic code execution; sandboxing for untrusted content
  (`@anthropic-ai/sandbox-runtime`); XSS protection via the `xss` package.

### Known gaps / historical notes
- The open build disables several internal-only features by flag
  (`BRIDGE_MODE` among them) — expect a large chunk of any raw
  project-wide `tsc` error count to originate there; that's expected, not a
  regression, for the open-source build.
- `remoteAgentService.ts`'s streaming function must be declared
  `async function*` (not `async function` returning `AsyncGenerator`) — this
  was a real build-blocking bug fixed early in the project's history; worth
  knowing if a similar streaming helper is added elsewhere.

---

## 5. Project Structure

```
openclaude-main/
├── src/                      # ~1,976 TypeScript files
│   ├── entrypoints/          # CLI entry (cli.tsx), sdk/ exports
│   ├── services/              # api/, mcp/, auth/oauth/, compact/, remoteAgentService.ts, ...
│   ├── tools/                 # 40+ tools: AgentTool, BashTool, WebBrowserTool, FileEditTool, ...
│   ├── commands/               # 20+ slash-command implementations
│   ├── components/, ink/, screens/, hooks/  # React-Ink terminal UI
│   ├── utils/                 # ~590 files — permissions/, sandbox/, mcp/, settings/, swarm/, plugins/, git/, ...
│   ├── tasks/, tools.ts, commands.ts, Tool.ts, Task.ts, QueryEngine.ts, query.ts, context.ts
│   ├── bridge/, remote/, server/    # remote/mobile companion session + permission bridging (BRIDGE_MODE, off in open build)
│   ├── constants/, types/, schemas/, config/
│   └── main.tsx                # ~4,667 lines, main application logic
├── python-bridge/              # FastAPI local-model server (document QA, image captioning)
├── vscode-extension/openclaude-vscode/   # separate VS Code extension (own package.json, own tests)
├── scripts/                    # build.ts, provider-{bootstrap,discovery,launch,recommend}.ts, system-check.ts
├── bin/                        # openclaude executable shim, import-specifier tooling
├── dist/                       # build output — cli.mjs (~19MB) + source map (gitignored)
├── .claude/                    # agents, contracts, hooks (this scaffold), launch.json
├── .agent-team/                 # provider-agnostic headless orchestrator (this scaffold)
└── package.json, tsconfig.json
```

### TypeScript config
Target ES2023, strict mode, `noUncheckedIndexedAccess` enabled, module
resolution `bundler`, `lib`: ES2023 + DOM + DOM.Iterable.

### Dev server configs (`.claude/launch.json`)
`dev`, `dev:profile`, `dev:openai`, `dev:gemini`, `dev:ollama`, `dev:codex`,
`dev:atomic-chat`.

---

## 6. Development Workflow

### Prerequisites
Node 20+, Bun 1.3.11+, Git, ripgrep (`rg`), a code editor.

### Setup
```bash
git clone <repo-url> && cd openclaude
bun install
bun run doctor:runtime      # verify environment
```

### Build & test
```bash
bun run build           # full build
bun run typecheck        # tsc --noEmit only
bun run smoke             # quick build + version check
bun test src/utils/providerRecommendation.test.ts src/utils/providerProfile.test.ts
bun test src/services/api/*.test.ts src/utils/context.test.ts
bun test path/to/specific.test.ts    # any single test file
```
There is no single `bun test` "run everything" script wired in
`package.json` — test coverage is intentionally scoped per area (~53
`*.test.ts` files total as of this writing); run the relevant scoped
command for the area you changed, e.g. `test:provider` or
`test:provider-recommendation`.

### Adding to each layer
- **New provider:** router in `src/services/` → register in provider
  discovery → add `.env.example` template → document here (§3).
- **New tool:** `src/tools/NewTool/NewTool.ts` implementing `Tool` → register
  in `src/tools.ts` → reference from `src/commands.ts` if user-invocable →
  smoke-test with `bun run dev`.
- **New command:** `src/commands/newcommand.ts` → register in
  `src/commands.ts` → add help text → smoke-test with `bun run dev`.

### Code style
- Files: `camelCase.ts` or `PascalCase/Index.ts`. Classes: `PascalCase`.
  Functions: `camelCase`. Constants: `UPPER_SNAKE_CASE` or `camelCase`
  depending on scope.
- Explicit types over `any`; async/await over callbacks/`.then()` chains.
- Import order: imports → types/interfaces → constants → main
  export → helpers.

### Git workflow
Before committing: `bun run typecheck && bun run build && bun run smoke`.
Commit format: `type(scope): subject` (Conventional-Commits-shaped), body,
optional footer (`Fixes: #123`).

### Debugging & profiling
```bash
DEBUG=1 bun run dev                      # verbose logging
node --prof dist/cli.mjs                 # CPU profile
node --prof-process isolate-*.log > profile.txt
node --max-old-space-size=4096 dist/cli.mjs   # memory ceiling override
```

---

## 7. Local Agent Playbook (Ollama day-to-day)

For running OpenClaude against a local Ollama model as a daily driver.

```powershell
# fast path once a profile exists
bun run dev:profile

# quick presets
bun run dev:fast     # low-latency preset
bun run dev:code     # coding-quality preset

# one-time profile setup
bun run profile:init -- --provider ollama --model llama3.1:8b
# or goal-based auto-pick:
bun run profile:init -- --provider ollama --goal coding
```

**Recommended local models:** `llama3.1:8b` (fast/general),
`qwen2.5-coder:7b`/`qwen2.5-coder:14b` (coding quality, hardware
permitting). Presets already wired: `bun run profile:fast` →
`llama3.2:3b`, `bun run profile:code` → `qwen2.5-coder:7b`.

**Safe working rules:** run `doctor:runtime` before debugging provider
issues; prefer `dev:profile` over manual env edits; keep
`.openclaude-profile.json` local (already gitignored); run `doctor:report`
before asking for help so there's a reproducible snapshot.

**Troubleshooting matrix (Ollama-specific):**
| Symptom | Cause | Fix |
|---|---|---|
| `Script not found "dev"` | Wrong working directory | `cd` into the repo root |
| `ollama: term not recognized` | Ollama not installed / not on PATH | Install from ollama.com, open a new terminal |
| `Provider reachability failed` for localhost | Ollama service not running | `ollama serve`, then re-run `doctor:runtime` |
| `Missing key for non-local provider URL` | `OPENAI_BASE_URL` points remote without a key | Re-init an Ollama profile, or supply the key |
| Placeholder key error | A placeholder string was left in `.env`/profile | Use a real key (cloud) or switch to Ollama (none needed) |

**Quick recovery, in order:** `bun run doctor:runtime` → `bun run
doctor:report` → `bun run smoke`. If responses are slow, check `ollama ps` —
`PROCESSOR: CPU` means it's working correctly but will be slower than GPU.

**Prompt patterns that work well** (copy/paste starting points):
- *Code understanding:* "Map this repository architecture and explain the
  execution flow from entrypoint to tool invocation."
- *Refactoring:* "Refactor this module for clarity without behavior change,
  then run checks and summarize diff impact."
- *Debugging:* "Reproduce the failure, identify root cause, implement fix,
  and validate with commands."
- *Reliability:* "Add runtime guardrails and fail-fast messages for invalid
  provider env vars."
- *Review:* "Do a code review of unstaged changes, prioritize
  bugs/regressions, and suggest concrete patches."

---

## 8. Troubleshooting

### Build fails
1. Confirm Bun ≥1.3.11: `bun --version` (`bun upgrade` if older).
2. Clear and reinstall: `rm -rf node_modules dist && bun install`.
3. `bun run typecheck` to isolate type errors from bundler errors.

### "Could not resolve: module.js"
TypeScript source imports should omit the `.js` extension
(`import { foo } from '../utils/foo'`, not `'../utils/foo.js'`); verify the
target file actually exists at the resolved relative path.

### Provider connection failed / invalid API key
1. Confirm the key is actually set in the current shell (`echo
   $OPENAI_API_KEY` / `echo %OPENAI_API_KEY%` / `$env:OPENAI_API_KEY`) and
   in `.env`.
2. Check for wrapping quotes or trailing whitespace in the value.
3. Confirm the key's prefix matches the provider (OpenAI/DeepSeek: `sk-`,
   Groq: `gsk_`) and hasn't expired; regenerate if unsure.
4. For local providers, confirm the service is actually listening:
   `curl http://localhost:11434/api/tags` (Ollama), `curl -I
   http://localhost:1234/v1/models` (LM Studio).

### ripgrep not found
Install via the platform's package manager (`brew install ripgrep`, `scoop
install ripgrep`, `choco install ripgrep`, `sudo apt install ripgrep`,
`sudo dnf install ripgrep`) and confirm with `rg --version`.

### Large `tsc` error counts
Most such errors surface from code paths that are properly stubbed for the
open build (`BRIDGE_MODE` and other internal-only feature flags) — expected
for this build, not necessarily a regression. Narrow down with `bun run
typecheck` output before assuming a real defect.

### API key exposure
1. Revoke the compromised key immediately at the provider's dashboard.
2. Confirm `.gitignore` covers `.env`/`.env.*` (it does in this repo — see
   §9 below for the specific history here).
3. If a key was ever actually committed: `git rm --cached .env && git
   commit`, then treat the key as burned regardless of the removal (git
   history retains it until rewritten).
4. Keep `.env.example` committed as the structural template — no real
   values in it.

---

## 9. Historical: three-project backend integration (Phase 2, paused)

This section is kept for background only — it describes work-in-progress
integration with a **separate, external project** (`mcp-openclaude`, a
Node.js backend on `localhost:3001` fronting a .NET/C# agent runtime), not
something present in this repository. Treat it as historical status, not a
live feature to build against.

**What was built in this repo as part of that effort:**
- `src/services/remoteAgentService.ts` — `invokeRemoteAgent()` async
  generator, POSTs to `http://localhost:3001/chat`, reads an SSE stream
  (`data: {...}\n\n` chunks), yields text as it arrives.
- `src/config/integrationConfig.ts` — loads `~/.openclaude-integration.json`
  (falls back to sane local defaults if absent); `.openclaude-integration.example.json`
  is the committed template.
- `src/services/agentExecutionService.ts` — `executeAgent()`, meant to route
  a given agent invocation to either a built-in (local) implementation or
  the remote backend based on `integrationConfig`, with per-agent overrides:
  ```json
  {
    "integrationMode": "remote",
    "remoteBackendUrl": "http://localhost:3001",
    "useBuiltInAgents": true,
    "useRemoteAgents": true,
    "agents": { "CodeReviewer": "remote", "General": "built-in" }
  }
  ```

**State it was left in:** the streaming service, config loader, and routing
service all existed and type-checked, but `executeAgent()` was never wired
into the actual agent-execution UI path (`src/components/agents/` at the
time) — so remote routing was implemented but not load-bearing. If picking
this back up, that wiring step plus end-to-end testing against a running
`mcp-openclaude` backend is where it left off. No test coverage existed for
this path.

**Security items that were flagged and deferred at the time** (apply to the
external `mcp-openclaude` backend, not to this repo, except where noted):
add request validation, fix a path-traversal vulnerability in that backend,
enable HTTPS, add authentication/rate limiting on `POST /chat`.

---

## 10. Known issues / security notes specific to this repo

- **A real API key was previously committed to local `.env` history and
  flagged, unresolved, in earlier project notes** (an NVIDIA `nvapi-...`
  key for `integrate.api.nvidia.com`). `.env` is excluded via `.gitignore`
  (`.env`, `.env.*`, with `.env.example` explicitly un-ignored), so it is
  **not** part of this git history or this public repo — but the key
  itself should still be treated as burned: rotate it at
  https://build.nvidia.com/models if it hasn't been already.
- `.mcp.json` (MCP server config) is tracked and **not** gitignored — it
  currently only contains local tool paths/config, no credentials, but
  don't add inline API keys/tokens to it without adding it to
  `.gitignore` first.
- Never commit `.env`; use `.env.example` for documenting new variables
  with placeholder values only.
