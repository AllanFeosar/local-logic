#!/usr/bin/env node
// Provider-agnostic orchestrator. Copied into the target project as-is —
// all per-project variation lives in roster.json and providers.json, not
// in this file. Node builtins only, no install step.
//
// This script exists because harness-native hooks (Claude Code's
// SubagentStop/PreToolUse, Codex's hooks.json, Gemini CLI's hooks) are
// three incompatible mechanisms with no shared standard — but every CLI
// coding agent shares one thing: headless single-prompt execution that
// exits with a checkable status. Self-verification gating, security
// gating, and scheduled continuation are all implemented HERE, once,
// wrapping that universal contract — not as a harness-specific hook.
// See REFERENCE.md#provider-agnostic-orchestration for the reasoning.
//
// State lives under .agent-team/ (sibling to .claude/, not inside it —
// this script has no dependency on Claude Code being the active harness):
//   .agent-team/roster.json                    - agents: ownership, provider, self-verification, routing
//   .agent-team/providers.json                 - provider adapters: how to invoke each CLI headlessly
//   .agent-team/STATUS.md                      - resume anchor: queue + status log + blocked list
//   .agent-team/tentacles/<agent>/CONTEXT.md   - that agent's durable context (mirrors agent.md's body)
//   .agent-team/tentacles/<agent>/todo.md      - that agent's task queue, checkbox items
//   .agent-team/worktrees/<id>/                - git worktree isolation for a phase, when enabled
//   .claude/contracts/security-audit-log.md    - shared with the Claude-Code-native path, if it exists
//
// Commands:
//   node orchestrator.mjs run-phase              - one bounded phase, then stop (invoke this manually
//                                                   or from whatever external trigger you set up yourself —
//                                                   this script has no built-in scheduling of its own)
//   node orchestrator.mjs spawn <agent> "<task>" [--worktree]  - one ad hoc dispatch, foreground
//   node orchestrator.mjs status                 - print queue/status summary, no side effects
//   node orchestrator.mjs quota                  - print each configured provider's real quota
//                                                   reading (or why it couldn't get one), no side effects

import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileP = promisify(execFile);
const ROOT = process.cwd();
const TEAM_DIR = path.join(ROOT, ".agent-team");
const ROSTER_PATH = path.join(TEAM_DIR, "roster.json");
const PROVIDERS_PATH = path.join(TEAM_DIR, "providers.json");
const STATUS_PATH = path.join(TEAM_DIR, "STATUS.md");
const AUDIT_LOG_PATH = path.join(ROOT, ".claude", "contracts", "security-audit-log.md");

const SELF_VERIFY_ATTEMPT_BUDGET = 3;
const PHASE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min wall-clock cap per dispatch — the orchestrator
// owns the subprocess, so unlike a harness hook (which only fires on completion) it can actually
// kill a hung or looping worker instead of leaving it unrescuable. Tune per project.

// Staged quota thresholds — checked BEFORE a dispatch starts, not after. Below
// QUOTA_SOFT_THRESHOLD, dispatch freely. From SOFT to HARD is the "emergency"
// band: a new dispatch is still allowed to start (each dispatch is one atomic
// subprocess call — there's no way to let it use "2% more" mid-generation and
// then interrupt it), but it's logged so it's visible that headroom is thin.
// At or above QUOTA_HARD_THRESHOLD, no new token-consuming dispatch starts at
// all — the item is deferred until the window resets. This only ever gates
// invokeProvider; runSelfVerification, git operations, and everything else
// non-token-consuming is untouched at every tier, always.
const QUOTA_SOFT_THRESHOLD = 96;
const QUOTA_HARD_THRESHOLD = 98;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function trimOutput(text, maxLines = 60) {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return `… (${lines.length - maxLines} earlier lines trimmed) …\n` + lines.slice(-maxLines).join("\n");
}

