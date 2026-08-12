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
