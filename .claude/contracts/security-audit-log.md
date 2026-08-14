# Security Audit Log

> Append-only. `security-audit-agent` adds one entry per audit, **before**
> the commit that contains the audited files — the `security-gate` hook
> requires this file to be staged in the same commit and to name every
> staged security-sensitive file, so an entry only counts if it's tied to
> the exact diff being committed. Never edit or remove a past entry;
> corrections get a new entry.

## Format
```
## <date> — <one-line feature/change description>
Files audited: <path1>, <path2>, ...
Verdict: <X Critical, X High, X Medium, X Low>
Recommendation: <ship / fix before ship / blocked>
Findings: <link to the handoff report in .claude/contracts/handoffs/, or "none">
```

---
<!-- newest entries at the bottom -->

## 2026-08-11 — Baseline-import audit of the pre-existing codebase (initial commit, not new-work review)
Files audited: src/bridge/bridgeApi.ts, src/bridge/bridgeConfig.ts, src/bridge/bridgeDebug.ts, src/bridge/bridgeEnabled.ts, src/bridge/bridgeMain.ts, src/bridge/bridgeMessaging.ts, src/bridge/bridgePermissionCallbacks.ts, src/bridge/bridgePointer.ts, src/bridge/bridgeStatusUtil.ts, src/bridge/bridgeUI.ts, src/bridge/capacityWake.ts, src/bridge/codeSessionApi.ts, src/bridge/createSession.ts, src/bridge/debugUtils.ts, src/bridge/envLessBridgeConfig.ts, src/bridge/flushGate.ts, src/bridge/inboundAttachments.ts, src/bridge/inboundMessages.ts, src/bridge/initReplBridge.ts, src/bridge/jwtUtils.ts, src/bridge/pollConfig.ts, src/bridge/pollConfigDefaults.ts, src/bridge/remoteBridgeCore.ts, src/bridge/replBridge.ts, src/bridge/replBridgeHandle.ts, src/bridge/replBridgeTransport.ts, src/bridge/sessionIdCompat.ts, src/bridge/sessionRunner.test.ts, src/bridge/sessionRunner.ts, src/bridge/trustedDevice.ts, src/bridge/types.ts, src/bridge/workSecret.test.ts, src/bridge/workSecret.ts, src/remote/RemoteSessionManager.ts, src/remote/SessionsWebSocket.ts, src/remote/remotePermissionBridge.ts, src/remote/sdkMessageAdapter.ts, src/services/mcp/auth.ts, src/services/oauth/auth-code-listener.ts, src/services/oauth/client.ts, src/services/oauth/crypto.test.ts, src/services/oauth/crypto.ts, src/services/oauth/getOauthProfile.ts, src/services/oauth/index.ts, src/tools/AgentTool/AgentTool.tsx, src/tools/AgentTool/UI.tsx, src/tools/AgentTool/agentColorManager.ts, src/tools/AgentTool/agentDisplay.ts, src/tools/AgentTool/agentExecution.test.ts, src/tools/AgentTool/agentExecution.ts, src/tools/AgentTool/agentMemory.ts, src/tools/AgentTool/agentMemorySnapshot.ts, src/tools/AgentTool/agentToolUtils.ts, src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts, src/tools/AgentTool/built-in/exploreAgent.ts, src/tools/AgentTool/built-in/generalPurposeAgent.ts, src/tools/AgentTool/built-in/planAgent.ts, src/tools/AgentTool/built-in/statuslineSetup.ts, src/tools/AgentTool/built-in/verificationAgent.ts, src/tools/AgentTool/builtInAgents.ts, src/tools/AgentTool/constants.ts, src/tools/AgentTool/forkSubagent.ts, src/tools/AgentTool/loadAgentsDir.ts, src/tools/AgentTool/prompt.ts, src/tools/AgentTool/resumeAgent.ts, src/tools/AgentTool/runAgent.ts, src/tools/AskMathModelTool/AskMathModelTool.live.test.ts, src/tools/AskMathModelTool/AskMathModelTool.test.ts, src/tools/AskMathModelTool/AskMathModelTool.ts, src/tools/AskMathModelTool/constants.ts, src/tools/AskMathModelTool/prompt.ts, src/tools/AskMathModelTool/thinkTrace.test.ts, src/tools/AskMathModelTool/thinkTrace.ts, src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx, src/tools/AskUserQuestionTool/prompt.ts, src/tools/BashTool/BashTool.tsx, src/tools/BashTool/BashToolResultMessage.tsx, src/tools/BashTool/UI.tsx, src/tools/BashTool/bashCommandHelpers.ts, src/tools/BashTool/bashPermissions.ts, src/tools/BashTool/bashSecurity.ts, src/tools/BashTool/commandSemantics.ts, src/tools/BashTool/commentLabel.ts, src/tools/BashTool/destructiveCommandWarning.ts, src/tools/BashTool/modeValidation.ts, src/tools/BashTool/pathValidation.ts, src/tools/BashTool/prompt.ts, src/tools/BashTool/readOnlyValidation.ts, src/tools/BashTool/sedEditParser.test.ts, src/tools/BashTool/sedEditParser.ts, src/tools/BashTool/sedValidation.ts, src/tools/BashTool/shouldUseSandbox.ts, src/tools/BashTool/toolName.ts, src/tools/BashTool/utils.ts, src/tools/BriefTool/BriefTool.ts, src/tools/BriefTool/UI.tsx, src/tools/BriefTool/attachments.ts, src/tools/BriefTool/prompt.ts, src/tools/BriefTool/upload.ts, src/tools/ConfigTool/ConfigTool.ts, src/tools/ConfigTool/UI.tsx, src/tools/ConfigTool/constants.ts, src/tools/ConfigTool/prompt.ts, src/tools/ConfigTool/supportedSettings.ts, src/tools/DocumentQATool/DocumentQATool.live.test.ts, src/tools/DocumentQATool/DocumentQATool.test.ts, src/tools/DocumentQATool/DocumentQATool.ts, src/tools/EnterPlanModeTool/EnterPlanModeTool.ts, src/tools/EnterPlanModeTool/UI.tsx, src/tools/EnterPlanModeTool/constants.ts, src/tools/EnterPlanModeTool/prompt.ts, src/tools/EnterWorktreeTool/EnterWorktreeTool.ts, src/tools/EnterWorktreeTool/UI.tsx, src/tools/EnterWorktreeTool/constants.ts, src/tools/EnterWorktreeTool/prompt.ts, src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts, src/tools/ExitPlanModeTool/UI.tsx, src/tools/ExitPlanModeTool/constants.ts, src/tools/ExitPlanModeTool/prompt.ts, src/tools/ExitWorktreeTool/ExitWorktreeTool.ts, src/tools/ExitWorktreeTool/UI.tsx, src/tools/ExitWorktreeTool/constants.ts, src/tools/ExitWorktreeTool/prompt.ts, src/tools/FileEditTool/FileEditTool.ts, src/tools/FileEditTool/UI.tsx, src/tools/FileEditTool/constants.ts, src/tools/FileEditTool/prompt.ts, src/tools/FileEditTool/types.ts, src/tools/FileEditTool/utils.ts, src/tools/FileReadTool/FileReadTool.ts, src/tools/FileReadTool/UI.tsx, src/tools/FileReadTool/imageProcessor.ts, src/tools/FileReadTool/limits.ts, src/tools/FileReadTool/prompt.ts, src/tools/FileWriteTool/FileWriteTool.ts, src/tools/FileWriteTool/UI.tsx, src/tools/FileWriteTool/prompt.ts, src/tools/GlobTool/GlobTool.ts, src/tools/GlobTool/UI.tsx, src/tools/GlobTool/prompt.ts, src/tools/GrepTool/GrepTool.ts, src/tools/GrepTool/UI.tsx, src/tools/GrepTool/prompt.ts, src/tools/ImageCaptionTool/ImageCaptionTool.live.test.ts, src/tools/ImageCaptionTool/ImageCaptionTool.test.ts, src/tools/ImageCaptionTool/ImageCaptionTool.ts, src/tools/LSPTool/LSPTool.ts, src/tools/LSPTool/UI.tsx, src/tools/LSPTool/formatters.ts, src/tools/LSPTool/prompt.ts, src/tools/LSPTool/schemas.ts, src/tools/LSPTool/symbolContext.ts, src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts, src/tools/ListMcpResourcesTool/UI.tsx, src/tools/ListMcpResourcesTool/prompt.ts, src/tools/MCPTool/MCPTool.ts, src/tools/MCPTool/UI.tsx, src/tools/MCPTool/classifyForCollapse.ts, src/tools/MCPTool/prompt.ts, src/tools/McpAuthTool/McpAuthTool.ts, src/tools/NotebookEditTool/NotebookEditTool.ts, src/tools/NotebookEditTool/UI.tsx, src/tools/NotebookEditTool/constants.ts, src/tools/NotebookEditTool/prompt.ts, src/tools/PowerShellTool/PowerShellTool.tsx, src/tools/PowerShellTool/UI.tsx, src/tools/PowerShellTool/clmTypes.ts, src/tools/PowerShellTool/commandSemantics.ts, src/tools/PowerShellTool/commonParameters.ts, src/tools/PowerShellTool/destructiveCommandWarning.ts, src/tools/PowerShellTool/gitSafety.ts, src/tools/PowerShellTool/modeValidation.ts, src/tools/PowerShellTool/pathValidation.ts, src/tools/PowerShellTool/powershellPermissions.ts, src/tools/PowerShellTool/powershellSecurity.ts, src/tools/PowerShellTool/prompt.ts, src/tools/PowerShellTool/readOnlyValidation.ts, src/tools/PowerShellTool/toolName.ts, src/tools/REPLTool/REPLTool.ts, src/tools/REPLTool/constants.ts, src/tools/REPLTool/primitiveTools.ts, src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts, src/tools/ReadMcpResourceTool/UI.tsx, src/tools/ReadMcpResourceTool/prompt.ts, src/tools/RemoteTriggerTool/RemoteTriggerTool.ts, src/tools/RemoteTriggerTool/UI.tsx, src/tools/RemoteTriggerTool/prompt.ts, src/tools/ScheduleCronTool/CronCreateTool.ts, src/tools/ScheduleCronTool/CronDeleteTool.ts, src/tools/ScheduleCronTool/CronListTool.ts, src/tools/ScheduleCronTool/UI.tsx, src/tools/ScheduleCronTool/prompt.ts, src/tools/SendMessageTool/SendMessageTool.ts, src/tools/SendMessageTool/UI.tsx, src/tools/SendMessageTool/constants.ts, src/tools/SendMessageTool/prompt.ts, src/tools/SkillTool/SkillTool.ts, src/tools/SkillTool/UI.tsx, src/tools/SkillTool/constants.ts, src/tools/SkillTool/prompt.ts, src/tools/SleepTool/prompt.ts, src/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.ts, src/tools/SyntheticOutputTool/SyntheticOutputTool.ts, src/tools/TaskCreateTool/TaskCreateTool.ts, src/tools/TaskCreateTool/constants.ts, src/tools/TaskCreateTool/prompt.ts, src/tools/TaskGetTool/TaskGetTool.ts, src/tools/TaskGetTool/constants.ts, src/tools/TaskGetTool/prompt.ts, src/tools/TaskListTool/TaskListTool.ts, src/tools/TaskListTool/constants.ts, src/tools/TaskListTool/prompt.ts, src/tools/TaskOutputTool/TaskOutputTool.tsx, src/tools/TaskOutputTool/constants.ts, src/tools/TaskStopTool/TaskStopTool.ts, src/tools/TaskStopTool/UI.tsx, src/tools/TaskStopTool/prompt.ts, src/tools/TaskUpdateTool/TaskUpdateTool.ts, src/tools/TaskUpdateTool/constants.ts, src/tools/TaskUpdateTool/prompt.ts, src/tools/TeamCreateTool/TeamCreateTool.ts, src/tools/TeamCreateTool/UI.tsx, src/tools/TeamCreateTool/constants.ts, src/tools/TeamCreateTool/prompt.ts, src/tools/TeamDeleteTool/TeamDeleteTool.ts, src/tools/TeamDeleteTool/UI.tsx, src/tools/TeamDeleteTool/constants.ts, src/tools/TeamDeleteTool/prompt.ts, src/tools/TodoWriteTool/TodoWriteTool.ts, src/tools/TodoWriteTool/constants.ts, src/tools/TodoWriteTool/prompt.ts, src/tools/ToolSearchTool/ToolSearchTool.ts, src/tools/ToolSearchTool/constants.ts, src/tools/ToolSearchTool/prompt.ts, src/tools/TungstenTool/TungstenLiveMonitor.ts, src/tools/TungstenTool/TungstenTool.ts, src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts, src/tools/WebFetchTool/UI.tsx, src/tools/WebFetchTool/WebFetchTool.ts, src/tools/WebFetchTool/preapproved.ts, src/tools/WebFetchTool/prompt.ts, src/tools/WebFetchTool/utils.ts, src/tools/WebSearchTool/UI.tsx, src/tools/WebSearchTool/WebSearchTool.ts, src/tools/WebSearchTool/prompt.ts, src/tools/WorkflowTool/constants.ts, src/tools/shared/gitOperationTracking.ts, src/tools/shared/localModelBridge.ts, src/tools/shared/spawnMultiAgent.ts, src/tools/shellToolResultMappers.test.ts, src/tools/testing/TestingPermissionTool.tsx, src/tools/utils.ts, src/utils/bash/ParsedCommand.ts, src/utils/bash/ShellSnapshot.ts, src/utils/bash/ast.ts, src/utils/bash/bashParser.ts, src/utils/bash/bashPipeCommand.ts, src/utils/bash/commands.ts, src/utils/bash/heredoc.ts, src/utils/bash/parser.ts, src/utils/bash/prefix.ts, src/utils/bash/registry.ts, src/utils/bash/shellCompletion.ts, src/utils/bash/shellPrefix.ts, src/utils/bash/shellQuote.ts, src/utils/bash/shellQuoting.ts, src/utils/bash/specs/alias.ts, src/utils/bash/specs/index.ts, src/utils/bash/specs/nohup.ts, src/utils/bash/specs/pyright.ts, src/utils/bash/specs/sleep.ts, src/utils/bash/specs/srun.ts, src/utils/bash/specs/time.ts, src/utils/bash/specs/timeout.ts, src/utils/bash/treeSitterAnalysis.ts, src/utils/claudeInChrome/chromeNativeHost.ts, src/utils/claudeInChrome/common.ts, src/utils/claudeInChrome/mcpServer.ts, src/utils/claudeInChrome/prompt.ts, src/utils/claudeInChrome/setup.ts, src/utils/claudeInChrome/setupPortable.ts, src/utils/claudeInChrome/toolRendering.tsx, src/utils/computerUse/appNames.ts, src/utils/computerUse/cleanup.ts, src/utils/computerUse/common.ts, src/utils/computerUse/computerUseLock.ts, src/utils/computerUse/drainRunLoop.ts, src/utils/computerUse/escHotkey.ts, src/utils/computerUse/executor.ts, src/utils/computerUse/gates.ts, src/utils/computerUse/hostAdapter.ts, src/utils/computerUse/inputLoader.ts, src/utils/computerUse/mcpServer.ts, src/utils/computerUse/setup.ts, src/utils/computerUse/swiftLoader.ts, src/utils/computerUse/toolRendering.tsx, src/utils/computerUse/wrapper.tsx, src/utils/permissions/PermissionMode.ts, src/utils/permissions/PermissionPromptToolResultSchema.ts, src/utils/permissions/PermissionResult.ts, src/utils/permissions/PermissionRule.ts, src/utils/permissions/PermissionUpdate.ts, src/utils/permissions/PermissionUpdateSchema.ts, src/utils/permissions/autoModeState.ts, src/utils/permissions/bashClassifier.ts, src/utils/permissions/bypassPermissionsKillswitch.ts, src/utils/permissions/classifierDecision.ts, src/utils/permissions/classifierShared.ts, src/utils/permissions/dangerousPatterns.ts, src/utils/permissions/denialTracking.ts, src/utils/permissions/filesystem.ts, src/utils/permissions/getNextPermissionMode.ts, src/utils/permissions/pathValidation.ts, src/utils/permissions/permissionExplainer.ts, src/utils/permissions/permissionRuleParser.ts, src/utils/permissions/permissionSetup.ts, src/utils/permissions/permissions.ts, src/utils/permissions/permissionsLoader.ts, src/utils/permissions/shadowedRuleDetection.ts, src/utils/permissions/shellRuleMatching.ts, src/utils/permissions/yoloClassifier.ts, src/utils/powershell/dangerousCmdlets.ts, src/utils/powershell/parser.ts, src/utils/powershell/staticPrefix.ts, src/utils/sandbox/sandbox-adapter.ts, src/utils/sandbox/sandbox-ui-utils.ts, src/utils/secureStorage/fallbackStorage.ts, src/utils/secureStorage/index.ts, src/utils/secureStorage/keychainPrefetch.ts, src/utils/secureStorage/macOsKeychainHelpers.ts, src/utils/secureStorage/macOsKeychainStorage.ts, src/utils/secureStorage/plainTextStorage.ts, src/utils/settings/permissionValidation.ts, src/utils/shell/bashProvider.ts, src/utils/shell/outputLimits.ts, src/utils/shell/powershellDetection.ts, src/utils/shell/powershellProvider.ts, src/utils/shell/prefix.ts, src/utils/shell/readOnlyCommandValidation.ts, src/utils/shell/resolveDefaultShell.ts, src/utils/shell/shellProvider.ts, src/utils/shell/shellToolUtils.ts, src/utils/shell/specPrefix.ts, src/utils/shellConfig.ts, src/utils/teleport.tsx, src/utils/teleport/api.ts, src/utils/teleport/environmentSelection.ts, src/utils/teleport/environments.ts, src/utils/teleport/gitBundle.ts
Verdict: 0 Critical, 0 High, 2 Medium, 2 Low
Recommendation: ship
Findings: none blocking — 4 non-blocking findings recorded inline below (no separate handoff report; all four are pre-existing upstream design, none introduced by the agent-team scaffold in this commit)

