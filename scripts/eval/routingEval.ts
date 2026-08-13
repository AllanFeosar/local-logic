// @ts-nocheck
/**
 * Routing eval — does the router pick the right tool?
 *
 * This is the instrument LOCAL_AI_MASTER_PLAN.md §6/§8 calls for and didn't
 * have before: scripts/eval/specialistEval.ts already proves each specialist
 * tool (AskMathModel, DocumentQA, ImageCaption) works correctly *once
 * invoked*. Nothing measured whether the router (qwen3:1.7b via Ollama,
 * driving the actual CLI) *chooses* the right tool in the first place —
 * which is exactly the failure session 2 found live: a hallucinated call to
 * a nonexistent "math" skill instead of the real AskMathModel tool sitting
 * in its own tool list.
 *
 * This harness drives the real, compiled CLI end-to-end (`node bin/openclaude
 * -p "<prompt>" --output-format stream-json --verbose`) for each fixed
 * prompt in routingCases.ts, and inspects the JSONL transcript for the
 * router's *first* tool_use block. It does NOT wait for the delegated
 * specialist to finish (which can take 15s-5min for AskMathModel) — as soon
 * as the router's own tool choice is visible in the stream, the case is
 * scored and the child process is killed. This keeps a 20-case run fast
 * (seconds, not minutes) since only the router's own decision matters here.
 *
 * Scoring is purely "did the router pick the right tool (or correctly pick
 * none)" — independent of whether the specialist's eventual answer would
 * have been correct; that's specialistEval.ts's job.
 *
 * Quick start:
 *
 *   bun run scripts/eval/routingEval.ts
 *   bun run scripts/eval/routingEval.ts --case routing-math-1
 *   bun run scripts/eval/routingEval.ts --out-dir reports --no-report
 *   bun run scripts/eval/routingEval.ts --split holdout
 *   bun run scripts/eval/routingEval.ts --split holdout --runs 3
 *
 * **`--split tuning|holdout`** (added session 17/18 — see routingCases.ts's
 * own header comment for the full rationale): filters the case set to just
 * the original 20 "tuning" cases or the 30 new "holdout" cases. Omit to run
 * the full 50-case set (both splits combined).
 *
 * **`--runs N`** (default 1, added session 17/18 — LOCAL_AI_MASTER_PLAN.md
 * §6 "Fix the ruler before chasing the last points"): runs the selected
 * case set N times and reports **mean ± std** across runs instead of a
 * single-run score, matching BFCL's own "≥3 trials, don't trust one run"
 * methodology. Each run gets its own printed summary; N>1 additionally
 * prints/writes a combined mean±std summary. A single run's score at 20-50
 * cases is worth too few points to distinguish "85% vs 90%" from ordinary
 * sampling-temperature noise — this is the actual "fix the ruler" mechanism,
 * not just more cases.
 *
 * IMPORTANT — this makes LIVE calls to Ollama (http://127.0.0.1:11434) via
 * the real CLI. It never calls a paid cloud provider (the .openclaude-profile.json
 * ollama profile drives every invocation). Requires CLAUDE_CODE_GIT_BASH_PATH
 * to be set for `node bin/openclaude` to run on Windows (falls back to this
 * environment's known git-bash path below if unset — override via env var on
 * any other machine). Requires `bun run build` to have been run recently —
 * this exercises dist/cli.mjs, not live src/.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routingCases, type ExpectedTool, type RoutingCase, type RoutingSplit } from './routingCases.ts'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
// This environment's known git-bash location (see LOCAL_AI_STATUS.md /
// LOCAL_AI_MASTER_PLAN.md) — only used as a fallback when the env var isn't
// already set, so this stays portable to other machines/CI.
const FALLBACK_GIT_BASH_PATH = 'E:\\Tools\\Git\\bin\\bash.exe'
const DEFAULT_CASE_TIMEOUT_MS = 45_000

type RunResult = {
  actualTool: string | null
  actualInput: unknown
  registeredTools: string[] | null
  timedOut: boolean
  erroredMessage: string | null
  durationMs: number
}

type Classification =
  | 'correct'
  | 'no-tool-called'
  | 'wrong-tool'
  | 'hallucinated-tool'
  | 'over-delegation'
  | 'run-error'

type ResultRow = {
  case: RoutingCase
  run: RunResult
  classification: Classification
}

function classify(expected: ExpectedTool, run: RunResult): Classification {
  if (run.timedOut || run.erroredMessage) return 'run-error'

  const actual = run.actualTool
  if (actual === null) {
    return expected === null ? 'correct' : 'no-tool-called'
  }

  if (run.registeredTools && !run.registeredTools.includes(actual)) {
    return 'hallucinated-tool'
  }

  if (expected === null) {
    return 'over-delegation'
  }

  return actual === expected ? 'correct' : 'wrong-tool'
}

/**
 * Runs one routing case against the real CLI, reading the stream-json
 * transcript line by line. Stops (and kills the child) as soon as either:
 *   - an assistant message contains a tool_use block (the router's decision), or
 *   - a "result" event arrives with no tool_use having been seen (no tool called).
 */