function isTreeClean() {
  const { status, stdout } = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT });
  if (status !== 0) return { clean: false, reason: "git status failed" };
  return { clean: stdout.toString().trim() === "", reason: null };
}

function readStatusFile() {
  if (!fs.existsSync(STATUS_PATH)) {
    throw new Error(`${STATUS_PATH} not found — run the scaffold's Step (roster) generation first`);
  }
  return fs.readFileSync(STATUS_PATH, "utf8");
}

function writeStatusFile(content) {
  fs.writeFileSync(STATUS_PATH, content);
}

// Parses "- [ ] text" / "- [x] text" lines the same way Octogent's todo.md
// parser does — proven convention, not reinvented here. Each queue line may
// tag an explicit owner: "- [ ] [backend-agent] add refund endpoint".
//
// A blocked item stays "- [ ]" (markItemBlocked only appends an HTML
// comment, it never flips the checkbox — flipping it to [x] would make a
// failed dispatch look done) — so blocked-ness has to be tracked as its own
// flag, not inferred from the checkbox. Without this, nextQueueItem would
// hand the exact same blocked item back on every subsequent run-phase
// firing forever, burning the self-verification attempt budget again each
// time instead of waiting for a human to clear it, exactly the "Blocked"
// section's own contract in STATUS.md.
function parseQueue(statusContent) {
  const items = [];
  const lines = statusContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[( |x)\] (?:\[([a-z0-9-]+)\] )?(.+)$/i);
    if (m) {
      const blockedMatch = m[3].match(/^(.*?)\s*<!--\s*BLOCKED:.*-->\s*$/);
      items.push({
        lineIndex: i,
        done: m[1].toLowerCase() === "x",
        blocked: Boolean(blockedMatch),
        agent: m[2] || null,
        text: blockedMatch ? blockedMatch[1] : m[3],
      });
    }
  }
  return items;
}

function nextQueueItem(items) {
  return items.find((i) => !i.done && !i.blocked) || null;
}

function markItemDone(statusContent, lineIndex) {
  const lines = statusContent.split(/\r?\n/);
  lines[lineIndex] = lines[lineIndex].replace("[ ]", "[x]");
  return lines.join("\n");
}

function markItemBlocked(statusContent, lineIndex, reason) {
  const lines = statusContent.split(/\r?\n/);
  lines[lineIndex] = lines[lineIndex] + `  <!-- BLOCKED: ${reason.replace(/\n/g, " ")} -->`;
  return lines.join("\n");
}

function resolveAgent(roster, item) {
  if (item.agent) {
    const a = roster.agents.find((a) => a.name === item.agent);
    if (!a) throw new Error(`queue item tags unknown agent "${item.agent}"`);
    return a;
  }
  // Fall back to routing keyword match against each agent's `routing` list.
  const lower = item.text.toLowerCase();
  const match = roster.agents.find((a) => (a.routing || []).some((r) => lower.includes(r.toLowerCase())));
  if (!match) throw new Error(`no agent matches queue item and it has no [agent-name] tag: "${item.text}"`);
  return match;
}

function buildPrompt(agent, taskText, priorFailure) {
  const contextPath = path.join(TEAM_DIR, "tentacles", agent.name, "CONTEXT.md");
  const context = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, "utf8") : "";
  const parts = [
    context,
    `\n## Task\n${taskText}`,
    `\n## Completion criterion\nThe task is done when the change is made AND this command passes: \`${agent.selfVerification}\`. Run it yourself before finishing; the orchestrator re-checks it independently regardless.`,
    // This instruction exists because a headless worker is a full CLI session with real shell
    // access — unlike a Claude Code subagent, nothing structurally stops it from spawning another
    // agent process. See REFERENCE.md's headless-worker gotcha for why this can't be left implicit.
    `\n## Hard constraint\nDo not invoke this orchestrator, any other agent CLI, or any provider binary from within this session — no recursive dispatch, no spawning child agent processes, no shelling out to "claude", "codex", "gemini", or similar. Do the task's own file edits directly. If the task genuinely needs another agent's work, stop and report "NEEDS <agent-name>: <what's needed>" as your final output instead of trying to invoke it yourself.`,
  ];
  if (priorFailure) {
    parts.push(`\n## Previous attempt failed self-verification\n${trimOutput(priorFailure)}\nFix this and rerun the check yourself before finishing.`);
  }
  return parts.join("\n");
}

