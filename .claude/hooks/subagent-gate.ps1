# SubagentStop gate: when a subagent finishes, run the self-verification check
# for whichever layer(s) it touched. Exit 2 sends the subagent back with the
# failure output; exit 0 lets the result through.
# FAIL OPEN: any environment problem (tool missing, git broken, deps not
# installed) exits 0 — a gate that blocks every subagent because bun isn't on
# PATH is worse than no gate. security-audit-agent has no block here — it has
# no Write/Edit tools, so it never produces a diff for this gate to check.
#
# CIRCUIT BREAKER (added 2026-08-11, after a real incident): this gate's
# scoping via `git status --porcelain` assumed the tree was clean before each
# subagent started. It wasn't — the initial scaffold commit was held back
# pending confirmation, leaving ~2,081 files staged repo-wide. Every
# graphify-extraction subagent since then tripped tui-agent's tsc --noEmit
# check regardless of what it actually touched, and looped 7 times against
# an identical message, burning an entire session's usage window. GateFailBudget
# stops that: after 3 consecutive identical failures, the gate fails OPEN
# instead of blocking again.
#
# TSC BASELINE COMPARISON (added 2026-08-12, after this circuit breaker fired
# repeatedly across at least 5 independent subagent dispatches — every one
# individually diagnosed and reported the same root cause: this fork carries
# a large pre-existing `tsc --noEmit` error baseline, documented across
# LOCAL_AI_STATUS.md sessions 1/3/5/6/7, that has nothing to do with any
# given subagent's own diff. `tsc --noEmit`'s exit code is nonzero for *any*
# error count > 0, so gating on exit code alone fails unconditionally for
# every subagent touching tui/commands-skills/provider-router/tools-execution
# territory regardless of what they changed — every one of those 5 dispatches
# correctly declined to "fix" thousands of unrelated errors across files they
# don't own, exactly as their own operating rules require, then burned their
# full GateFailBudget proving it before failing open. That's working as
# designed but wasteful: it trains every agent to spend real reasoning
# disproving a false positive instead of doing their actual task.
# Get-TscErrorCount below counts total `error TS` lines instead of trusting
# the exit code, and Test-TscRegression only fails the gate if the count
# *increased* past $TscBaseline — i.e. only on an actual new error, which is
# the thing this gate should have been checking all along. $TscBaseline must
# be updated (down, ideally) whenever someone deliberately restores/fixes
# baseline errors — see LOCAL_AI_STATUS.md's "restored 11 missing type/stub
# files" entry for how the 4130 -> 3521 drop this number reflects happened.
# Bumping it up to silence a real new regression instead of fixing the
# regression defeats the whole point — only lower it after confirming a
# genuine reduction, the same way that entry did.
$ErrorActionPreference = 'Continue'
$GateStatePath = Join-Path $PSScriptRoot '.subagent-gate-state.json'
$GateFailBudget = 3
$TscBaseline = 3521

function Get-TscErrorCount([string]$tscOutput) {
    $matches = [regex]::Matches($tscOutput, 'error TS\d+')
    return $matches.Count
}