function runRoutingCase(
  prompt: string,
  env: NodeJS.ProcessEnv,
  caseTimeoutMs: number = DEFAULT_CASE_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const start = Date.now()
    let settled = false
    let buffer = ''
    let registeredTools: string[] | null = null

    const child = spawn(
      'node',
      ['bin/openclaude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', '3'],
      { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    const finish = (result: Omit<RunResult, 'durationMs'>) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      try {
        child.kill()
      } catch {
        // best-effort — process may have already exited
      }
      resolvePromise({ ...result, durationMs: Date.now() - start })
    }

    const timeoutHandle = setTimeout(() => {
      finish({
        actualTool: null,
        actualInput: null,
        registeredTools,
        timedOut: true,
        erroredMessage: null,
      })
    }, caseTimeoutMs)

    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        return // non-JSON output (shouldn't happen with stream-json, ignore defensively)
      }

      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools)) {
        registeredTools = event.tools as string[]
        return
      }

      if (event.type === 'assistant') {
        const message = event.message as { content?: Array<Record<string, unknown>> } | undefined
        const toolUse = message?.content?.find(block => block.type === 'tool_use')
        if (toolUse) {
          finish({
            actualTool: (toolUse.name as string) ?? null,
            actualInput: toolUse.input ?? null,
            registeredTools,
            timedOut: false,
            erroredMessage: null,
          })
        }
        return
      }

      if (event.type === 'result') {
        finish({
          actualTool: null,
          actualInput: null,
          registeredTools,
          timedOut: false,
          erroredMessage: event.is_error ? String(event.result ?? 'unknown error') : null,
        })
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    })

    let stderrTail = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })

    child.on('error', error => {
      finish({
        actualTool: null,
        actualInput: null,
        registeredTools,
        timedOut: false,
        erroredMessage: `spawn error: ${String(error)}`,
      })
    })

    child.on('close', code => {
      if (!settled && code !== 0) {
        finish({
          actualTool: null,
          actualInput: null,
          registeredTools,
          timedOut: false,
          erroredMessage: `process exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`,
        })
      } else if (!settled) {
        // Process closed cleanly without us seeing a result/tool_use — treat as no tool called.
        finish({
          actualTool: null,
          actualInput: null,
          registeredTools,
          timedOut: false,
          erroredMessage: null,
        })
      }
    })
  })
}

async function isOllamaReachable(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function printSummaryTable(rows: ResultRow[]): void {
  console.log('\n=== Routing eval results ===')
  const headers = ['Case', 'Category', 'Expected', 'Actual', 'Result', 'Latency']
  const widths = [20, 11, 14, 20, 18, 9]
  const pad = (value: string, width: number) =>
    value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width)

  console.log(headers.map((h, i) => pad(h, widths[i])).join(' | '))
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'))

  for (const row of rows) {
    const cells = [
      row.case.id,
      row.case.category,
      row.case.expectedTool ?? '(none)',
      row.run.actualTool ?? '(none)',
      row.classification,
      `${row.run.durationMs}ms`,
    ]
    console.log(cells.map((c, i) => pad(c, widths[i])).join(' | '))
  }

  const total = rows.length
  const correct = rows.filter(r => r.classification === 'correct').length
  console.log(`\n${correct}/${total} correct (${((correct / total) * 100).toFixed(1)}%)`)

  const byClassification = new Map<Classification, number>()
  for (const row of rows) {
    byClassification.set(row.classification, (byClassification.get(row.classification) ?? 0) + 1)
  }
  for (const [classification, count] of byClassification) {
    if (classification === 'correct') continue
    console.log(`  ${classification}: ${count}`)
  }
}

