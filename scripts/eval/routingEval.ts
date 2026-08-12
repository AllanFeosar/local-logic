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
import { routingCases, type ExpectedTool, type RoutingCase } from './routingCases.ts'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
// This environment's known git-bash location (see LOCAL_AI_STATUS.md /
// LOCAL_AI_MASTER_PLAN.md) — only used as a fallback when the env var isn't
// already set, so this stays portable to other machines/CI.
const FALLBACK_GIT_BASH_PATH = 'E:\\Tools\\Git\\bin\\bash.exe'
const CASE_TIMEOUT_MS = 45_000

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
function runRoutingCase(prompt: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
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
    }, CASE_TIMEOUT_MS)

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
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { caseIds: null, outDir: 'reports', writeReport: true }
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

  const casesToRun = options.caseIds
    ? routingCases.filter(c => options.caseIds!.has(c.id))
    : routingCases

  if (casesToRun.length === 0) {
    console.log('No cases matched --case filter. Exiting.')
    return
  }

  console.log(`Running ${casesToRun.length} routing case(s) against the compiled CLI (dist/cli.mjs)...`)

  const rows: ResultRow[] = []
  for (const routingCase of casesToRun) {
    process.stdout.write(`  [${routingCase.id}] running… `)
    const run = await runRoutingCase(routingCase.prompt, env)
    const classification = classify(routingCase.expectedTool, run)
    console.log(`${run.actualTool ?? '(none)'} — ${classification} (${run.durationMs}ms)`)
    rows.push({ case: routingCase, run, classification })
  }

  printSummaryTable(rows)

  if (options.writeReport) {
    const outDir = resolve(process.cwd(), options.outDir)
    mkdirSync(outDir, { recursive: true })
    writeJsonReport(resolve(outDir, 'eval-routing.json'), rows)
    writeMarkdownReport(resolve(outDir, 'eval-routing.md'), rows)
  }

  const hasFailure = rows.some(r => r.classification !== 'correct')
  if (hasFailure) {
    process.exitCode = 1
  }
}

await main()

export {}