# Returns $null if no regression (gate should pass), or a message string if
# there is one (gate should fail with that message). Runs tsc exactly once
# and reports the count either way, so a passing run's real error count is
# visible in the transcript even though it doesn't block anything.
# NOTE: deliberately uses [Console]::Out.WriteLine, not Write-Output, for the
# informational line below — PowerShell functions return their entire output
# stream, not just the value passed to `return`, so a Write-Output call ahead
# of `return $null` here would silently turn the "no regression" case into a
# two-element array (the message, then $null) instead of a clean $null,
# which callers' `if ($tscFail)` checks would then treat as truthy. Caught by
# testing this function directly against the live repo before trusting it.
function Test-TscRegression {
    $out = cmd /c "npx tsc --noEmit 2>&1"
    $count = Get-TscErrorCount ($out -join "`n")
    if ($count -gt $TscBaseline) {
        return "tsc --noEmit: $count errors, up from the documented baseline of $TscBaseline (+$($count - $TscBaseline)) — this diff introduced new type errors.`n$($out -join "`n")"
    }
    [Console]::Out.WriteLine("subagent-gate: tsc --noEmit: $count errors (baseline $TscBaseline) — no regression, passing.")
    return $null
}

function Get-GateState {
    if (Test-Path $GateStatePath) {
        try { return (Get-Content $GateStatePath -Raw | ConvertFrom-Json) } catch { return New-Object PSObject }
    }
    return New-Object PSObject
}

function Get-GateCount($state, [string]$check) {
    $prop = $state.PSObject.Properties[$check]
    if ($prop) { return [int]$prop.Value }
    return 0
}

function Set-GateCount($state, [string]$check, [int]$value) {
    if ($state.PSObject.Properties[$check]) { $state.$check = $value }
    else { $state | Add-Member -MemberType NoteProperty -Name $check -Value $value -Force }
}

function Save-GateState($state) {
    try { $state | ConvertTo-Json | Set-Content $GateStatePath } catch { }
}

function Fail-Open([string]$msg) {
    Write-Output "subagent-gate: $msg (fail-open, letting result through)"
    exit 0
}

function Fail-Gate([string]$check, [string]$output) {
    $state = Get-GateState
    $count = (Get-GateCount $state $check) + 1

    if ($count -ge $GateFailBudget) {
        Write-Output "subagent-gate: '$check' has failed $count times in a row - circuit breaker tripped, failing OPEN rather than loop again. Commit the pending diff so git status reflects only real per-subagent changes."
        Set-GateCount $state $check 0
        Save-GateState $state
        exit 0
    }
    Set-GateCount $state $check $count
    Save-GateState $state

    # Trim to the last 60 lines so the subagent gets the errors, not a wall of text
    $lines = $output -split "`r?`n"
    if ($lines.Count -gt 60) { $lines = $lines[-60..-1] }
    [Console]::Error.WriteLine("Self-verification gate failed: $check (attempt $count of $GateFailBudget before this fails open)")
    [Console]::Error.WriteLine(($lines -join "`n"))
    [Console]::Error.WriteLine("Fix the failures above and rerun the check before reporting done.")
    exit 2
}

$porcelain = cmd /c "git status --porcelain 2>nul"
if ($LASTEXITCODE -ne 0) { Fail-Open "git status failed (no git repo, or git not on PATH)" }
if (-not $porcelain) { exit 0 }

$files = @($porcelain) | ForEach-Object {
    $p = $_.Substring(3)
    if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }   # renames: keep new path
    $p.Trim('"')
}

$bunOnPath = (cmd /c "where bun 2>nul")
$nodeModulesPresent = Test-Path 'node_modules'

# --- tui-agent ---
$tuiChanged = $files | Where-Object { $_ -match '^src/(components|ink|screens|hooks|keybindings|vim|context|state|buddy|assistant|moreright|outputStyles|entrypoints)/' -or $_ -match '^src/(ink\.ts|main\.tsx|dialogLaunchers\.tsx|replLauncher\.tsx|interactiveHelpers\.tsx|setup\.ts|projectOnboardingState\.ts|history\.ts)$' }
if ($tuiChanged) {
    if (-not $bunOnPath) { Fail-Open "bun not on PATH" }
    if (-not $nodeModulesPresent) { Fail-Open "node_modules missing — run bun install" }
    $tscFail = Test-TscRegression
    if ($tscFail) { Fail-Gate "tui-agent: tsc --noEmit" $tscFail }
    $out = cmd /c "bun test src/components/**/*.test.ts* src/ink/**/*.test.ts 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail-Gate "tui-agent: bun test" ($out -join "`n") }
}

# --- commands-skills-agent ---
$commandsChanged = $files | Where-Object { $_ -match '^src/(commands|skills|plugins)/' -or $_ -match '^src/commands\.ts$' -or $_ -match '^src/utils/(skills|plugins|git|github|suggestions|processUserInput)/' }
if ($commandsChanged) {
    if (-not $bunOnPath) { Fail-Open "bun not on PATH" }
    if (-not $nodeModulesPresent) { Fail-Open "node_modules missing — run bun install" }
    $tscFail = Test-TscRegression
    if ($tscFail) { Fail-Gate "commands-skills-agent: tsc --noEmit" $tscFail }
    $out = cmd /c "bun test src/commands/**/*.test.ts* src/skills/**/*.test.ts 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail-Gate "commands-skills-agent: bun test" ($out -join "`n") }
}