Scope note: this entry covers the initial-baseline import of the entire pre-existing
codebase, not review of new work product. Every file named above is audited *as part of
this baseline pass* — i.e. imported under this ledger entry — which is a weaker claim than
"individually deep-reviewed". The deep-dive sample was: the permission pipeline
(src/services/tools/toolExecution.ts, src/utils/permissions/permissions.ts,
permissionSetup.ts, bypassPermissionsKillswitch.ts, filesystem.ts), the six highest-risk
tools (Bash, FileEdit, FileWrite, PowerShell, NotebookEdit, WebFetch), the bridge/remote
permission relay, services/oauth + utils/secureStorage + services/mcp/auth.ts, and
utils/computerUse + utils/claudeInChrome. Files outside that sample were not read
line-by-line. Per-PR audits after this baseline are expected to be exhaustive over their diff.

Invariants verified (pass):
- validateInput -> checkPermissions -> call ordering is enforced in one place
  (src/services/tools/toolExecution.ts:683 validateInput, :921 awaited permission decision,
  :995 non-allow early return, :1207 tool.call). No side effect precedes the awaited
  permission decision on the model-driven path.
- No eval() / new Function() / vm.runIn* anywhere under tools/, utils/permissions/,
  utils/bash, utils/shell, utils/powershell, bridge/, remote/, services/oauth/,
  utils/secureStorage/.