function scoreOf(rows: ResultRow[]): number {
  if (rows.length === 0) return 0
  const correct = rows.filter(r => r.classification === 'correct').length
  return correct / rows.length
}

/**
 * Sample mean and sample standard deviation (N-1 denominator — the
 * conventional choice when treating these runs as a sample used to
 * *estimate* the model's true variance, not the full population of all
 * possible runs). A single run (`values.length < 2`) has no meaningful
 * variance estimate, so `std` is reported as 0 rather than NaN/undefined —
 * callers should treat a 1-run "std" of 0 as "not actually measured", which
 * is exactly why `--runs` defaulting to 1 still prints a single score with
 * no ± (see `printMultiRunSummary`, only invoked when `runs > 1`).
 */
function meanStd(values: readonly number[]): { mean: number; std: number } {
  const n = values.length
  if (n === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { mean, std: 0 }
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  return { mean, std: Math.sqrt(variance) }
}

function printMultiRunSummary(allRunsRows: ResultRow[][]): void {
  const scores = allRunsRows.map(scoreOf)
  const { mean, std } = meanStd(scores)

  console.log('\n=== Mean ± std across runs ===')
  scores.forEach((score, i) => {
    const rows = allRunsRows[i]!
    const correct = rows.filter(r => r.classification === 'correct').length
    console.log(`  Run ${i + 1}/${scores.length}: ${correct}/${rows.length} correct (${(score * 100).toFixed(1)}%)`)
  })
  console.log(
    `\nMean: ${(mean * 100).toFixed(1)}%  |  Std: ${(std * 100).toFixed(1)}pp  |  Runs: ${scores.length}`,
  )
}

function writeMultiRunSummaryReport(
  path: string,
  allRunsRows: ResultRow[][],
  split: RoutingSplit | 'all',
): void {
  const scores = allRunsRows.map(scoreOf)
  const { mean, std } = meanStd(scores)
  const payload = {
    timestamp: new Date().toISOString(),
    split,
    runs: scores.length,
    caseCount: allRunsRows[0]?.length ?? 0,
    scores,
    meanScore: mean,
    stdScore: std,
    perRun: allRunsRows.map((rows, i) => ({
      run: i + 1,
      correct: rows.filter(r => r.classification === 'correct').length,
      total: rows.length,
      score: scoreOf(rows),
    })),
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\nMulti-run summary written to ${path}`)
}

function writeMultiRunSummaryMarkdown(
  path: string,
  allRunsRows: ResultRow[][],
  split: RoutingSplit | 'all',
): void {
  const scores = allRunsRows.map(scoreOf)
  const { mean, std } = meanStd(scores)
  const lines: string[] = []
  lines.push('# Routing eval — mean ± std summary')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Split: ${split}`)
  lines.push(`Cases per run: ${allRunsRows[0]?.length ?? 0}`)
  lines.push('')
  lines.push(`**Mean: ${(mean * 100).toFixed(1)}%  |  Std: ${(std * 100).toFixed(1)}pp  |  Runs: ${scores.length}**`)
  lines.push('')
  lines.push('| Run | Correct | Total | Score |')
  lines.push('|---|---|---|---|')
  allRunsRows.forEach((rows, i) => {
    const correct = rows.filter(r => r.classification === 'correct').length
    lines.push(`| ${i + 1} | ${correct} | ${rows.length} | ${(scoreOf(rows) * 100).toFixed(1)}% |`)
  })
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  console.log(`Multi-run summary (markdown) written to ${path}`)
}

function writeJsonReport(path: string, rows: ResultRow[]): void {
  const total = rows.length
  const correct = rows.filter(r => r.classification === 'correct').length
  const payload = {
    timestamp: new Date().toISOString(),
    summary: {
      total,
      correct,
      score: total > 0 ? correct / total : null,
    },
    rows: rows.map(r => ({
      caseId: r.case.id,
      category: r.case.category,
      description: r.case.description,
      prompt: r.case.prompt,
      expectedTool: r.case.expectedTool,
      actualTool: r.run.actualTool,
      actualInput: r.run.actualInput,
      classification: r.classification,
      durationMs: r.run.durationMs,
      timedOut: r.run.timedOut,
      erroredMessage: r.run.erroredMessage,
    })),
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\nJSON report written to ${path}`)
}

function writeMarkdownReport(path: string, rows: ResultRow[]): void {
  const total = rows.length
  const correct = rows.filter(r => r.classification === 'correct').length
  const lines: string[] = []
  lines.push('# Routing eval report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push(`**Score: ${correct}/${total} (${total > 0 ? ((correct / total) * 100).toFixed(1) : '0'}%)**`)
  lines.push('')
  lines.push('| Case | Category | Expected | Actual | Result | Latency |')
  lines.push('|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(
      `| ${row.case.id} | ${row.case.category} | ${row.case.expectedTool ?? '(none)'} | ` +
        `${row.run.actualTool ?? '(none)'} | ${row.classification} | ${row.run.durationMs}ms |`,
    )
  }
  lines.push('')
  for (const row of rows) {
    lines.push(`## ${row.case.id}`)
    lines.push('')
    lines.push(`- **Description**: ${row.case.description}`)
    lines.push(`- **Prompt**: ${truncate(row.case.prompt, 300)}`)
    lines.push(`- **Expected tool**: ${row.case.expectedTool ?? '(none)'}`)
    lines.push(`- **Actual tool**: ${row.run.actualTool ?? '(none)'}`)
    if (row.run.actualInput) {
      lines.push(`- **Actual input**: \`${truncate(JSON.stringify(row.run.actualInput), 300)}\``)
    }
    lines.push(`- **Classification**: ${row.classification}`)
    lines.push(`- **Latency**: ${row.run.durationMs}ms`)
    if (row.run.erroredMessage) lines.push(`- **Error**: ${truncate(row.run.erroredMessage, 300)}`)
    lines.push('')
  }

  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log(`Markdown report written to ${path}`)
}

type CliOptions = {
  caseIds: Set<string> | null
  outDir: string
  writeReport: boolean
  /** null = run both splits (the full case set). */
  split: RoutingSplit | null
  /** Number of times to re-run the selected case set — see this file's own header comment ("Fix the ruler"). */
  runs: number
  /**
   * Per-case kill timeout in ms. Defaults to `DEFAULT_CASE_TIMEOUT_MS`
   * (45s), calibrated for a single-shot router decision. A multi-sample
   * lever (e.g. self-consistency, LOCAL_AI_MASTER_PLAN.md §6 lever H) can
   * legitimately take several times that — pass a larger value via
   * `--case-timeout` when measuring such a lever so the harness's own
   * impatience isn't mistaken for a routing failure.
   */
  caseTimeoutMs: number
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    caseIds: null,
    outDir: 'reports',
    writeReport: true,
    split: null,
    runs: 1,
    caseTimeoutMs: DEFAULT_CASE_TIMEOUT_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-report') {
      options.writeReport = false
      continue
    }
    if (arg === '--case') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        options.caseIds = options.caseIds ?? new Set()
        options.caseIds.add(next)
        i++
      }
      continue
    }
    if (arg === '--out-dir') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        options.outDir = next
        i++
      }
      continue
    }
    if (arg === '--split') {
      const next = argv[i + 1]
      if (next === 'tuning' || next === 'holdout') {
        options.split = next
        i++
      } else {
        console.error(`Invalid --split value ${JSON.stringify(next)} — must be "tuning" or "holdout". Ignoring.`)
      }
      continue
    }
    if (arg === '--runs') {
      const next = argv[i + 1]
      const parsed = next ? Number.parseInt(next, 10) : NaN
      if (Number.isFinite(parsed) && parsed >= 1) {
        options.runs = parsed
        i++
      } else {
        console.error(`Invalid --runs value ${JSON.stringify(next)} — must be a positive integer. Ignoring.`)
      }
      continue
    }
    if (arg === '--case-timeout') {
      const next = argv[i + 1]
      const parsed = next ? Number.parseInt(next, 10) : NaN
      if (Number.isFinite(parsed) && parsed >= 1000) {
        options.caseTimeoutMs = parsed
        i++
      } else {
        console.error(`Invalid --case-timeout value ${JSON.stringify(next)} — must be a positive integer (ms), at least 1000. Ignoring.`)
      }
      continue
    }
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  const reachable = await isOllamaReachable()
  if (!reachable) {
    console.error('Ollama not reachable at http://127.0.0.1:11434. Is it running? Aborting routing eval.')
    process.exitCode = 1
    return
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!env.CLAUDE_CODE_GIT_BASH_PATH) {
    env.CLAUDE_CODE_GIT_BASH_PATH = FALLBACK_GIT_BASH_PATH
  }
  // Hermetic: `bun run` (unlike a plain shell) auto-loads this repo's root
  // .env into its own process.env before this script even starts — and that
  // .env has a live third-party (NVIDIA NIM) OPENAI_* config for unrelated
  // provider experimentation. Blindly forwarding process.env to the spawned
  // `node bin/openclaude` child would make it think an explicit provider was
  // selected (CLAUDE_CODE_USE_OPENAI=1), which skips applying
  // .openclaude-profile.json entirely (see hasExplicitProviderSelection in
  // providerProfile.ts) — silently routing every case through NVIDIA NIM
  // instead of the local Ollama router this eval exists to measure. Clear
  // these explicitly so the child always falls back to the profile file,
  // exactly like a real interactive `node bin/openclaude` invocation would.
  for (const key of [
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GITHUB',
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'OPENAI_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_API_BASE',
  ]) {
    delete env[key]
  }

  const casesToRun = routingCases.filter(c => {
    if (options.caseIds && !options.caseIds.has(c.id)) return false
    if (options.split && c.split !== options.split) return false
    return true
  })

  if (casesToRun.length === 0) {
    console.log('No cases matched the --case/--split filter. Exiting.')
    return
  }

  const splitLabel = options.split ?? 'all (tuning + holdout)'
  console.log(
    `Running ${casesToRun.length} routing case(s) [split: ${splitLabel}] against the compiled CLI (dist/cli.mjs), ${options.runs} run(s)...`,
  )

  const allRunsRows: ResultRow[][] = []
  for (let run = 1; run <= options.runs; run++) {
    if (options.runs > 1) console.log(`\n--- Run ${run}/${options.runs} ---`)
    const rows: ResultRow[] = []
    for (const routingCase of casesToRun) {
      process.stdout.write(`  [${routingCase.id}] running… `)
      const result = await runRoutingCase(routingCase.prompt, env, options.caseTimeoutMs)
      const classification = classify(routingCase.expectedTool, result)
      console.log(`${result.actualTool ?? '(none)'} — ${classification} (${result.durationMs}ms)`)
      rows.push({ case: routingCase, run: result, classification })
    }
    printSummaryTable(rows)
    allRunsRows.push(rows)
  }

  if (options.runs > 1) {
    printMultiRunSummary(allRunsRows)
  }

  if (options.writeReport) {
    const outDir = resolve(process.cwd(), options.outDir)
    mkdirSync(outDir, { recursive: true })

    if (options.runs === 1) {
      const rows = allRunsRows[0]!
      writeJsonReport(resolve(outDir, 'eval-routing.json'), rows)
      writeMarkdownReport(resolve(outDir, 'eval-routing.md'), rows)
    } else {
      // Per-run detail (each run's own full case-by-case breakdown) plus one
      // combined mean±std summary — the actual "fix the ruler" deliverable.
      allRunsRows.forEach((rows, i) => {
        writeJsonReport(resolve(outDir, `eval-routing-run${i + 1}.json`), rows)
        writeMarkdownReport(resolve(outDir, `eval-routing-run${i + 1}.md`), rows)
      })
      writeMultiRunSummaryReport(resolve(outDir, 'eval-routing-summary.json'), allRunsRows, options.split ?? 'all')
      writeMultiRunSummaryMarkdown(resolve(outDir, 'eval-routing-summary.md'), allRunsRows, options.split ?? 'all')
    }
  }

  const hasFailure = allRunsRows.some(rows => rows.some(r => r.classification !== 'correct'))
  if (hasFailure) {
    process.exitCode = 1
  }
}

await main()

export {}
