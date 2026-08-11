# PreToolUse gate on Bash: blocks `git commit` / `git push` when staged
# security-sensitive files (tools, sandbox, permissions, bridge/remote
# permission relay, oauth, secureStorage) have no matching entry in the
# security-audit-log ledger. Exit 2 blocks the command and returns the
# message to the agent; exit 0 lets it through.
# The verdict must be TIED TO THIS EXACT DIFF, not just "an audit happened
# recently" — so this checks that the ledger file itself is staged in the
# same commit AND that its new entry names every sensitive file, not just
# that security-audit-agent ran at some point.
# FAIL OPEN: any environment problem exits 0 — this gate should never be the
# reason a legitimate commit can't land.
$ErrorActionPreference = 'Continue'

function Fail-Open([string]$msg) {
    Write-Output "security-gate: $msg (fail-open, letting the command through)"
    exit 0
}

function Fail-Gate([string]$msg) {
    [Console]::Error.WriteLine("Security gate blocked this commit: $msg")
    [Console]::Error.WriteLine("Dispatch security-audit-agent to audit the files above, have it append a .claude/contracts/security-audit-log.md entry naming them, then retry.")
    exit 2
}

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch { Fail-Open "could not parse hook input" }

$cmd = $payload.tool_input.command
if (-not $cmd) { exit 0 }
if ($cmd -notmatch 'git\s+(commit|push)') { exit 0 }

$staged = cmd /c "git diff --cached --name-only 2>nul"
if ($LASTEXITCODE -ne 0) { Fail-Open "git diff failed (no git repo, or git not on PATH)" }
if (-not $staged) { exit 0 }

# Matches roster.json's securitySensitivePaths — keep both in sync.
$sensitivePattern = '^src/tools/|^src/utils/(permissions|sandbox|bash|shell|powershell|computerUse|claudeInChrome|teleport|secureStorage)/|^src/bridge/|^src/remote/|^src/services/oauth/|^src/services/mcp/auth\.ts$|^src/utils/settings/permissionValidation\.ts$'
$sensitive = @($staged) | Where-Object { $_ -match $sensitivePattern }
if (-not $sensitive) { exit 0 }

$ledgerPath = '.claude/contracts/security-audit-log.md'
if (-not (Test-Path $ledgerPath)) {
    Fail-Gate "security-sensitive files staged ($($sensitive -join ', ')) but $ledgerPath does not exist yet"
}

$ledgerStaged = @($staged) | Where-Object { $_ -eq $ledgerPath }
if (-not $ledgerStaged) {
    Fail-Gate "security-sensitive files staged ($($sensitive -join ', ')) but no new $ledgerPath entry is staged in this commit"
}

$ledgerDiff = (cmd /c "git diff --cached -- `"$ledgerPath`" 2>nul") -join "`n"
# $ledgerDiff must be a single joined string here, not the raw line array cmd
# returns: -notmatch against a multi-line array filters element-by-element and
# returns a (nearly always non-empty, i.e. truthy) subset, not a real boolean
# "is this substring present anywhere" check.
$missing = @($sensitive) | Where-Object { $ledgerDiff -notmatch [regex]::Escape($_) }
if ($missing) {
    Fail-Gate "these security-sensitive files aren't named in the new $ledgerPath entry: $($missing -join ', ')"
}

exit 0