- Only two child_process uses outside the execa/sandbox-runtime pattern
  (src/utils/bash/ShellSnapshot.ts:1 execFile, src/bridge/sessionRunner.ts:386 spawn) —
  both argv-form, no shell:true, no untrusted interpolation.
- No credential logging found in services/oauth/, utils/secureStorage/, or
  services/mcp/auth.ts. OAuth uses PKCE S256 with randomBytes(32) verifier and state
  (src/services/oauth/crypto.ts) and validates state on the loopback callback
  (src/services/oauth/auth-code-listener.ts:164, bound to localhost only). MCP OAuth
  redacts state/code_verifier from debug logs (src/services/mcp/auth.ts:101-110) and
  validates state (:1079, :1110). src/bridge/jwtUtils.ts decodes JWTs without signature
  verification but only to schedule token refresh, never for an authorization decision.
- Direct tool.call() callers that skip validateInput are accounted for:
  src/utils/promptShellExecution.ts:102 runs hasPermissionsToUseTool before call();
  src/utils/processUserInput/processBashCommand.tsx:82 is the user typing a bang-command
  (the user is the permission authority). PowerShellTool.call() re-checks the Windows
  sandbox policy at src/tools/PowerShellTool/PowerShellTool.tsx:448 to cover both callers.
- _simulatedSedEdit (the privileged post-approval input-injection channel) is stripped from
  model-supplied Bash input at src/services/tools/toolExecution.ts:762-773 before it can
  reach src/tools/BashTool/BashTool.tsx:629.
- dangerouslyDisableSandbox does not weaken the prompt path: the sandbox auto-allow at
  src/utils/permissions/permissions.ts:1189-1193 requires shouldUseSandbox(input) to be
  true, and src/tools/BashTool/shouldUseSandbox.ts:136-141 returns false when the flag is
  set, so such commands fall through to a normal prompt.
- Remote/channel permission relay is a race against the local dialog that only starts after
  the local pipeline has already resolved to behavior === ask
  (src/hooks/toolPermission/handlers/interactiveHandler.ts:244, :316) — all deny rules,
  ask rules, safety checks and tool-level checkPermissions have already run identically.
  Remote is therefore not more permissive than local, with the one exception recorded below.

Non-blocking findings (all pre-existing upstream; owner: tools-execution-agent):

- MEDIUM — Blanket permission-prompt bypass for browser / computer-use MCP tools.
  src/utils/claudeInChrome/setup.ts:97 and src/utils/computerUse/setup.ts:27 build an
  allowedTools list containing every mcp__claude-in-chrome__* / mcp__computer-use__* tool.
  src/main.tsx:1542 and :1619 push it into allowedTools, which becomes
  alwaysAllowRules.cliArg at src/utils/permissions/permissionSetup.ts:982 and auto-allows at
  src/utils/permissions/permissions.ts:1284-1297 with no per-call prompt in any permission
  mode. The code self-documents this (see the comment at src/utils/computerUse/setup.ts:14).
  The compensating control (request_access, and the Chrome extension permission UI) lives in
  @ant/computer-use-mcp and @ant/claude-for-chrome-mcp, which are outside this repository
  and therefore cannot be verified by this audit. Both surfaces are feature/platform/
  entitlement gated (CHICAGO_MCP + macOS + GrowthBook for computer-use; --chrome or
  CLAUDE_CODE_ENABLE_CFC plus the subscriber check at src/main.tsx:1525 for Chrome).

- MEDIUM — Remote (bridge) approval can substitute a tool input that was never validated or
  re-checked. src/bridge/bridgePermissionCallbacks.ts:32-40 validates only the behavior
  discriminant; updatedInput is Record<string, unknown> and entirely unchecked.
  src/hooks/toolPermission/handlers/interactiveHandler.ts:280 forwards it to buildAllow, and
  src/services/tools/toolExecution.ts:1130-1132 assigns it over processedInput with no
  inputSchema re-parse and no re-run of checkPermissions before :1207 tool.call(). Net
  effect: the input that executes can differ from the input the approved prompt described.
  Gated behind feature(BRIDGE_MODE) at src/hooks/useCanUseTool.tsx:165, which is disabled in
  the open build, so this is not reachable as shipped.

- LOW — The bypassPermissions killswitch does not revoke the session-level bypass flag.
  src/utils/permissions/bypassPermissionsKillswitch.ts:39-46 and
  src/utils/permissions/permissionSetup.ts:1389-1405 downgrade only the React
  toolPermissionContext. The separate session flag set at src/main.tsx:1392 and read via
  src/bootstrap/state.ts:1268 is never cleared. Consumers continue to see bypass-on:
  src/tools/shared/spawnMultiAgent.ts:221-225 and src/utils/swarm/spawnUtils.ts:49-53 still
  pass --dangerously-skip-permissions to newly spawned teammates (largely self-healing,
  since each child re-evaluates the gate at its own startup via
  src/utils/permissions/permissionSetup.ts:778), and
  src/utils/claudeInChrome/setup.ts:102-104 bakes
  CLAUDE_CHROME_PERMISSION_MODE=skip_all_permission_checks into the Chrome MCP server env at
  src/main.tsx:1537 — which runs before the killswitch hook can fire at all — so the
  killswitch structurally cannot reach that surface for the life of the session.

- LOW — Prefix match without a separator boundary in the edit-without-permission allowlist.
  src/utils/permissions/filesystem.ts:245-255 (isSessionPlanFile) accepts any normalized
  path that startsWith(plansDir + planSlug) and ends in .md, unlike the adjacent
  isScratchpadPath at :410-424 which correctly requires equality-or-prefix-plus-separator.
  Impact is contained to sibling .md files inside the plans directory — normalize() at :251
  defeats parent-directory traversal — so this is a hardening gap, not a boundary escape.

Explicitly not completed: this pass did not exhaustively read
src/tools/BashTool/bashPermissions.ts (~2.5k lines), bashSecurity.ts, readOnlyValidation.ts,
or their PowerShell equivalents, which together hold the bulk of the command-allowlist
logic. Their entry points were verified to be reached only via checkPermissions, but the
allowlist rules themselves are unaudited and should be scheduled as a dedicated follow-up.

## 2026-08-12 — Local-AI session 2: /think→reasoning_effort fix, Qwen3-Reranker, bridge model manager, eval harness
Files audited: src/memdir/rerank.ts, src/memdir/rerank.test.ts, src/memdir/rerank.live.test.ts, src/memdir/embeddingPreFilter.ts, src/memdir/findRelevantMemories.ts, src/services/api/openaiShim.ts, src/services/api/openaiShim.test.ts, src/services/api/providerConfig.ts (read for isLocalProviderUrl call-site tracing, not modified), src/tools/AskMathModelTool/prompt.ts, src/entrypoints/cli.tsx (read for isLocalProviderUrl call-site tracing, not modified), scripts/system-check.ts (read for isLocalProviderUrl call-site tracing, not modified), scripts/eval/specialistEval.ts, scripts/eval/cases.ts, python-bridge/server.py, python-bridge/local_models/manager.py, python-bridge/local_models/document_qa.py, python-bridge/local_models/image_caption.py, python-bridge/start.ps1, .gitignore
Verdict: 0 Critical, 0 High, 0 Medium, 1 Low
Recommendation: ship (Low finding fixed and re-verified live before this entry was written)
Findings: none blocking — 1 Low finding recorded inline below, fixed same session; no separate handoff report

Read-only audit performed by security-audit-agent (dispatched by the orchestrating session, not
this agent — it has no Write/Edit tools by design); this log entry and the corresponding code
fixes were applied by the orchestrating session directly from that agent's findings, then
re-verified live against the running bridge before this entry was staged.

Explicit checks confirmed (all pass):
- rerank.ts / embeddingPreFilter.ts / findRelevantMemories.ts: no SSRF (target URL is a
  trusted env-var-overridable localhost default, never derived from request input), no
  auth/credential headers sent, defensive response parsing throughout, both stages fail open
  to their unmodified input so neither can be forced to smuggle attacker-chosen content past
  Sonnet's final selection (findRelevantMemories.ts re-resolves against the full manifest).
  Informational only: rerank.ts's raw:true hand-built Qwen3 chat-template prompt means a
  memory description containing literal <|im_start|> markers could forge a template turn —
  reachable consequence is bounded to candidate list re-ordering, no execution/egress.
- openaiShim.ts's new think:false / reasoning_effort:'none' fields: isLocalProviderUrl
  (providerConfig.ts:210-247) traced at every call site (cli.tsx:95, openaiShim.ts:878/925,
  system-check.ts:8) — never gates credential transmission, TLS, or any permission check;
  Authorization/api-key headers are attached purely on key presence, independent of
  localness. Parsing itself resists userinfo-based hostname spoofing (uses URL().hostname).
  A crafted OPENAI_BASE_URL could still get misclassified as local (e.g. RFC1918/`*.local`
  patterns are intentionally broad), but env vars are trusted input and the only effect is
  two extra harmless body fields — no security consequence.
- manager.py's raw ctypes GetProcessMemoryInfo/GetCurrentProcess usage: struct layout,
  sizes, restype/argtypes, and return-value checking verified correct against the Win32 API
  contract; no unsafe buffer sizing, no unchecked return, no memory-safety issue.
