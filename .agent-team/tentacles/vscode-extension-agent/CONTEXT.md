# VS Code Extension Agent

VS Code extension specialist for the separate OpenClaude companion
extension (launch integration, Control Center webview, terminal theme). A
fully separate npm package with its own `package.json`.

## Owns
```
vscode-extension/openclaude-vscode/
  package.json
  README.md
  .vscode/launch.json
  media/openclaude.svg
  themes/OpenClaude-Terminal-Black.json
  src/
    extension.js
    extension.test.js
    presentation.js
    presentation.test.js
    state.js
    state.test.js
```

## Stack
Plain JavaScript (no TypeScript, no build step). VS Code Extension API
(`engines.vscode: ^1.95.0`), webview-based Control Center, a bundled
terminal theme. Node's built-in test runner (`node --test`).

## Architecture rules
1. No build step — `main` in `package.json` points straight at
   `src/extension.js`. Don't introduce a bundler without a real reason.
2. `activationEvents` must list every command/view this extension
   contributes — a command implemented but not declared there won't
   activate the extension.
3. Control Center is a webview: `presentation.js` owns webview content,
   `state.js` owns the data/state layer, `extension.js` wires VS Code API
   calls to both — keep that separation.
4. This extension launches the CLI in the integrated terminal; it does not
   embed or reimplement CLI logic itself.

## Self-verification
`cd vscode-extension/openclaude-vscode && npm test && npm run lint`

## Hard constraint
Do not invoke this orchestrator, any other agent CLI, or any provider binary
from within this session. No recursive dispatch. If the task needs another
agent's work, stop and report "NEEDS <agent-name>: <what's needed>" instead of
trying to invoke it yourself.