// The prompt travels over stdin, never as a CLI argument. Verified by real
// dispatch during this scaffold's own pilot: a multi-line prompt containing
// quotes/backticks, substituted into an argv string and run through
// `shell: true` (needed on Windows just to resolve an npm .cmd shim like
// claude.cmd), gets silently truncated/mangled by cmd.exe's own re-parsing
// — a much worse failure than the ENOENT it was fixing, because it's silent.
// Every provider checked documents stdin input for exactly this reason
// (`claude -p` — "useful for pipes"; `codex exec` — "read from stdin" when
// no PROMPT argument is given), so `providers.json`'s `args` carry only
// fixed flags, never a `{prompt}` placeholder — this function writes the
// prompt to the child's stdin directly, which isn't shell-parsed at all.
async function invokeProvider(providerName, providers, prompt, cwd) {
  const p = providers[providerName];
  if (!p) throw new Error(`no provider adapter named "${providerName}" in providers.json`);
  const MAX_BUFFER = 20 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(p.command, p.args, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PHASE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_BUFFER) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_BUFFER) stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve({ ok: true, output: stdout + stderr });
      } else {
        resolve({
          ok: false,
          output: (stdout + stderr) || `exited with code ${code}`,
          timedOut,
        });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// A provider usage-limit hit ("Claude AI usage limit reached. Your limit will
// reset at ...") looks like any other abnormal exit to invokeProvider — but
// treating it like one is wrong: dispatchOnce's normal retry loop fires again
// immediately with no delay, so all SELF_VERIFY_ATTEMPT_BUDGET attempts hit
// the same still-active limit within seconds and the item ends up BLOCKED —
// which nextQueueItem then skips forever, so the next scheduled run-phase
// firing (hours later, once the limit has actually reset) never retries it
// either. A human would have to notice and manually unblock the line. This
// check lets dispatchOnce recognize that case and stop immediately without
// spending an attempt or writing a blocked marker, so the item stays queued
// exactly as it was and the NEXT scheduled firing is a clean retry. Each
// provider's own usageLimitPatterns in providers.json drives this — see that
// file's usageLimitNote for why the patterns must be re-verified per CLI.
function isUsageLimitHit(providerName, providers, output) {
  const patterns = (providers[providerName] && providers[providerName].usageLimitPatterns) || [];
  return patterns.some((p) => new RegExp(p, "i").test(output));
}

// --- Proactive quota checks — real percentages, checked BEFORE a dispatch,
// not inferred after a refusal like isUsageLimitHit above. Every checker
// returns { reliable, percent, resetsAt, error } and NEVER throws — a
// checker that can't get a real number returns { reliable: false }, and
// dispatchOnce treats that exactly like having no check at all (fail open,
// same discipline as every other gate in this script). None of these log or
// persist the credentials they read — read once, used once, in memory only.

// Claude Code's own local OAuth token, read from the same credentials file
// the `claude` CLI itself uses — this isn't exfiltrating anything, it's
// calling Anthropic's own usage endpoint with the user's own valid token,
// locally, the same way third-party usage-tracking tools already do.
// Verified live against the real endpoint: returns an integer 0-100
// `utilization` for both the 5-hour session window and the 7-day window,
// plus a `severity` field Anthropic sets itself ("warning" observed at 76%).
// UNDOCUMENTED API — the `anthropic-beta` header is a versioned string that
// could be retired at any time; that's exactly why this fails open instead
// of hard-failing when the shape changes.
function readClaudeCodeToken() {
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (!fs.existsSync(credPath)) return null;
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
    return (creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || null;
  } catch {
    return null;
  }
}

function checkQuotaClaudeCode() {
  return new Promise((resolve) => {
    const token = readClaudeCodeToken();
    if (!token) return resolve({ reliable: false, error: "no local Claude Code credentials found" });
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode !== 200 || !data.five_hour || typeof data.five_hour.utilization !== "number") {
              return resolve({ reliable: false, error: `unexpected usage-endpoint response (status ${res.statusCode})` });
            }
            resolve({
              reliable: true,
              percent: data.five_hour.utilization,
              resetsAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : null,
            });
          } catch {
            resolve({ reliable: false, error: "could not parse usage-endpoint response" });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ reliable: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ reliable: false, error: "usage-endpoint request timed out" });
    });
    req.end();
  });
}