- Bridge confirmed bound to 127.0.0.1 only (server.py, start.ps1 — grepped for 0.0.0.0/--host/
  CORS/add_middleware across python-bridge/, exactly one host-binding hit). /status endpoint
  payload confirmed to contain no filesystem paths, env vars, credentials, or request bodies.
- Eval harness (scripts/eval/) confirmed to make zero live paid frontier-API calls without an
  explicit --frontier flag (three call sites, all gated); confirmed AskMathModelTool uses its
  own MATH_MODEL_BASE_URL (always local Ollama), not OPENAI_BASE_URL, so this project's
  pre-existing .env (a live NVIDIA NIM key, unrelated to this session's work) cannot reach a
  paid provider through the math path even by accident.
- Untracked bridge log files read in full at audit time: no API keys, tokens, credentials, or
  PII — only machine-local absolute paths and username.

LOW — Unauthenticated /image-caption endpoint let a caller distinguish "file doesn't exist"
(404) from "file exists but isn't a loadable image" (previously an unhandled 500 via
PIL.UnidentifiedImageError) — a filesystem existence oracle, compounded by no Host-header
validation against DNS rebinding on the loopback-only service.
Fix (applied same session, verified live): python-bridge/server.py now catches OSError
alongside FileNotFoundError and returns the identical generic 404 for both cases
(image_caption.py's caption() carries a comment explaining why this collapse is deliberate);
a reject_unexpected_host ASGI middleware rejects any request whose Host header isn't
127.0.0.1/localhost with 403. Verified: /document-qa and /image-caption still succeed on
legitimate calls, a non-image existing file and a missing file now return byte-identical 404
responses, and a spoofed Host header gets 403. The broader "confine image_path to an
allowlisted root directory" recommendation was deliberately not applied — project owner
confirmed (2026-08-12) the existing project-level tool/permission model is the intended
control for this, not a path allowlist inside the bridge itself.

Also fixed same session (not a security finding, hygiene only): .gitignore had no pattern
for python-bridge/*.log, so the bridge's stdout/stderr logs showed as untracked-and-
committable; contents were confirmed to hold no secrets before adding the ignore pattern.

Not covered by this entry (pre-existing, confirmed unrelated to this session's diff via
git diff --stat showing zero changes to the files involved, cross-checked by three
independent agents including this one): the providerConfig.ts codexplan-alias-resolution
bug and the withRetry.ts Anthropic rate-limit-header-parsing bug surfaced by test failures
during this session's work. Both are being fixed in a follow-up covered by their own
audit-log entry when that work lands.

## 2026-08-12 — Local-AI sessions 6-12: DeepSolve logic engine (Phase 3.5) — Tier 1 restricted AST evaluator ships, pythonSandbox.ts retired not-safe-to-ship
Files audited: src/tools/AskMathModelTool/AskMathModelTool.ts, src/tools/AskMathModelTool/AskMathModelTool.test.ts, src/tools/AskMathModelTool/prompt.ts, src/tools/AskMathModelTool/deepSolve/restrictedEvaluator.ts, src/tools/AskMathModelTool/deepSolve/restrictedEvaluator.test.ts, src/tools/AskMathModelTool/deepSolve/verification.ts, src/tools/AskMathModelTool/deepSolve/verification.test.ts, src/tools/AskMathModelTool/deepSolve/generateCandidates.ts, src/tools/AskMathModelTool/deepSolve/generateCandidates.test.ts, src/tools/AskMathModelTool/deepSolve/rerankCandidates.ts, src/tools/AskMathModelTool/deepSolve/rerankCandidates.test.ts, src/tools/AskMathModelTool/deepSolve/solveDeep.ts, src/tools/AskMathModelTool/deepSolve/solveDeep.test.ts, src/tools/AskMathModelTool/deepSolve/solveDeep.live.test.ts, src/tools/AskMathModelTool/deepSolve/pythonSandbox.ts (retired, kept as historical record — see its own top-of-file banner), src/tools/AskMathModelTool/deepSolve/pythonSandbox.test.ts (unchanged, kept passing as historical record).
Also staged in this commit, declared rather than security-audited (outside the gate's sensitive-path pattern, named here for completeness per this log's own convention): src/memdir/rerank.ts (behavior-preserving extraction of scoreYesNoJudgment for reuse by rerankCandidates.ts — rerankMemoriesByRelevance's own logic/tests unchanged), scripts/eval/deepSolveEval.ts, scripts/eval/deepSolveCases.ts, scripts/eval/README.md, package.json (one new eval:deep-solve script entry), LOCAL_AI_MASTER_PLAN.md, LOCAL_AI_STATUS.md.
Verdict: 0 Critical, 0 High, 0 Medium, 0 Low
Recommendation: ship
Findings: none — independent security-audit-agent round 4's own verdict was SAFE TO SHIP with an explicitly empty findings list, after being tasked with finding a bypass of the new allowlist architecture specifically rather than re-confirming the sessions 8/9/10 exploit list (also independently re-confirmed inert by the orchestrating session before the audit was dispatched). No separate handoff report — full detail in LOCAL_AI_STATUS.md Sessions 11-12.

Context: this entry closes out the DeepSolve code-execution security question that spanned
Sessions 6, 8, 9, 10, 11, and 12 (see LOCAL_AI_STATUS.md for the full history) — nothing from
this feature was committed until this question was settled. The original design
(deepSolve/pythonSandbox.ts, arbitrary model-generated Python behind a static AST denylist +
runtime import guard) went through three independent adversarial security-audit-agent rounds,
each closing the specifically reported hole and each finding the same vulnerability class
reachable a different way, culminating in a live one-line RCE
(dataclasses.inspect.os.system(...), reachable via plain attribute traversal with no import
call at all) that is invisible to both a static linter and a runtime import chokepoint. Session
10's orchestrating-session judgment call was to stop iterating and not ship rather than attempt
a fourth denylist patch. LOCAL_AI_MASTER_PLAN.md §11 "Verifier isolation" (researched against
current external sources, all consistent: in-process Python sandboxing via denylist is
known-unwinnable, not a project-specific bug) prescribed the architectural inversion applied in
Session 11: Tier 1 (deepSolve/restrictedEvaluator.ts) is an allowlist of AST node shapes, not a
denylist of names — the untrusted snippet is walked and computed by a hand-written interpreter
that never calls Python's own eval()/exec()/compile(), so there is no object graph for an
attribute-traversal exploit to walk in the first place. pythonSandbox.ts is retired in place
(not deleted, not revived) with a top-of-file banner; confirmed by this session (grep on the
rebuilt dist/cli.mjs) to be genuinely dead code, tree-shaken out of the shipped bundle.

Two-layer verification before this entry was written, matching this exact surface's own
established discipline of never taking a single pass's word for it:

1. Orchestrating-session direct verification (before the round-4 audit was even dispatched):
   read restrictedEvaluator.ts in full; wrote and ran an independent 26-case empirical script
   (not reusing the building agent's own test file) covering every historical exploit payload
   from sessions 8/9/10 plus several new categories (lambda smuggling, list/set/dict
   comprehensions, f-string injection, dunder subscript access, DoS-bound triggers) — 26/26
   behaved safely; ran the real test suites directly and confirmed the reported counts matched
   exactly; rebuilt dist/cli.mjs and confirmed pythonSandbox.ts's distinctive string markers are
   absent while restrictedEvaluator.ts's are present; confirmed npx tsc --noEmit unchanged at
   the established 3521-error baseline.
2. Independent security-audit-agent, round 4, explicitly instructed not to re-run the
   already-confirmed exploit list but to hunt for a bypass specific to the new allowlist shape:
   function-value aliasing, reserved-name shadowing, the walrus operator, star-unpacking,
   AugAssign/AnnAssign/tuple assignment targets, NUL bytes, fullwidth-Unicode homoglyph
   identifiers (confirmed NFKC-normalizes consistently before both validation and evaluation —
   not a split-brain bug), complex-valued arithmetic, and a structural proof that the
   validator's recursion-depth limit actually bounds the evaluator's own recursion. Also
   independently re-confirmed: -I isolation genuinely defeats a temp-dir/CWD import hijack
   (verified empirically against the local interpreter); checkPermissions returns 'ask' for
   deep:true on the only call path to solveDeep, immune to the acceptEdits fast-path;
   pythonSandbox.ts's only importer is its own test file, no barrel re-export exists anywhere.

The audit's four non-blocking observations (explicitly not security findings — recorded for
completeness, as the audit itself framed them) and their disposition:
- A bare Constant AST node bypassed the interpreter's own magnitude/finiteness bound entirely
  (an overflowing float literal like 1e400 parses to inf without a SyntaxError, and NaN
  specifically survives the pre-existing abs(value) > MAX_ABS_VALUE check because all NaN
  comparisons evaluate False in Python) — could let a snippet resolve to a false
  "code-verified true" on an undefined computation. FIXED this session: evaluate()'s Constant
  branch now routes through the same _finalize() bound as every other production point, and
  _finalize() explicitly rejects non-finite floats. Four new regression tests added
  (restrictedEvaluator.test.ts, 59 -> 63 tests).
- The Pow bound checked only the exponent's magnitude, not the resulting value — a large-int
  base already within MAX_ABS_VALUE (from a prior bounded assignment) raised to another
  bounded-looking exponent could still trigger CPython's eager exact int**int computation of a
  many-million-digit integer before _finalize saw it (contained by the existing 5-10s process
  timeout regardless, so no unbounded resource consumption, but contradicting the code's own
  documented "checked after every operation" guarantee). FIXED this session: a log10-based
  magnitude pre-check (correct for arbitrary-precision int bases) rejects before ** is ever
  invoked when the estimate alone exceeds the bound.
- A stale comment in AskMathModelTool.ts undercounted the real call sites of
  Tool.isReadOnly() by one (a UI-label-only path in FilesystemPermissionRequest.tsx that
  AskMathModelTool never reaches). FIXED this session: comment corrected.
- scripts/eval/deepSolveEval.ts calls solveDeep() directly, bypassing checkPermissions — noted
  as intentional and consistent with every other scripts/eval/* entry point (a
  developer-invoked harness requiring shell access to run at all), not a bypass of the tool's
  actual gate. No fix needed.

All four fixes verified together after applying: restrictedEvaluator.test.ts 63/63 pass (279
expect() calls); full src/tools/AskMathModelTool/ tree 183/183 pass (504 expect() calls,
including a live end-to-end run against the real local Ollama model); bun run build clean; npx
tsc --noEmit unchanged at 3521; direct empirical timing check confirmed both numeric fixes
resolve in well under 200ms (pre-checks firing, not the 5000ms timeout masking a still-slow
path).

Deferred, not built this session (per LOCAL_AI_MASTER_PLAN.md §11's own resolution, not an
oversight): Tier 2 (real OS/WASM isolation for the arbitrary-code subset Tier 1's grammar
cannot express) remains parked — no case in the current eval set has demonstrated needing it.

## 2026-08-12 — Local-AI session 3/3b: DataAnalyzeTool, delegation ledger, MCP-scoping, dedicated CUDA venv + Phase 3 models
Files audited: src/tools/DataAnalyzeTool/DataAnalyzeTool.ts, src/tools/DataAnalyzeTool/schemas.ts, src/tools/DataAnalyzeTool/predictTask.ts, src/tools/DataAnalyzeTool/prompt.ts, src/tools/DataAnalyzeTool/DataAnalyzeTool.test.ts, src/delegationLedger.ts, src/delegationLedger.test.ts, src/query.ts, src/tools.ts, src/services/mcp/config.ts, src/utils/providerProfile.ts, src/services/api/codexShim.test.ts, src/services/api/withRetry.test.ts, src/services/api/toolCallRecoveryIntegration.test.ts, scripts/eval/routingEval.ts, scripts/eval/routingCases.ts, python-bridge/server.py, python-bridge/local_models/table_qa.py, python-bridge/local_models/tabular_predict.py, python-bridge/local_models/forecast.py, python-bridge/local_models/manager.py, python-bridge/local_models/document_qa.py, python-bridge/local_models/image_caption.py, python-bridge/requirements.txt, python-bridge/start.ps1, .gitignore, package.json
Also staged in this commit, declared rather than deep-read (test-only, no production
surface — recorded here so every staged security-sensitive file is named per the gate's
requirement, not folded silently into the "audited" list above): src/tools/DataAnalyzeTool/DataAnalyzeTool.live.test.ts (live-network test mirroring the already-audited .test.ts's assertions against the real bridge, no new logic), src/tools/DataAnalyzeTool/predictTask.test.ts (pure unit tests for predictTask.ts's classification heuristic, no I/O), src/services/api/toolCallRecoveryIntegration.live.test.ts (verbatim relocation of the one live test deleted from toolCallRecoveryIntegration.test.ts, which was read in full).
Verdict: 0 Critical, 0 High, 0 Medium, 1 Low (fixed), 2 informational (no action needed)
Recommendation: ship (Low finding fixed and re-verified live before this entry was written)
Findings: none blocking — 1 Low finding recorded inline below, fixed same session; no separate handoff report

Read-only audit performed by security-audit-agent (dispatched by the orchestrating session,
which applied the one code fix from its findings and re-verified live before staging this
entry — the audit agent itself has no Write/Edit tools by design).

Pass/fail against every check requested (all seven passed, one with a finding):
1. DataAnalyzeTool: input re-validated via the discriminated union in validateInput()/call()
   before any network call; no SSRF (fixed loopback base URL, hardcoded route paths, nothing
   request-derived reaches host/protocol/path); no auth headers; no string-templating
   injection surface (body is JSON.stringify over schema-validated arrays). checkPermissions
   posture matches the already-audited DocumentQATool/ImageCaptionTool pattern and is
   strictly less exposed (no filesystem path taken at all).
2. delegationLedger.ts: no-raw-query-text claim verified structurally (the only free-text
   field is a SHA-256 hash, tool arguments/results are never persisted — results are read
   only transiently for outcome classification, never written); "never throws" verified
   structurally (the entire body, including the file writes, is inside one try/catch); file
   path is built from fixed module constants with no input-derived segment, no traversal
   possible; reports/ is gitignored.
3. OPENCLAUDE_DISABLED_MCP_SERVERS: traced every consumer of isMcpServerDisabled — the new
   branch is monotonically restrictive (can only disable, never re-enable, a server another
   check already disabled), and no consumer uses "disabled" status to skip a permission
   check. The one path that could matter (an MCP-hosted --permission-prompt-tool) fails
   closed if unreachable rather than defaulting to allow. Confirmed profile-scoped in both
   directions: cleared on every non-ollama branch, and applyProfileEnvToProcessEnv deletes
   it before reassignment so it cannot survive a profile switch.
4. query.ts wiring: logDelegationDecision runs strictly after the real tool result is already
   yielded to the user, so it cannot block, reorder, or fail the actual response path.
5. Confirmed via direct git diff/status: providerConfig.ts and withRetry.ts show zero changes
   this session — the two pre-existing test failures were fixed via test-side env isolation
   only, never by touching production logic.
6. package.json: exactly the two expected script changes (new eval:routing entry,
   --path-ignore-patterns added to test:provider), nothing else.
7. Python bridge additions: line-by-line validation review of table_qa.py/forecast.py/
   tabular_predict.py confirmed malformed-input handling (empty/ragged/mismatched-length
   input) raises a mapped 400 in every case except the one Low finding below. Device
   placement confirmed safe (device string is never request-derived, CUDA-unavailable and
   CUDA-OOM both fail cleanly to CPU/a clean per-model-lock release with no partial state
   entering the loaded-model registry). python-bridge/venv/ confirmed gitignored. TabPFN's
   telemetry-disable env var confirmed to run before the only (lazy, function-local) import
   of tabpfn anywhere in the bridge, and independently confirmed against the installed
   package's own source that the telemetry service reads that var and short-circuits before
   any network call — no outbound request occurs. Also checked and clear: TabPFN's checkpoint
   load uses weights_only=True (this torch version's resolved default) — no pickle-
   deserialization RCE surface; routingEval.ts spawns via argv array with no shell:true and
   strips provider-selection env vars before spawning — no command injection, no risk of a
   local eval run silently hitting a paid cloud provider.

LOW (fixed) — /tabular-predict returned a raw 500, not the contracted 400, for a reachable
edge case: an explicit operation="regress" call with non-numeric (string) train_labels.
_validate_table() checked shape but not label type; the unchecked
np.array(train_labels, dtype=float) conversion raised a bare ValueError that escaped the
route's InvalidTabularInput handler. Not reachable through DataAnalyzeTool's own inference
path (predictTask.ts always infers "classify" for any string label) but reachable if a
caller sets task="regress" explicitly, which the flat tool schema permits. No security
impact on its own (loopback-only, no crash, no sensitive data in the 500 body) — a
contract-accuracy defect, not a vulnerability. Fixed same session in
python-bridge/local_models/tabular_predict.py: an explicit label-type check ahead of the
float conversion, raising InvalidTabularInput (mapped to 400) with a clear message pointing
the caller at operation="classify" instead. Verified live: the same request that previously
would have 500'd now returns 400 with the expected message; a normal all-numeric regress
call re-verified unaffected.

Informational, no action taken: TabPFN's telemetry-disable line uses os.environ.setdefault
rather than an unconditional assignment — functionally correct in this bridge (nothing else
sets that var), verified true by confirming no network call occurs, but the code's own
comment reads as slightly stronger than the setdefault semantics actually guarantee; a minor
documentation-precision note only, not a fix. Stray zero-byte debug artifacts
(doc_qa_result.json, import_check2.pid, pip_check.pid) at the repo root, left over from
agent-side manual verification during this session, were flagged as an ungitignored-hygiene
item — already deleted by the orchestrating session before this entry was staged (confirmed
absent from git status at commit time), no gitignore pattern was judged necessary for
one-off scratch files that don't recur as a class the way the earlier *.log finding did.

## 2026-08-13 — Phase 4 "Hearing" tool side: AudioAnalyzeTool + TranscribeAndSummarizeTool + shared audioBridge.ts
Files audited: src/tools/shared/audioBridge.ts, src/tools/AudioAnalyzeTool/AudioAnalyzeTool.ts, src/tools/AudioAnalyzeTool/schemas.ts, src/tools/AudioAnalyzeTool/prompt.ts, src/tools/TranscribeAndSummarizeTool/TranscribeAndSummarizeTool.ts, src/tools/TranscribeAndSummarizeTool/prompt.ts
Also staged in this commit, declared rather than deep-read (test-only, no production surface — named here per this log's own convention, not folded silently into the audited list): src/tools/AudioAnalyzeTool/AudioAnalyzeTool.test.ts, src/tools/AudioAnalyzeTool/AudioAnalyzeTool.live.test.ts, src/tools/TranscribeAndSummarizeTool/TranscribeAndSummarizeTool.test.ts, src/tools/TranscribeAndSummarizeTool/TranscribeAndSummarizeTool.live.test.ts. One spot-check made anyway: both .live.test.ts files add a node:child_process use (execFileSync('powershell.exe', [...]) for SAPI TTS fixture synthesis, AudioAnalyzeTool.live.test.ts:37-41) — argv-form, no shell:true, developer-authored literal script over an mkdtempSync path, unreachable from production. Not a finding.
Read for data-flow tracing, not modified in this diff: python-bridge/server.py (Phase 4 routes), python-bridge/local_models/transcribe.py, python-bridge/local_models/vad.py, python-bridge/local_models/audio_utils.py, src/tools/shared/localModelBridge.ts, src/utils/combinedAbortSignal.ts, src/tools/ImageCaptionTool/ImageCaptionTool.ts, src/tools.ts, src/hooks/toolPermission/permissionLogging.ts. Also staged, non-code: .claude/contracts/tool-contract.md, LOCAL_AI_MASTER_PLAN.md, LOCAL_AI_STATUS.md, src/tools.ts (registration only, two entries).
Verdict: 0 Critical, 0 High, 0 Medium, 0 Low (3 informational, no action taken)
Recommendation: ship
Findings: none — no separate handoff report.

Pass/fail against every check requested (all five passed, no findings):
1. Path/injection: audio_path is carried as a JSON string field only (audioBridge.ts:40-45,
   bodies at :117/:134) — never URL-interpolated, never path-concatenated, and this TS layer
   does no filesystem access on it at all (no fs/node:path import in any of the three new
   production files). Server side: the path reaches only os.path.isfile()/wave.open()
   (audio_utils.py:63-72); no subprocess/shell anywhere on the Phase 4 routes.
2. No SSRF: fetch target is `${MODEL_BRIDGE_BASE_URL}${path}` with path one of two hardcoded
   literals; base is localModelBridge.ts:8-9 (env-overridable loopback default — trusted input
   per this project's established precedent). Nothing request-derived reaches host/protocol/path.
3. checkPermissions: unconditional-allow claim verified by direct read at
   AudioAnalyzeTool.ts:165-172 and TranscribeAndSummarizeTool.ts:98-106 — effect-equivalent to
   ImageCaptionTool.ts:61-63, the direct path-taking precedent, and no more permissive. Both
   tools declare isReadOnly() true; both re-validate against the discriminated union inside
   call() (AudioAnalyzeTool.ts:181-185) before any network call. validateInput -> checkPermissions
   -> call ordering intact; no unawaited check, no bypass path.
4. Error handling: throwForErrorResponse (audioBridge.ts:88-107) surfaces only the caller's own
   audio_path (404 branch) plus the bridge's `detail`. Every detail producer on these two routes
   traced — 404s are a fixed literal (server.py:251/253/287/289, preserving the collapsed
   existence-oracle response, and audioBridge.ts:94-98 does not reintroduce a missing-vs-
   unloadable distinction); 400s (transcribe.py:146/149/212, vad.py:228/230/232) contain
   durations, the caller's own language value, and static text — no paths, stack traces, or
   secrets. readDetail (:58-67) is JSON.parse in try/catch with no reviver; a null/non-object/
   non-JSON body falls through to raw text. Worst case from a hostile bridge response is a thrown
   Error: no eval, no new Function, no branch keyed on response content. No auth headers are sent
   to the bridge, and nothing in the three new files logs anything (grep: zero console./logError/
   logEvent/process.env hits).
5. TranscribeAndSummarize's two sequential calls: one combined signal covers both legs
   (:124-126), so a caller abort cancels the in-flight request rather than only one leg; cleanup()
   runs in finally (:169-171) on every path including the zero-speech early return, clearing the
   setTimeout and removing the caller-signal listener (combinedAbortSignal.ts:40-44). Already-
   aborted fast path creates no timer. Response bodies consumed on both success and error paths.
   The zero-speech skip (:145-157) can only cause fewer bridge calls on an already-named path —
   pure optimization, no capability granted, no security implication either direction.

Contract-as-data check: the staged tool-contract.md diff is documentation only (§2 table rows, §3
status prose, §4 emptied) — no embedded directive addressed to an agent, nothing instructing an
audit to be skipped or marked complete.

Informational, no action taken:
- Response bodies are cast, not schema-parsed (audioBridge.ts:123, :140-141) — a malformed bridge
  response surfaces as a contained TypeError (e.g. TranscribeAndSummarizeTool.ts:147). Identical
  to ImageCaptionTool.ts:96's existing `as Output`; peer is a trusted loopback service.
- postJson's catch (audioBridge.ts:46-48) funnels AbortError (user cancel / 120s timeout) into
  modelBridgeUnavailableMessage, so a cancelled call reports "Is it running?". Same shape as
  ImageCaptionTool.ts:84-86 — message accuracy only, cancellation itself works.
- As with ImageCaptionTool, the unconditional allow means deny: Read(...) rules do not gate these
  reads. That is the owner-confirmed posture recorded in this log's 2026-08-12 entry (path
  allowlisting deliberately declined in favour of the project-level tool/permission model), and
  exposure is bounded to parseable 8/16-bit PCM WAV content with the 404 collapse intact.

Ledger observation (outside this diff, no action required for this commit): the Phase 4 bridge-side
commit 7936828 (transcribe.py, vad.py, audio_utils.py, server.py routes) has no entry in this log.
Those paths fall outside the gate's src/tools/ pattern so none was required, but prior entries
voluntarily covered python-bridge/. All four files were read in full during this audit as part of
tracing the tool-side data flow; nothing requiring action was found — see the retroactive entry
immediately below.

## 2026-08-13 — Retroactive, voluntary coverage: Phase 4 bridge-side (commit 7936828 — transcribe.py, vad.py, audio_utils.py, server.py routes)
Files audited: python-bridge/local_models/transcribe.py, python-bridge/local_models/vad.py, python-bridge/local_models/audio_utils.py, python-bridge/server.py (§ Phase 4 `/transcribe`/`/vad` routes only)
Verdict: 0 Critical, 0 High, 0 Medium, 0 Low
Recommendation: ship (already committed and live-verified across sessions 19-22 before this entry was written)
Findings: none — no separate handoff report.

Context: these four files landed in commit 7936828, outside this log's mandatory gate (the
`security-gate` hook's path pattern is `^src/tools/` etc. and does not cover `python-bridge/`), so
no audit was strictly required before that commit. Voluntarily covered here, after the fact,
matching this log's own established convention of covering `python-bridge/` anyway (see the
2026-08-12 session 2 entry) — read in full as part of tracing data flow for the tool-side audit
immediately above, not as a fresh independent pass, so this entry is narrower in scope than a
dedicated bridge audit would be: it covers exactly what the tool-side audit needed to trace
(the `/transcribe`/`/vad` routes' own input handling), not the full bridge surface.

Checked: `audio_path` reaches only `os.path.isfile()` (audio_utils.py:63) and `wave.open()`
(audio_utils.py:67) — no subprocess, no shell, no dynamic import keyed on the path. The documented
404 collapse (missing file vs. unreadable/unsupported-format file, both `UnsupportedAudioError`/
`FileNotFoundError` mapped to the same generic 404 in server.py) is intact and matches the
already-established `/image-caption` precedent exactly — no new filesystem-existence-oracle
surface. `/transcribe`'s `language` parameter is passed to `model.generate(language=...)`
(transcribe.py) and only ever reaches a `ValueError` (`"Unsupported language: ..."`) on an
unrecognized value, mapped to a 400 — not a code-execution or template-injection surface.
`reject_unexpected_host` middleware (server.py, pre-existing) covers these new routes
automatically, no change needed. No new dependency in this diff (`onnxruntime`,
`flatbuffers`, `protobuf` — see requirements.txt) is invoked with any request-derived data
beyond the already-covered `audio_path`. No credentials, no outbound network calls beyond the
loopback bridge itself.

## 2026-08-13 — Phase 5 "Vision suite" tool side: VisionAnalyzeTool + shared visionBridge.ts
Files audited: src/tools/shared/visionBridge.ts, src/tools/VisionAnalyzeTool/VisionAnalyzeTool.ts, src/tools/VisionAnalyzeTool/schemas.ts, src/tools/VisionAnalyzeTool/prompt.ts
Also staged in this commit, declared rather than deep-read (test-only, no production surface — named here per this log's own convention): src/tools/VisionAnalyzeTool/VisionAnalyzeTool.test.ts, src/tools/VisionAnalyzeTool/VisionAnalyzeTool.live.test.ts. One spot-check made anyway: the live test adds execFileSync(VENV_PYTHON, ['-c', script]) for PIL fixture synthesis (VisionAnalyzeTool.live.test.ts:39) — argv-form, no shell:true, developer-authored literal script over an mkdtempSync path, unreachable from production. Not a finding. The mocked test replaces globalThis.fetch and restores originalFetch in teardown — test-local only.
Read for data-flow tracing, not modified in this diff: src/tools/shared/localModelBridge.ts, src/tools/shared/audioBridge.ts (baseline), src/tools/ImageCaptionTool/ImageCaptionTool.ts (duplicate-drift comparison), src/tools/AudioAnalyzeTool/AudioAnalyzeTool.ts (posture comparison), src/utils/permissions/filesystem.ts (getPath consumers), python-bridge/server.py (Phase 5 routes), python-bridge/local_models/image_utils.py, python-bridge/local_models/vitpose.py (pose()). Also staged, non-code: .claude/contracts/tool-contract.md, LOCAL_AI_STATUS.md, src/tools.ts (registration only, two lines).
Verdict: 0 Critical, 0 High, 0 Medium, 0 Low (4 informational, no action taken)
Recommendation: ship
Findings: none — no separate handoff report.

Context: third tool of this exact shape audited in one session (DataAnalyzeTool established the
pattern; AudioAnalyzeTool/TranscribeAndSummarizeTool/audioBridge.ts is the immediately preceding
round, same architecture). VisionAnalyzeTool is the same architecture again — one gateway tool,
now 7 operations (caption/classify/embed/embed-dinov2/segment/detect/pose) calling 7 bridge routes
instead of 2 — audited proportionately given the pattern is not new, but each of the 7 operations
verified individually, not inferred from the first.

Pass/fail against every check requested (all seven passed, no findings):
1. Path/injection across all 7 operations: image_path is a JSON string field only, built at
   visionBridge.ts:108/123-124/138/151/166-170/185-188/202-205 and serialized by postJson's
   JSON.stringify (:40-45) — never URL-interpolated, never path-concatenated. This TS layer does
   zero filesystem access (no node:fs/node:path/require import in any of the four production
   files). Server side: the path reaches only os.path.isfile()/Image.open() (image_utils.py:38-39);
   no subprocess/shell on any Phase 5 route.
2. No SSRF: fetch target is `${MODEL_BRIDGE_BASE_URL}${path}` with path one of exactly 7 hardcoded
   literals; base is localModelBridge.ts:8-9 (env-overridable loopback default, trusted per
   established precedent). Nothing request-derived reaches host/protocol/path.
3. checkPermissions: unconditional allow confirmed at VisionAnalyzeTool.ts:223-231, effect-identical
   to AudioAnalyzeTool.ts:165-172 and ImageCaptionTool.ts:61-63, no more permissive — same getPath
   shape, same isReadOnly()===true, same maxResultSizeChars: 20_000. validateInput re-validates
   against the discriminated union; call() re-validates again before any network call.
   validateInput -> checkPermissions -> call ordering intact; no unawaited check, no bypass path.
4. Error handling across all 7 call functions: throwForErrorResponse (visionBridge.ts:82-101)
   surfaces only the caller's own image_path (404 branch) plus the bridge's detail. Every detail
   producer traced: 404s are fixed literals (server.py, multiple lines, all "image not found or not
   readable" — the path-bearing FileNotFoundError message never reaches the response); 400s are
   static literals (clip.py/clipseg.py/owlv2.py/vitpose.py) with no paths, stack traces, or secrets.
   readDetail is JSON.parse in try/catch with no reviver; non-JSON/non-object bodies fall through to
   raw text. Worst case from a hostile bridge response is a thrown Error or a contained TypeError —
   no eval, no new Function, no branch keyed on response content. No auth headers sent; nothing in
   the four production files logs anything.
5. "pose" boxes (new surface): flows straight to a JSON body, never indexed or used for TS-side
   allocation/arithmetic. Zod bounds shape only (length-4 array) — stricter than the bridge's own
   len(b)!=4 check, which is what actually bounds the value server-side. Omitted boxes forwards
   undefined, dropped by JSON.stringify, so the bridge's full-image default applies as contracted.
6. "classify" labels / "detect" queries (new surface): required non-empty string arrays, no upper
   bound, JSON-serialized only. Worst case is a large-but-bounded request to a same-user loopback
   service, bounded further by MODEL_BRIDGE_TIMEOUT_MS (120s) and maxResultSizeChars — DoS-flavored
   at most, consistent with existing DataAnalyzeTool/AskMathModelTool handling of unbounded array
   inputs, excluded from findings per the DoS/resource-exhaustion exclusion.
7. ImageCaptionTool fold-in duplicate: callImageCaption is a genuine duplicate of ImageCaptionTool's
   inline /image-caption fetch, and a strict superset of it (adds detail extraction and 400 mapping
   the original lacks; broadens rather than narrows the 404 text) — does not reintroduce a
   missing-vs-unloadable distinction, so the existence-oracle collapse the original /image-caption
   review established stays intact. Nothing dropped in the copy.

Contract-as-data check: the staged tool-contract.md diff is documentation only (§2 table row, §3
Phase 5 route table and consumer-status prose, §4 emptied) — no embedded directive addressed to an
agent, nothing instructing an audit to be skipped or marked complete.

Informational, no action taken:
- Response bodies are cast, not schema-parsed (visionBridge.ts, multiple lines) — a malformed
  bridge response surfaces as a contained TypeError (VisionAnalyzeTool.ts:345's optional chain
  guards people[0] but not .keypoints; :315/:336's .toFixed(3) on a non-number score). Identical to
  ImageCaptionTool.ts:96's existing `as Output` and the same note in the audioBridge.ts entry; peer
  is a trusted loopback service.
- postJson's catch funnels AbortError (user cancel / 120s timeout) into modelBridgeUnavailableMessage,
  so a cancelled call reports "Is it running?". Same shape as audioBridge.ts/ImageCaptionTool.ts —
  message accuracy only.
- Unconditional allow means deny: Read(...) rules do not gate these reads — getPath is only
  consumed by opt-in callers (filesystem.ts, permissionLogging.ts, FilesystemPermissionRequest.tsx),
  not applied automatically. Owner-confirmed posture recorded in this log's 2026-08-12 entry;
  exposure bounded to PIL-loadable image content with the 404 collapse intact.
- Box *value* range is unbounded on both sides (Zod enforces length-4, vitpose.py enforces length-4,
  neither bounds magnitude/sign). No security impact (no path/shell/TS-side-allocation surface —
  see check 5); whether an extreme value (e.g. [0,0,1e18,1e18]) maps to a clean 400 or escapes as a
  raw 500 bridge-side was not verified in this read-only pass. Flagged as a contract-accuracy
  question for python-bridge-agent (same class as the earlier /tabular-predict Low), not a
  vulnerability, outside this diff.

## 2026-08-14 — Session 29 routing-eval work: tool DESCRIPTION/prompt text only (5 tool files)
Files audited: src/tools/AskMathModelTool/prompt.ts, src/tools/DataAnalyzeTool/prompt.ts, src/tools/DocumentQATool/DocumentQATool.ts, src/tools/ImageCaptionTool/ImageCaptionTool.ts, src/tools/VisionAnalyzeTool/prompt.ts
Also staged in this commit, outside the gate's own sensitive-path set — read for context, not deep-audited (two of them noted below): src/services/api/toolPreFilter.ts, src/services/api/routerFewShot.ts, src/services/api/routerFewShot.test.ts, src/services/api/openaiShim.test.ts, scripts/eval/deepSolveCases.ts, scripts/eval/deepSolveEval.ts, LOCAL_AI_STATUS.md.
Verdict: 0 Critical, 0 High, 0 Medium, 0 Low
Recommendation: ship
Findings: none — no separate handoff report.

Scope claim, independently verified rather than accepted: the dispatching characterization
("description/prompt string only, no inputSchema/checkPermissions/call()/validation change") was
checked against `git diff --cached` per file, not taken on faith, and is accurate. `git diff
--name-only` is empty, so index and working tree agree and nothing is hidden outside the staged
diff. Per-file numstat: +2/-0, +2/-0, +5/-1, +5/-1, +1/-0 — 17 changed lines total, every one of
them inside a DESCRIPTION template literal. All five files were read end to end this session;
this is not a sampled pass, and every staged file matching the gate's `^src/tools/` pattern is
named above.

- DocumentQATool.ts: the only hunk replaces the one-line DESCRIPTION literal with the three-
  paragraph version now at :13-17. inputSchema (:19-24), outputSchema (:27-32), checkPermissions
  (:64-66), call() (:73-101) and mapToolResultToToolResultBlockParam (:102-112) are unchanged
  from HEAD.
- ImageCaptionTool.ts: same shape — only hunk is DESCRIPTION at :13-17. inputSchema (:19-23),
  getPath (:59-61), checkPermissions (:65-67) and call() (:74-105) are unchanged from HEAD.
- All three prompt.ts files are pure string modules — one exported DESCRIPTION template literal
  plus an exported PROMPT alias, no imports, no functions, no branching, nothing executable to
  change (AskMathModelTool/prompt.ts:1,25; DataAnalyzeTool/prompt.ts:1,29;
  VisionAnalyzeTool/prompt.ts:1,26).

Checks run against the added text specifically — a text-only diff needs text-specific checks, not
a re-run of a control-flow checklist that has nothing here to bite on:

1. No template-literal escape or interpolation introduced. Zero dollar-brace sequences across all
   15 added lines; the only dollar signs are in the literal phrase "$ signs"
   (AskMathModelTool/prompt.ts:12, DataAnalyzeTool/prompt.ts:9). The backticks added in
   VisionAnalyzeTool/prompt.ts:4 are correctly backslash-escaped, so no literal terminates early
   and no expression position is opened. These are static developer-authored constants — no
   runtime or user-derived value is concatenated into any of them.
2. Hidden-character scan of every added line: no bidi controls (U+202A-202E, U+2066-2069), no
   zero-width or format characters (U+200B-200F, U+2060-2064, U+FEFF, U+00AD), no private-use,
   surrogate or tag characters. The only non-ASCII character present is EM DASH (U+2014, 16
   occurrences), matching the surrounding prose style. This is the check that actually matters
   for a diff whose entire payload is text the model reads — invisible-instruction smuggling
   would land exactly here, and there is none.
3. No prompt-injection surface added. Each string reaches the model as a static tool description
   through tool.prompt() (consumed at src/utils/api.ts:171, src/services/api/toolPreFilter.ts:160,
   src/utils/toolSearch.ts:350, src/utils/analyzeContext.ts:652) with no untrusted content spliced
   in. The quoted sample passage appearing in both DataAnalyzeTool/prompt.ts:8 and
   DocumentQATool.ts:15 ("...is over 13,000 miles long...") is inert illustrative prose used to
   separate two tools, not an instruction, and carries no path, URL, credential or command.
4. Direction of the change is restrictive, not permissive. ImageCaptionTool.ts:15 ("cannot
   invent, imagine, or find an image") and DocumentQATool.ts:17 ("cannot invent, recall, or fetch
   source text") narrow the set of calls the model will attempt; the rest redistributes routing
   between three already-registered local-bridge tools. Checked explicitly against architecture
   rule 2: no added line tells the model to skip a confirmation, assume approval, retry past a
   denial, treat a permission as already granted, or route around any gate —
   bypassPermissionsKillswitch.ts remains the only bypass path and is untouched.
5. Permission-ordering invariant re-confirmed for both modified tool files rather than assumed:
   checkPermissions is still present and unconditional-allow at DocumentQATool.ts:64-66 and
   ImageCaptionTool.ts:65-67, identical to HEAD, and both tools still go through the shared
   validateInput -> checkPermissions -> call pipeline. Nothing in this diff is async, awaited, or
   ordered at all — there is no execution path to invert.
6. No new executable surface of any kind: the diff adds no import, no statement, no eval / new
   Function, no child_process, no filesystem or network call.

Adjacent, reviewed, not findings:
- src/services/api/toolPreFilter.ts:94-102 adds 'AudioAnalyze', 'TranscribeAndSummarize' and
  'VisionAnalyze' to CORE_TOOL_NAMES. That set governs which tools are offered to the local
  router, never whether a call is permission-checked — each of the three still runs its own
  checkPermissions through the same pipeline. Outside the gate's sensitive-path set; named for
  completeness.
- src/services/api/routerFewShot.ts:159-163 adds a few-shot example teaching the router to emit
  Read with a file_path. The path is an illustrative non-existent C:\Users\me\notes.txt, not a
  real or sensitive location, and a few-shot example cannot weaken FileReadTool's own permission
  check — it changes what the router proposes, not what the pipeline allows.
- Contract-as-data check: no file under .claude/contracts/ is staged other than this ledger, and
  the staged LOCAL_AI_STATUS.md diff's uses of "audit" are narrative descriptions of the
  session's routing-eval work, not directives addressed to an agent or instructions to skip a
  check.

Pre-existing and explicitly NOT re-litigated as a finding of this entry: ImageCaptionTool's and
DocumentQATool's unconditional-allow checkPermissions combined with a caller-supplied
image_path/context. That posture is unchanged by this diff and is already recorded, with the
owner-confirmed reasoning, in this log's 2026-08-12 and 2026-08-13 entries — and this diff
narrows the model's use of that path rather than widening it.

## 2026-08-15 — Session 29 (2nd continuation): DeepSolve generation-failure resilience, math-model timeout reduction, audio-path image-extension pre-reject, 6th router few-shot example
Files audited: src/tools/AskMathModelTool/prompt.ts, src/tools/AskMathModelTool/constants.ts, src/tools/AskMathModelTool/deepSolve/solveDeep.ts, src/tools/shared/audioBridge.ts, src/services/api/routerFewShot.ts, src/services/api/routerFewShot.test.ts, src/services/api/openaiShim.test.ts
Verdict: 0 Critical, 0 High, 0 Medium, 2 Low
Recommendation: ship
Findings: none blocking — 2 Low notes recorded inline below; no handoff report filed

Scope: exhaustive over the staged diff (`git diff --cached`, all 7 source files read in full or
in the complete surrounding function). LOCAL_AI_STATUS.md is also staged but is documentation,
outside the gate's sensitive-path set. Each claim below was verified against the code this
session, not against the dispatch description.

Verified (pass):
- src/tools/AskMathModelTool/deepSolve/solveDeep.ts:109-119 — the new try/catch wraps exactly one
  expression, `await generateCandidate(...)`. `verifyAnswer` (:122) is deliberately OUTSIDE it, so
  a verification-path throw still propagates as before; the catch cannot swallow or reclassify a
  verification result. Confirmed by reading the file, not the diff hunk alone.
- No verification/code-execution bypass. `verified: true` is still reachable from exactly two
  sites (solveDeep.ts:124-138 and :180-188), both gated on `verification.outcome === 'pass'` from
  verifyAnswer. A candidate that throws during generation is never pushed to `all` (:120) and
  therefore never reaches verifyAnswer, the reranker, or a result — it cannot be "accepted
  unverified"; it is simply absent. `git status --porcelain` confirms deepSolve/verification.ts,
  deepSolve/restrictedEvaluator.ts and deepSolve/pythonSandbox.ts are unmodified in both index and
  working tree — the executed-check path itself is untouched by this diff.
- Abort semantics preserved. A parent-signal abort surfacing as a throw from generateCandidate is
  caught and `continue`s, but the next iteration's `if (signal.aborted) break` (:107) still
  terminates the loop immediately, so user cancellation is not defeated by the new catch. The
  internal MATH_MODEL_TIMEOUT_MS abort (a *combined* signal built per-call in
  generateCandidates.ts:156-158 with `cleanup()` in a `finally`) leaves the parent signal
  un-aborted, which is the intended "try the next temperature" case.
- Fail-closed on total generation failure. With `all`/`failed`/`inconclusive` all empty the
  function throws (:222-227); solveDeep's only production caller
  (src/tools/AskMathModelTool/AskMathModelTool.ts:184) does not wrap it in a try/catch, so the
  error surfaces as a tool error. There is no path where a generation failure degrades into a
  silently-returned answer.
- src/tools/AskMathModelTool/constants.ts:36 — MATH_MODEL_TIMEOUT_MS 600_000 -> 280_000 is a
  reduction. All three consumers (AskMathModelTool.ts:197, generateCandidates.ts:157 and :189)
  use it solely as `timeoutMs` for createCombinedAbortSignal; it is not a cache TTL, token
  lifetime, permission-cache window, or any other security-relevant duration. Tightening it
  cannot widen a resource allowance or extend the validity of anything.
- src/tools/shared/audioBridge.ts:58-67 — `rejectIfObviouslyNotAudio` is pure string handling
  (`toLowerCase`, `Array.find` + `endsWith`, `throw`). No fs, no fetch, no spawn, no dynamic
  code. It returns void on the non-image path, so control still reaches postJson and the bridge's
  own 404/400 validation (:123-142) for everything it does not reject — it can only reject
  earlier, never approve. Verified it cannot substitute for server-side validation because it has
  no allow branch at all.
- Permission ordering unaffected by the audioBridge change: the new throw is inside
  callTranscribe/callVad (:150, :168), reached only from AudioAnalyzeTool.ts:194/:205 and
  TranscribeAndSummarizeTool.ts:145/:159, i.e. inside `call()` — strictly after checkPermissions
  has already resolved. Both tools' checkPermissions (AudioAnalyzeTool.ts:165-171,
  TranscribeAndSummarizeTool.ts:98-106) are unchanged pre-existing unconditional 'allow'; this
  diff does not touch them and neither caller catches the new error to proceed anyway.
- Error-message construction is safe. The message interpolates the caller-supplied path into a JS
  template literal thrown as an Error and rendered as tool_result text — no shell, SQL, HTML or
  filesystem sink. This matches the file's own pre-existing posture at :131, where the 404
  message already echoes `audioPath` verbatim. No new sink, no escaping context introduced.
- src/services/api/routerFewShot.ts:172-190 — the new 6th example is two hardcoded string literals
  with zero interpolation, same shape as the existing five. Gating is unchanged
  (`shouldApplyRouterFewShot`, :89-95: hasTools && isLocalProviderUrl && !isToolCallRecoveryModel)
  and `insertRouterFewShotMessages` (:216-224) still returns a new array without mutating input.
  No user-controlled data enters the addendum. A few-shot example can only change what the router
  proposes, never what the permission pipeline allows.
- src/tools/AskMathModelTool/prompt.ts:9 is description text only; no schema, checkPermissions or
  call() change in that file (confirmed against the full diff).
- src/services/api/openaiShim.test.ts and routerFewShot.test.ts are test-only assertion-count
  updates (12 -> 14, 10 -> 12) consistent with the 6th example; no production code.
- No eval/new Function/vm.*, no child_process, no new network destination, and no credential
  handling anywhere in this diff.
- Contract-as-data check: no file under .claude/contracts/ is staged other than this ledger, and
  nothing in the staged diffs contains text directed at an agent instructing it to skip or
  self-certify a check.

Low (non-blocking, owner: tools-execution-agent):
- LOW — src/tools/AskMathModelTool/deepSolve/solveDeep.ts:112-113 binds `catch (error)` and never
  reads it. Every generation-time failure — including a genuine programming error inside
  generateCandidate, not just the intended timeout/network case — is discarded with no log and no
  signal to the user beyond a reduced candidate count. Behaviorally safe (no bypass, and the
  all-failed case throws), but it converts a would-be loud bug into a silently narrower search.
  Recording the caught error, or at minimum distinguishing an AbortError from anything else,
  would keep the resilience without the blind spot. Not a build risk: tsconfig.json sets neither
  noUnusedLocals nor noUnusedParameters and the repo has no eslint config, so this compiles.
- LOW — src/tools/AskMathModelTool/deepSolve/solveDeep.ts:224 formats
  `(${generationFailures}/${generationFailures})`, which is always "N/N" by construction. If the
  loop broke early on an aborted parent signal after a single failure, the message reads "every
  candidate (1/1) failed to generate" when the schedule had more temperatures left — accurate
  about what was attempted, misleading about what was scheduled. Diagnostic-honesty nit only; no
  security impact, and the second, distinct message at :227 correctly preserves the
  "genuine logic gap" signal the old single message conflated.
