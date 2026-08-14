// @ts-nocheck
/**
 * DeepSolve pipeline vs single-shot AskMathModel — head-to-head eval.
 *
 * The Phase 3.5 exit gate (LOCAL_AI_MASTER_PLAN.md §8): "the composed
 * pipeline beats single-shot VibeThinker on a fixed >=20-problem math/logic
 * eval set" (frontier comparison is a separate, later step — this harness
 * covers the local-vs-local half first, following this project's own
 * eval-gating discipline of measuring before claiming). This harness's case
 * set (deepSolveCases.ts) now holds 21 cases (grown from 9 in session 29),
 * clearing the gate's ">=20-problem" bar. A full run is expensive —
 * DeepSolve's own worst case is N x 1-5 minutes PER CASE, so the full 21 x
 * (single-shot + deep) sweep is a dedicated multi-hour run; use `--case` to
 * spot-check a single case, or `--n 1` to cut DeepSolve's candidate budget
 * for a faster (weaker) pass. The win the gate asks for lives in the
 * deep-10..21 "win zone" cases (see deepSolveCases.ts's header) — problems
 * where single-shot has a real slip probability but Tier 1 can still verify.
 *
 * For each case, runs BOTH:
 *   - AskMathModelTool.call({ problem })            (single-shot, existing)
 *   - solveDeep(problem, signal, { n })              (DeepSolve pipeline)
 * and grades each against the same ground-truth substrings, so the report
 * shows a genuine side-by-side, not two separately-graded runs.
 *
 * IMPORTANT — this makes LIVE calls to Ollama (http://127.0.0.1:11434,
 * VibeThinker + Qwen3-Reranker) and spawns real local Python processes for
 * DeepSolve's verification step. It does NOT call any paid cloud/frontier
 * model API — no --frontier flag exists here (the master plan's frontier
 * head-to-head is a separate, explicit later step per the phase 3.5 gate's
 * own two-part framing).
 *
 * Usage:
 *   bun run scripts/eval/deepSolveEval.ts
 *   bun run scripts/eval/deepSolveEval.ts --n 2        # fewer DeepSolve candidates, faster run
 *   bun run scripts/eval/deepSolveEval.ts --case deep-5-modular-exponentiation
 *   bun run scripts/eval/deepSolveEval.ts --out-dir reports --no-report
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.ts'
import { AskMathModelTool } from '../../src/tools/AskMathModelTool/AskMathModelTool.ts'
import { MATH_MODEL_BASE_URL } from '../../src/tools/AskMathModelTool/constants.ts'
import { solveDeep } from '../../src/tools/AskMathModelTool/deepSolve/solveDeep.ts'
import { deepSolveCases } from './deepSolveCases.ts'

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

async function isReachable(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

function normalizeForMatch(text: string): string {
  return text.replace(/,/g, '')
}

function passes(answer: string, expectedSubstrings: string[]): boolean {
  const normalized = normalizeForMatch(answer)
  return expectedSubstrings.some(exp => normalized.includes(exp))
}

type Row = {
  caseId: string
  description: string
  hard: boolean
  singleShot: {
    status: 'ok' | 'error'
    answer: string
    passed: boolean
    latencyMs: number | null
  }
  deep: {
    status: 'ok' | 'error'
    answer: string
    passed: boolean
    latencyMs: number | null
    verified: boolean | null
    method: string | null
    candidatesGenerated: number | null
    retried: boolean | null
  }
}

function truncate(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

async function runCase(id: string | undefined, n: number): Promise<Row[]> {
  const rows: Row[] = []
  const cases = id ? deepSolveCases.filter(c => c.id === id) : deepSolveCases

  for (const c of cases) {
    console.log(`\n=== ${c.id}${c.hard ? ' [HARD]' : ''} ===`)
    console.log(`  ${c.description}`)

    process.stdout.write('  single-shot: running… ')
    let singleShot: Row['singleShot']
    try {
      const result = await AskMathModelTool.call({ problem: c.problem }, fakeContext())
      const passed = passes(result.data.answer, c.expectedSubstrings)
      console.log(`done in ${result.data.durationMs}ms — ${passed ? 'PASS' : 'FAIL'}`)
      singleShot = { status: 'ok', answer: result.data.answer, passed, latencyMs: result.data.durationMs }
    } catch (error) {
      console.log('ERROR')
      singleShot = { status: 'error', answer: `ERROR: ${String(error)}`, passed: false, latencyMs: null }
    }

    process.stdout.write(`  deep (n=${n}): running… `)
    let deep: Row['deep']
    try {
      const start = Date.now()
      const result = await solveDeep(c.problem, new AbortController().signal, { n })
      const latencyMs = Date.now() - start
      const passed = passes(result.answer, c.expectedSubstrings)
      console.log(
        `done in ${latencyMs}ms — ${passed ? 'PASS' : 'FAIL'} (method=${result.method}, verified=${result.verified}, candidates=${result.candidatesGenerated}, retried=${result.retried})`,
      )
      deep = {
        status: 'ok',
        answer: result.answer,
        passed,
        latencyMs,
        verified: result.verified,
        method: result.method,
        candidatesGenerated: result.candidatesGenerated,
        retried: result.retried,
      }
    } catch (error) {
      console.log('ERROR')
      deep = {
        status: 'error',
        answer: `ERROR: ${String(error)}`,
        passed: false,
        latencyMs: null,
        verified: null,
        method: null,
        candidatesGenerated: null,
        retried: null,
      }
    }

    rows.push({ caseId: c.id, description: c.description, hard: c.hard === true, singleShot, deep })
  }

  return rows
}

function printSummary(rows: Row[]): void {
  console.log('\n=== Summary ===')
  const headers = ['Case', 'Hard', 'Single-shot', 'DeepSolve', 'Deep method', 'Deep verified', 'Deep latency']
  const widths = [28, 5, 12, 10, 18, 13, 12]
  const pad = (v: string, w: number) => (v.length > w ? `${v.slice(0, w - 1)}…` : v.padEnd(w))
  console.log(headers.map((h, i) => pad(h, widths[i])).join(' | '))
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'))
  for (const r of rows) {
    console.log(
      [
        pad(r.caseId, widths[0]),
        pad(r.hard ? 'yes' : '', widths[1]),
        pad(r.singleShot.passed ? 'PASS' : r.singleShot.status === 'error' ? 'ERROR' : 'FAIL', widths[2]),
        pad(r.deep.passed ? 'PASS' : r.deep.status === 'error' ? 'ERROR' : 'FAIL', widths[3]),
        pad(String(r.deep.method ?? '-'), widths[4]),
        pad(String(r.deep.verified ?? '-'), widths[5]),
        pad(r.deep.latencyMs !== null ? `${r.deep.latencyMs}ms` : '-', widths[6]),
      ].join(' | '),
    )
  }

  const singlePassed = rows.filter(r => r.singleShot.passed).length
  const deepPassed = rows.filter(r => r.deep.passed).length
  console.log(`\nSingle-shot: ${singlePassed}/${rows.length} passed`)
  console.log(`DeepSolve:   ${deepPassed}/${rows.length} passed`)

  const hardRows = rows.filter(r => r.hard)
  if (hardRows.length > 0) {
    const singleHardPassed = hardRows.filter(r => r.singleShot.passed).length
    const deepHardPassed = hardRows.filter(r => r.deep.passed).length
    console.log(`\nOn HARD cases only (${hardRows.length}):`)
    console.log(`  Single-shot: ${singleHardPassed}/${hardRows.length} passed`)
    console.log(`  DeepSolve:   ${deepHardPassed}/${hardRows.length} passed`)
  }
}

function writeReports(outDir: string, rows: Row[], n: number): void {
  mkdirSync(outDir, { recursive: true })

  const jsonPath = resolve(outDir, 'eval-deep-solve.json')
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        n,
        summary: {
          total: rows.length,
          singleShotPassed: rows.filter(r => r.singleShot.passed).length,
          deepPassed: rows.filter(r => r.deep.passed).length,
        },
        rows,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\nJSON report written to ${jsonPath}`)

  const lines: string[] = []
  lines.push('# DeepSolve vs single-shot AskMathModel eval report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}, n=${n}`)
  lines.push('')
  lines.push(
    'No live paid frontier-model call is made by this harness. The frontier head-to-head is a separate, ' +
      'explicit later step per LOCAL_AI_MASTER_PLAN.md §8 Phase 3.5\'s two-part gate.',
  )
  lines.push('')
  for (const r of rows) {
    lines.push(`## ${r.caseId}${r.hard ? ' [HARD]' : ''}`)
    lines.push('')
    lines.push(`- **Description**: ${r.description}`)
    lines.push(`- **Single-shot**: ${r.singleShot.passed ? 'PASS' : r.singleShot.status === 'error' ? 'ERROR' : 'FAIL'} (${r.singleShot.latencyMs ?? '-'}ms)`)
    lines.push(`  \`${truncate(r.singleShot.answer)}\``)
    lines.push(
      `- **DeepSolve**: ${r.deep.passed ? 'PASS' : r.deep.status === 'error' ? 'ERROR' : 'FAIL'} (${r.deep.latencyMs ?? '-'}ms, method=${r.deep.method}, verified=${r.deep.verified}, candidates=${r.deep.candidatesGenerated}, retried=${r.deep.retried})`,
    )
    lines.push(`  \`${truncate(r.deep.answer)}\``)
    lines.push('')
  }
  const mdPath = resolve(outDir, 'eval-deep-solve.md')
  writeFileSync(mdPath, lines.join('\n'), 'utf8')
  console.log(`Markdown report written to ${mdPath}`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let caseId: string | undefined
  let n = 3
  let outDir = 'reports'
  let writeReport = true

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') {
      caseId = argv[++i]
    } else if (argv[i] === '--n') {
      n = Number(argv[++i])
    } else if (argv[i] === '--out-dir') {
      outDir = argv[++i]!
    } else if (argv[i] === '--no-report') {
      writeReport = false
    }
  }

  const reachable = await isReachable(`${MATH_MODEL_BASE_URL}/models`)
  if (!reachable) {
    console.log(`[SKIPPED] Ollama not reachable at ${MATH_MODEL_BASE_URL}. Is it running?`)
    process.exitCode = 1
    return
  }

  console.log(
    `Running DeepSolve eval with n=${n} candidate(s) per case. This calls the live math specialist and ` +
      `reranker model and spawns real local Python processes — expect this to take a while ` +
      `(worst case per case is roughly n x 1-5 minutes, more if a bounded retry triggers).`,
  )

  const rows = await runCase(caseId, n)
  if (rows.length === 0) {
    console.log('No cases ran (check --case filter). Exiting.')
    return
  }

  printSummary(rows)

  if (writeReport) {
    writeReports(resolve(process.cwd(), outDir), rows, n)
  }
}

await main()

export {}
