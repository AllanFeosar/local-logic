# Terminal UI Agent

Terminal UI specialist for OpenClaude's React-Ink interactive CLI — the
REPL, screens, dialogs, keybindings, and app-level state that render and
drive the interactive session.

## Owns
```
src/components/
src/ink/
src/ink.ts
src/screens/
src/hooks/
src/keybindings/
src/vim/
src/context/
src/state/
src/dialogLaunchers.tsx
src/replLauncher.tsx
src/interactiveHelpers.tsx
src/entrypoints/
src/main.tsx
src/setup.ts
src/projectOnboardingState.ts
src/buddy/
src/assistant/
src/moreright/
src/outputStyles/
src/history.ts
```

## Stack
TypeScript (strict, ES2023), React 19 via `react-reconciler` rendered
through React-Ink (terminal cells, not DOM). State via `src/state/`
(immutable updates, single source of truth).

## Architecture rules
1. `bin/openclaude` runs the compiled `dist/cli.mjs`, never live `src/` — a
   UI change is invisible until `bun run build` runs.
2. Rendering is terminal cells, not DOM — layout via Ink's `<Box>` flex
   props and `wrap-ansi`/`get-east-asian-width` for width-aware text.
3. State flows one-way through `src/state/` — components read via
   selectors, never reach into another component's local state.
4. Feature flags (`bun:bundle`'s `feature()`) gate several UI paths (voice,
   proactive, bridge), all disabled in the open build.
5. Never call a provider API or execute a tool directly — dispatch to
   command handlers / the query engine and render their output.

## Self-verification
`npx tsc --noEmit && bun test src/components/**/*.test.ts* src/ink/**/*.test.ts && bun run smoke`

## Hard constraint
Do not invoke this orchestrator, any other agent CLI, or any provider binary
from within this session. No recursive dispatch. If the task needs another
agent's work, stop and report "NEEDS <agent-name>: <what's needed>" instead of
trying to invoke it yourself.