# --- provider-router-agent ---
$providerChanged = $files | Where-Object { $_ -match '^src/(services|upstreamproxy|coordinator|memdir|migrations|types|constants|schemas|config|voice|bootstrap)/' -or $_ -match '^src/(QueryEngine|query|context|cost-tracker|costHook)\.ts$' -or $_ -match '^src/utils/(mcp|model|settings)/' -or $_ -match '^scripts/provider-' }
if ($providerChanged) {
    if (-not $bunOnPath) { Fail-Open "bun not on PATH" }
    if (-not $nodeModulesPresent) { Fail-Open "node_modules missing — run bun install" }
    $out = cmd /c "bun run test:provider 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail-Gate "provider-router-agent: test:provider" ($out -join "`n") }
    $tscFail = Test-TscRegression
    if ($tscFail) { Fail-Gate "provider-router-agent: tsc --noEmit" $tscFail }
}

# --- tools-execution-agent ---
$toolsChanged = $files | Where-Object { $_ -match '^src/(tools|tasks|bridge|remote|server)/' -or $_ -match '^src/(Tool|tools|Task|tasks)\.ts$' -or $_ -match '^src/utils/(task|swarm|ultraplan|background|todo|permissions|sandbox|bash|shell|powershell|computerUse|claudeInChrome|teleport|hooks|secureStorage|filePersistence)/' -or $_ -match '^src/schemas/hooks\.ts$' }
if ($toolsChanged) {
    if (-not $bunOnPath) { Fail-Open "bun not on PATH" }
    if (-not $nodeModulesPresent) { Fail-Open "node_modules missing — run bun install" }
    $tscFail = Test-TscRegression
    if ($tscFail) { Fail-Gate "tools-execution-agent: tsc --noEmit" $tscFail }
    $out = cmd /c "bun test src/tools src/services/tools src/bridge src/utils/promptShellExecution.test.ts src/utils/ripgrep.test.ts 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail-Gate "tools-execution-agent: bun test" ($out -join "`n") }
}

# --- python-bridge-agent ---
$pyChanged = $files | Where-Object { $_ -match '^python-bridge/' }
if ($pyChanged) {
    $pyOnPath = (cmd /c "where python 2>nul")
    if (-not $pyOnPath) { $pyOnPath = (cmd /c "where py 2>nul") }
    if (-not $pyOnPath) { Fail-Open "python/py not on PATH" }
    # NOTE (2026-08-13): was `python -m py_compile server.py local_models/*.py`.
    # py_compile does not glob-expand its own argv, and cmd.exe (invoked via
    # `cmd /c` here) doesn't expand `*` for arbitrary commands either — the
    # glob reached py_compile as a literal string, failing every time with
    # "[Errno 22] Invalid argument: 'local_models/*.py'" regardless of what
    # any subagent actually changed. Reproduced directly, confirmed via a
    # real syntax error that `compileall` (which walks a directory itself,
    # no shell-side glob needed) still correctly fails with exit code 1 on.
    Push-Location python-bridge
    $out = cmd /c "python -m compileall -q server.py local_models 2>&1"
    if ($LASTEXITCODE -eq 9009) { $out = cmd /c "py -m compileall -q server.py local_models 2>&1" }
    Pop-Location
    if ($LASTEXITCODE -ne 0) { Fail-Gate "python-bridge-agent: py_compile" ($out -join "`n") }
}

# --- vscode-extension-agent ---
$vscodeChanged = $files | Where-Object { $_ -match '^vscode-extension/openclaude-vscode/' }
if ($vscodeChanged) {
    if (-not (Test-Path 'vscode-extension/openclaude-vscode/node_modules') -and -not (cmd /c "where npm 2>nul")) { Fail-Open "npm not on PATH" }
    Push-Location vscode-extension/openclaude-vscode
    $out = cmd /c "npm test 2>&1"
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Fail-Gate "vscode-extension-agent: npm test" ($out -join "`n") }
}

# --- build-release-agent ---
$buildChanged = $files | Where-Object { $_ -match '^scripts/(build|no-telemetry-plugin|system-check)\.ts$' -or $_ -match '^bin/' -or $_ -eq 'tsconfig.json' -or $_ -eq 'package.json' -or $_ -match '^src/(native-ts|utils/nativeInstaller|utils/dxt|utils/telemetry|utils/deepLink)/' }
if ($buildChanged) {
    if (-not $bunOnPath) { Fail-Open "bun not on PATH" }
    $out = cmd /c "bun run smoke 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail-Gate "build-release-agent: smoke" ($out -join "`n") }
}

exit 0
