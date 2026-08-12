# local-logic

A fork of [OpenClaude](https://github.com/gitlawb/openclaude) turned into an
offline multi-model agent: a small local router model (Ollama) delegates
narrow tasks — math, document QA, image captioning, tabular
prediction/forecasting — to purpose-built local specialist models via
tool-calling, instead of one generalist model doing everything.

The working goal is a **Logic Engine**: on *verifiable* logical domains
(math, code, symbolic puzzles — anything a checker can score), compose
small local models generate→verify→search style to reach parity with, or
beat, frontier models, fully offline and at near-zero marginal cost.
Open-ended general reasoning with no verifier is explicitly out of scope.
Full rationale and evidence base in
[LOCAL_AI_MASTER_PLAN.md §11](LOCAL_AI_MASTER_PLAN.md).

**Start here:** [LOCAL_AI_STATUS.md](LOCAL_AI_STATUS.md) is the living
handoff doc — current architecture, what's verified working, bugs already
fixed (don't reintroduce them), open next steps.
[LOCAL_AI_MASTER_PLAN.md](LOCAL_AI_MASTER_PLAN.md) is the longer-range
roadmap (model inventory, capability tiers, memory budget, phased plan).

---

## Architecture

| Role | Model | Invoked via |
| --- | --- | --- |
| Router | `qwen3-router:1.7b` (custom Ollama tag, 40960 ctx) | Main driver model, `.openclaude-profile.json` |
| Math | VibeThinker-3B | `AskMathModel` tool (`src/tools/AskMathModelTool/`) |
| Extractive QA | DistilBERT (`distilbert-base-cased-distilled-squad`) | `DocumentQA` tool → Python bridge |
| Image captioning | BLIP (`blip-image-captioning-large`) | `ImageCaption` tool → Python bridge |
| Tabular predict / table QA / forecast | TabPFN-v2, TAPAS, Chronos-t5-tiny | `DataAnalyze` tool → Python bridge |
| Memory retrieval | all-minilm embeddings + Qwen3-Reranker-0.6B | Two-stage pre-filter in `src/memdir/findRelevantMemories.ts` |

Specialists are never asked to route, and the router never specializes —
small reasoning-tuned models hallucinate tool-call formats when asked to
both. The Python bridge (`python-bridge/`, FastAPI, dedicated CUDA venv)
runs BLIP/DistilBERT on GPU (`device="cuda", fp16=True`) and the small
tabular/forecast models on CPU. See LOCAL_AI_STATUS.md for exact wiring,
and the hard boundary below before changing anything.

## Current status

- **Routing eval** (`bun run eval:routing`, `scripts/eval/routingEval.ts`):
  **14/20 (70%)** — up from a 35% baseline after root-causing a silent
  zero-output-token completion bug (Ollama context truncation). Remaining
  failures are wrong-tool hallucinations and over-delegation on trivial
  arithmetic, tracked as the router's tool menu grows.
- **Specialist eval** (`bun run eval:specialists`): math, DocumentQA
  (including a correctly-low-confidence unanswerable case), and
  image-caption cases passing live against real models.
- **DataAnalyze eval** (`bun run eval:data-analyze`): TabPFN 3/4
  (classification solid, regression weak only at extrapolation), TAPAS 6/8
  (solid on direct lookups, unreliable on cross-column/aggregation),
  Chronos 1/3 (uncertainty bounds solid, point forecast underforecasts
  clear trends).
- **Next priority**: semantic tool pre-filtering — the router's remaining
  failures track tool-menu size, per `LOCAL_AI_MASTER_PLAN.md` §6.

Full session-by-session detail, verification evidence, and known bugs
already fixed live in [LOCAL_AI_STATUS.md](LOCAL_AI_STATUS.md).

## Hard boundary

The sibling project `openclaude` (no `-main`/`-local` suffix) is a
separate, unrelated daily-driver checkout for cloud providers. **Never
modify it for anything related to this local-AI work** — this repo is
where all of it belongs.

---

## Quick Start

### Install

```bash
npm install -g @gitlawb/openclaude
```

If the npm install path later reports `ripgrep not found`, install ripgrep
system-wide and confirm `rg --version` works in the same terminal before
starting.

### Run against the local router (primary path for this fork)

Requires [Ollama](https://ollama.com) running locally and the router model
pulled/built per LOCAL_AI_STATUS.md (`qwen3-router:1.7b`, a custom tag —
plain `qwen3:1.7b` will silently truncate the prompt, see the status doc's
Session 5 writeup). The Python bridge (`python-bridge/start.ps1`) must also
be running for DocumentQA/ImageCaption/DataAnalyze.

```bash
openclaude
```

`.openclaude-profile.json` in this repo already points the `ollama`
profile at `qwen3-router:1.7b` and scopes non-local-AI MCP servers out of
that profile.

### Also supported: cloud/OpenAI-compatible providers

This fork inherits OpenClaude's full multi-provider engine (OpenAI-compatible
APIs, Gemini, GitHub Models, Codex, Bedrock/Vertex/Foundry). Run `/provider`
inside the app for guided setup, or see
[.claude/contracts/project-docs.md](.claude/contracts/project-docs.md) for
full installation, provider configuration, and troubleshooting docs.

---

## Source Build

**Any change to `src/` requires a rebuild before it's visible** —
`bin/openclaude` runs the compiled `dist/cli.mjs`, never live `src/`.

```bash
bun install
bun run build
node dist/cli.mjs
```

Helpful commands:

- `bun run dev` — build + run in one step
- `bun run smoke` — build + `--version` sanity check
- `bun run doctor:runtime` — environment/dependency check
- `bun run eval:routing` / `eval:specialists` / `eval:data-analyze` — local-AI eval harnesses

## VS Code Extension

The repo includes a VS Code extension in
[`vscode-extension/openclaude-vscode`](vscode-extension/openclaude-vscode)
for launch integration and theme support (inherited from upstream
OpenClaude, not specific to the local-AI work).

## Security

If you believe you found a security issue, see [SECURITY.md](SECURITY.md).

## Contributing

For larger changes, open an issue first so the scope is clear before
implementation. Helpful validation commands:

- `bun run build`
- `bun run smoke`
- focused `bun test ...` runs for touched areas

See [AGENTS.md](AGENTS.md) for the sub-agent orchestration rules used in
this repo.

## Disclaimer

This is an independent, unaffiliated fork of OpenClaude and is not
affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and
"Claude Code" are trademarks of Anthropic.

## License

MIT