// Codex's app-server JSON-RPC interface — its own IDE-integration surface,
// not a stable public contract either, but more official-feeling than
// Claude Code's endpoint above. Requires an `initialize` handshake before
// any other method responds (verified live: calling account/rateLimits/read
// first returns a bare "Not initialized" error). Verified live end to end:
// initialize succeeds, then account/rateLimits/read returns an integer
// usedPercent and a unix-seconds resetsAt for the account's primary window.
function checkQuotaCodex() {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already exited — nothing to clean up
      }
      resolve(result);
    };
    try {
      child = spawn("codex", ["app-server"], { shell: true });
    } catch (e) {
      return resolve({ reliable: false, error: e.message });
    }
    let buf = "";
    let initialized = false;
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && !initialized) {
          initialized = true;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n");
        } else if (msg.id === 2) {
          const primary = msg.result && msg.result.rateLimits && msg.result.rateLimits.primary;
          if (primary && typeof primary.usedPercent === "number") {
            done({
              reliable: true,
              percent: primary.usedPercent,
              resetsAt: primary.resetsAt ? primary.resetsAt * 1000 : null,
            });
          } else {
            done({ reliable: false, error: "unexpected rateLimits response shape" });
          }
        }
      }
    });
    child.on("error", (e) => done({ reliable: false, error: e.message }));
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agent-team-scaffold", version: "1.0.0" } } }) + "\n"
    );
    setTimeout(() => done({ reliable: false, error: "codex app-server timed out" }), 10000);
  });
}

// Gemini CLI has no documented quota-check interface at all, official or
// otherwise (confirmed against Gemini CLI's own issue tracker) — there is
// nothing real to query. This always returns unreliable, on purpose, rather
// than fabricate a percentage from an unrelated proxy (e.g. counting local
// session files) and presenting a guess as if it were a measurement.
function checkQuotaGemini() {
  return Promise.resolve({ reliable: false, error: "Gemini CLI exposes no quota interface to check" });
}

const QUOTA_CHECKERS = { claude: checkQuotaClaudeCode, codex: checkQuotaCodex, gemini: checkQuotaGemini };

async function checkQuota(providerName) {
  const checker = QUOTA_CHECKERS[providerName];
  if (!checker) return { reliable: false, error: `no quota checker registered for provider "${providerName}"` };
  try {
    return await checker();
  } catch (e) {
    return { reliable: false, error: e.message };
  }
}

