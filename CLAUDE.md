# openclaude-main

This is the user's sandbox for local-model / offline-AI experimentation —
routing a local Ollama model through tool-calling to specialist local
models. **Read [LOCAL_AI_STATUS.md](LOCAL_AI_STATUS.md) before doing
anything in this project** — it has the current architecture, what's
verified working, known bugs already fixed (don't reintroduce them), and
open next steps.

One hard rule: the sibling project `openclaude` (no "-main" suffix) is the
user's normal daily driver for cloud providers — never modify it for
anything related to this local-AI work.

Any change to `src/` requires `bun run build` before it's visible when
running `node bin/openclaude` — `bin/openclaude` runs the compiled
`dist/cli.mjs`, never live source.

## Agent System — Orchestration Rules

See AGENTS.md for the full agent-system orchestration rules (routing table,
dispatch patterns, contracts, handoff protocol, security gate). This file
does not duplicate that content — AGENTS.md is the single source of truth,
read natively by this and every other supported tool.