// Self-verification commands are project-authored, and which shell they
// need is genuinely bimodal — not something to keep guessing at with one
// hardcoded default. POSIX-style commands (`vendor/bin/phpunit`,
// `./node_modules/.bin/jest`) need bash: cmd.exe reports "'vendor' is not
// recognized", splitting on the slash instead of resolving the path
// (verified live). Windows-native tools using single-slash flag syntax
// (MSBuild, csc.exe, devenv.exe) need cmd.exe instead: bash's own MSYS
// path-conversion silently mangles a leading "/" on any argument that
// looks like a Unix path, turning `/p:Configuration=Debug` into
// `p:Configuration=Debug` and producing a confusing MSBuild error instead
// of a clean failure (also verified live, against a real .NET Framework
// solution — the exact same command that fails through bash builds clean
// through cmd.exe). Default to bash on win32 since POSIX-style commands are
// the more common case across this scaffold's own worked examples, but let
// an agent override it per `roster.json`'s optional `"shell"` field
// ("cmd" or "bash") when its own tooling needs the other one — see
// roster.json.template.
function runSelfVerification(command, cwd, shellOverride) {
  const preferCmd = shellOverride === "cmd";
  const preferBash = shellOverride === "bash" || (!shellOverride && process.platform === "win32");
  const shell = preferCmd ? true : preferBash ? "bash" : true;
  let res = spawnSync(command, { cwd, shell, encoding: "utf8" });
  if (preferBash && res.error && res.error.code === "ENOENT") {
    // bash itself isn't on PATH — fall back to cmd.exe rather than fail outright.
    res = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  }
  return { pass: res.status === 0, output: (res.stdout || "") + (res.stderr || "") };
}

function securityGateOk(agentTouchesSensitivePaths, roster) {
  if (!agentTouchesSensitivePaths || !roster.securityAgent) return true;
  if (!fs.existsSync(AUDIT_LOG_PATH)) return false;
  // Same rule as the PreToolUse hook this replaces: the ledger's latest entry must exist and
  // name the changed files — checked here at the merge boundary, the same way the Claude-Code
  // hook checked it at commit time, so both paths enforce an identical rule.
  const log = fs.readFileSync(AUDIT_LOG_PATH, "utf8");
  return log.trim().length > 0; // scaffold fills in the real per-project match rule (step 7)
}

// Two-pass blind replace (** -> .*, then * -> [^/]*) corrupts itself: the
// first pass's own output contains literal "*" characters that the second
// pass then re-matches and mangles. A placeholder protects "**" through
// both passes instead — "@@" is plain text, never produced by either regex
// pass, so it survives untouched until the final swap. Also escapes regex
// metacharacters (a literal "." in a path glob must not become "match any
// character") and anchors the pattern so "auth" can't match as a substring
// of "authors/file.py".
function globToRegex(glob) {
  const PLACEHOLDER = "@@";
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withGlobstar = escaped.split("**").join(PLACEHOLDER);
  const withStar = withGlobstar.replace(/\*/g, "[^/]*");
  const final = withStar.split(PLACEHOLDER).join(".*");
  return new RegExp(`^${final}$`);
}

function touchesSensitivePaths(cwd, roster) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  const files = res.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
  const patterns = (roster.securitySensitivePaths || []).map(globToRegex);
  return files.some((f) => patterns.some((re) => re.test(f)));
}

async function dispatchOnce(agent, taskText, providers, roster, { worktree } = {}) {
  // Checked before anything else — including before creating a worktree for
  // this dispatch — so a deferred item never pays the cost of setup work
  // it's not going to use. A quota check failing (reliable: false) is not a
  // reason to block; it's treated exactly like no check happened.
  const quota = await checkQuota(agent.provider);
  if (quota.reliable && quota.percent >= QUOTA_HARD_THRESHOLD) {
    const resetNote = quota.resetsAt ? ` — resets ~${new Date(quota.resetsAt).toISOString()}` : "";
    return {
      pass: false,
      deferred: true,
      blocked: `${agent.provider} usage at ${quota.percent}% (>= ${QUOTA_HARD_THRESHOLD}% hard limit)${resetNote} — deferring, no new token-consuming dispatch starts until the window resets`,
      cwd: ROOT,
      branch: null,
    };
  }
  if (quota.reliable && quota.percent >= QUOTA_SOFT_THRESHOLD) {
    console.log(`orchestrator: ${agent.provider} usage at ${quota.percent}% — inside the ${QUOTA_SOFT_THRESHOLD}-${QUOTA_HARD_THRESHOLD}% emergency band, proceeding anyway`);
  }

  let cwd = ROOT;
  let branch = null;
  if (worktree || agent.worktree) {
    const id = `${agent.name}-${Date.now()}`;
    branch = `team/${id}`;
    cwd = path.join(TEAM_DIR, "worktrees", id);
    fs.mkdirSync(path.dirname(cwd), { recursive: true });
    await execFileP("git", ["worktree", "add", cwd, "-b", branch], { cwd: ROOT });
    if (agent.setupCommand) {
      // A fresh worktree only has tracked files — gitignored dependency
      // directories (vendor/, node_modules/) don't exist until something
      // installs them here. Verified live: a Composer project's self-
      // verification failed with "no such file or directory" for
      // vendor/bin/phpunit in a brand-new worktree until this ran once.
      const setup = runSelfVerification(agent.setupCommand, cwd, agent.shell);
      if (!setup.pass) {
        return { pass: false, blocked: `worktree setup command failed:\n${trimOutput(setup.output)}`, cwd, branch };
      }
    }
  }

  let priorFailure = null;
  for (let attempt = 1; attempt <= SELF_VERIFY_ATTEMPT_BUDGET; attempt++) {
    const prompt = buildPrompt(agent, taskText, priorFailure);
    const result = await invokeProvider(agent.provider, providers, prompt, cwd);
    if (isUsageLimitHit(agent.provider, providers, result.output)) {
      return {
        pass: false,
        deferred: true,
        blocked: `${agent.provider} usage limit reached — deferring to the next scheduled firing instead of burning a self-verification attempt:\n${trimOutput(result.output)}`,
        cwd,
        branch,
      };
    }
    if (!result.ok) {
      priorFailure = `Provider exited abnormally${result.timedOut ? " (timed out — possible stuck/looping worker, killed)" : ""}:\n${result.output}`;
      continue;
    }
    const check = runSelfVerification(agent.selfVerification, cwd, agent.shell);
    if (check.pass) {
      if (touchesSensitivePaths(cwd, roster) && !securityGateOk(true, roster)) {
        return { pass: false, blocked: "security-audit-log.md has no entry for these changes — dispatch the security agent before this can merge", cwd, branch };
      }
      return { pass: true, cwd, branch, attempts: attempt };
    }
    priorFailure = check.output;
  }
  return { pass: false, blocked: `self-verification failed after ${SELF_VERIFY_ATTEMPT_BUDGET} attempts:\n${trimOutput(priorFailure)}`, cwd, branch };
}

async function mergeIfNeeded(result) {
  if (!result.branch) return; // shared-workspace mode: worker committed directly, nothing to merge
  await execFileP("git", ["merge", "--no-ff", result.branch], { cwd: ROOT });
  await execFileP("git", ["worktree", "remove", result.cwd, "--force"], { cwd: ROOT });
}

async function runPhase() {
  const { clean, reason } = isTreeClean();
  if (!clean) {
    console.log(`orchestrator: dirty tree (${reason || "uncommitted changes"}) — a live session or a prior run is mid-phase, skipping this firing`);
    return;
  }
  const roster = readJson(ROSTER_PATH);
  const providers = readJson(PROVIDERS_PATH);
  const statusContent = readStatusFile();
  const items = parseQueue(statusContent);
  const item = nextQueueItem(items);
  if (!item) {
    console.log("orchestrator: queue empty, nothing to do");
    return;
  }
  const agent = resolveAgent(roster, item);
  console.log(`orchestrator: dispatching ${agent.name} (${agent.provider}) on: ${item.text}`);
  const result = await dispatchOnce(agent, item.text, providers, roster);
  if (result.pass) {
    await mergeIfNeeded(result);
    writeStatusFile(markItemDone(statusContent, item.lineIndex));
    console.log(`orchestrator: done in ${result.attempts} attempt(s)`);
  } else if (result.deferred) {
    // STATUS.md is intentionally left untouched — same item, same unblocked
    // state, so the next scheduled firing picks it up as a fresh attempt.
    console.log(`orchestrator: deferred — ${result.blocked}`);
  } else {
    writeStatusFile(markItemBlocked(statusContent, item.lineIndex, result.blocked));
    console.log(`orchestrator: blocked — ${result.blocked}`);
  }
  // One phase per firing, then stop — never let one unattended run try to clear the whole queue.
}

async function spawnAdHoc(agentName, taskText, opts) {
  const roster = readJson(ROSTER_PATH);
  const providers = readJson(PROVIDERS_PATH);
  const agent = roster.agents.find((a) => a.name === agentName);
  if (!agent) throw new Error(`unknown agent "${agentName}" — check roster.json`);
  const result = await dispatchOnce(agent, taskText, providers, roster, opts);
  if (result.pass) {
    if (opts.noMerge) {
      console.log(`spawn: ${agentName} done in ${result.attempts} attempt(s) — --no-merge set, worktree preserved at ${result.cwd} on branch ${result.branch} for inspection, not merged`);
    } else {
      await mergeIfNeeded(result);
      console.log(`spawn: ${agentName} done in ${result.attempts} attempt(s)`);
    }
  } else if (result.deferred) {
    console.log(`spawn: ${agentName} deferred — ${result.blocked}`);
    if (result.branch) console.log(`worktree preserved at ${result.cwd} for inspection (not merged)`);
  } else {
    console.log(`spawn: ${agentName} blocked — ${result.blocked}`);
    if (result.branch) console.log(`worktree preserved at ${result.cwd} for inspection (not merged)`);
  }
}

function printStatus() {
  const roster = readJson(ROSTER_PATH);
  const items = parseQueue(readStatusFile());
  const done = items.filter((i) => i.done).length;
  console.log(`${done}/${items.length} queue items done`);
  for (const i of items) {
    const mark = i.done ? "x" : i.blocked ? "!" : " ";
    console.log(`  [${mark}] ${i.agent ? `(${i.agent}) ` : ""}${i.text}`);
  }
  console.log(`agents: ${roster.agents.map((a) => `${a.name}(${a.provider})`).join(", ")}`);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "run-phase") {
  await runPhase();
} else if (cmd === "spawn") {
  const worktree = rest.includes("--worktree") || rest.includes("--no-merge");
  const noMerge = rest.includes("--no-merge");
  const [agentName, taskText] = rest.filter((a) => a !== "--worktree" && a !== "--no-merge");
  if (!agentName || !taskText) {
    console.error('usage: orchestrator.mjs spawn <agent-name> "<task text>" [--worktree] [--no-merge]');
    process.exit(1);
  }
  await spawnAdHoc(agentName, taskText, { worktree, noMerge });
} else if (cmd === "status") {
  printStatus();
} else if (cmd === "quota") {
  const providers = readJson(PROVIDERS_PATH);
  for (const name of Object.keys(providers)) {
    if (name.startsWith("_")) continue; // skip _comment / _extension_pattern entries
    const q = await checkQuota(name);
    if (q.reliable) {
      const resetNote = q.resetsAt ? `, resets ${new Date(q.resetsAt).toISOString()}` : "";
      const band = q.percent >= QUOTA_HARD_THRESHOLD ? "HARD LIMIT" : q.percent >= QUOTA_SOFT_THRESHOLD ? "emergency band" : "normal";
      console.log(`${name}: ${q.percent}% (${band})${resetNote}`);
    } else {
      console.log(`${name}: unknown — ${q.error}`);
    }
  }
} else {
  console.error("usage: orchestrator.mjs run-phase | spawn <agent> \"<task>\" [--worktree] | status | quota");
  process.exit(1);
}
