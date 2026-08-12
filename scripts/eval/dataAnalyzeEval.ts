// @ts-nocheck
/**
 * DataAnalyzeTool eval harness — table QA (TAPAS), tabular prediction
 * (TabPFN-v2), and forecasting (Chronos-t5-tiny).
 *
 * Mirrors scripts/eval/specialistEval.ts's conventions (real live test
 * cases run through the actual tool/bridge — DataAnalyzeTool is called as a
 * black box, exactly like specialistEval.ts calls AskMathModelTool/
 * DocumentQATool/ImageCaptionTool — ground-truth checkable where possible,
 * structured JSON+MD report output). One deliberate difference: there is no
 * `--frontier` flag here. Every case in this harness has an objective,
 * locally-computable ground truth (we authored the tables/synthetic data
 * ourselves), so there's nothing for a frontier text-completion call to
 * usefully compare against — unlike specialistEval.ts's math/DocQA cases,
 * which are genuinely answerable by a general LLM too.
 *
 * Built per LOCAL_AI_STATUS.md's Session 3b open item: "a small
 * DataAnalyze-specific eval set... to properly characterize /table-qa's
 * real accuracy rather than relying on ad hoc spot-checks."
 *
 * Quick start:
 *
 *   bun run scripts/eval/dataAnalyzeEval.ts
 *   bun run scripts/eval/dataAnalyzeEval.ts --operation question
 *   bun run scripts/eval/dataAnalyzeEval.ts --out-dir reports --no-report
 *
 * IMPORTANT — this makes LIVE calls to the Python model bridge
 * (http://127.0.0.1:8756 by default). It does NOT call Ollama and does NOT
 * call any paid cloud/frontier model API — the bridge is a local-only,
 * no-auth, no-cost service, so (per the task that commissioned this
 * harness) no opt-in gating is needed the way specialistEval.ts gates its
 * `--frontier` flag.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.ts'
import { DataAnalyzeTool } from '../../src/tools/DataAnalyzeTool/DataAnalyzeTool.ts'
import { MODEL_BRIDGE_BASE_URL } from '../../src/tools/shared/localModelBridge.ts'
import {
  forecastCases,
  predictCases,
  tableQACases,
  type ForecastCase,
  type PredictCase,
  type TableQACase,
} from './dataAnalyzeCases.ts'

type Operation = 'question' | 'predict' | 'forecast'

type ReportRow = {
  operation: Operation
  caseId: string
  description: string
  /** Only populated for "question" cases — used to break down TAPAS pass
   * rate by difficulty class in the report. */
  category: string | null
  inputSummary: string
  status: 'ok' | 'error' | 'skipped'
  actual: string
  expected: string
  pass: boolean | null
  latencyMs: number | null
  notes: string
}

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

function truncate(text: string, max = 400): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/,/g, '').replace(/\$/g, '').trim()
}

function withinTolerance(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance
}

// ---------------------------------------------------------------------------
// operation "question" (TAPAS)
// ---------------------------------------------------------------------------

async function runTableQACases(rows: ReportRow[]): Promise<void> {
  console.log('\n=== DataAnalyze "question" (tapas-mini-finetuned-wtq via /table-qa) ===')
  for (const c of tableQACases) {
    process.stdout.write(`  [${c.id}] running… `)
    const start = Date.now()
    try {
      const result = await DataAnalyzeTool.call(
        { operation: 'question', question: c.input.question, table: c.input.table },
        fakeContext(),
      )
      const latencyMs = Date.now() - start
      const answer = result.data.answer ?? ''
      const normalized = normalizeForMatch(answer)
      const pass = c.expectedSubstrings.some(exp => normalized.includes(normalizeForMatch(exp)))
      const cellCount = result.data.cells?.length ?? 0
      console.log(`done in ${latencyMs}ms — ${pass ? 'PASS' : 'FAIL'} (answer: "${truncate(answer, 60)}")`)

      rows.push({
        operation: 'question',
        caseId: c.id,
        description: c.description,
        category: c.category,
        inputSummary: `[${c.category}] Q: ${c.input.question}`,
        status: 'ok',
        actual: answer,
        expected: c.expectedSubstrings.join(' / '),
        pass,
        latencyMs,
        notes:
          cellCount > 0
            ? `grounded in ${cellCount} cell(s)`
            : 'model did not ground the answer to specific cells (low-confidence per the tool\'s own contract)',
      })
    } catch (error) {
      console.log('ERROR')
      rows.push({
        operation: 'question',
        caseId: c.id,
        description: c.description,
        category: c.category,
        inputSummary: `[${c.category}] Q: ${c.input.question}`,
        status: 'error',
        actual: `ERROR: ${String(error)}`,
        expected: c.expectedSubstrings.join(' / '),
        pass: false,
        latencyMs: null,
        notes: 'tool call threw',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// operation "predict" (TabPFN-v2)
// ---------------------------------------------------------------------------

function isRegressCase(c: PredictCase): c is Extract<PredictCase, { expectedValues: number[] }> {
  return c.input.task === 'regress'
}

async function runPredictCases(rows: ReportRow[]): Promise<void> {
  console.log('\n=== DataAnalyze "predict" (TabPFN-v2 via /tabular-predict) ===')
  for (const c of predictCases) {
    process.stdout.write(`  [${c.id}] running… `)
    const start = Date.now()
    try {
      const result = await DataAnalyzeTool.call(
        {
          operation: 'predict',
          task: c.input.task,
          train_features: c.input.train_features,
          train_labels: c.input.train_labels,
          test_features: c.input.test_features,
        },
        fakeContext(),
      )
      const latencyMs = Date.now() - start
      const predictions = result.data.predictions ?? []

      let pass: boolean
      let expectedSummary: string
      let actualSummary: string
      if (isRegressCase(c)) {
        const perPoint = predictions.map((p, i) => {
          const expected = c.expectedValues[i]
          const num = typeof p === 'number' ? p : Number(p)
          const ok = Number.isFinite(num) && withinTolerance(num, expected, c.tolerance)
          return { predicted: p, expected, ok }
        })
        pass = perPoint.length === c.expectedValues.length && perPoint.every(p => p.ok)
        expectedSummary = c.expectedValues.map(v => `~${v}±${c.tolerance}`).join(', ')
        actualSummary = perPoint.map(p => `${p.predicted}${p.ok ? '' : ' [OUT OF TOLERANCE]'}`).join(', ')
      } else {
        const perPoint = predictions.map((p, i) => ({
          predicted: p,
          expected: c.expectedLabels[i],
          ok: String(p) === String(c.expectedLabels[i]),
        }))
        pass = perPoint.length === c.expectedLabels.length && perPoint.every(p => p.ok)
        expectedSummary = c.expectedLabels.join(', ')
        actualSummary = perPoint.map(p => `${p.predicted}${p.ok ? '' : ' [MISMATCH]'}`).join(', ')
      }

      console.log(`done in ${latencyMs}ms — ${pass ? 'PASS' : 'FAIL'} (predictions: ${actualSummary})`)

      rows.push({
        operation: 'predict',
        caseId: c.id,
        description: c.description,
        category: null,
        inputSummary: `task=${c.input.task}, ${c.input.train_features.length} train rows, ${c.input.test_features.length} test rows`,
        status: 'ok',
        actual: actualSummary,
        expected: expectedSummary,
        pass,
        latencyMs,
        notes: result.data.probabilities ? `probabilities: ${JSON.stringify(result.data.probabilities)}` : '',
      })
    } catch (error) {
      console.log('ERROR')
      rows.push({
        operation: 'predict',
        caseId: c.id,
        description: c.description,
        category: null,
        inputSummary: `task=${c.input.task}, ${c.input.train_features.length} train rows, ${c.input.test_features.length} test rows`,
        status: 'error',
        actual: `ERROR: ${String(error)}`,
        expected: isRegressCase(c) ? c.expectedValues.join(', ') : c.expectedLabels.join(', '),
        pass: false,
        latencyMs: null,
        notes: 'tool call threw',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// operation "forecast" (Chronos-t5-tiny)
// ---------------------------------------------------------------------------

function checkBoundsSanity(
  forecast: number[],
  low: number[] | undefined,
  high: number[] | undefined,
  series: number[],
): { ok: boolean; note: string } {
  if (!low || !high || low.length === 0 || high.length === 0) {
    return { ok: true, note: 'model returned no uncertainty bounds (low/high) — point forecast only, not graded on bounds sanity' }
  }
  const seriesRange = Math.max(...series) - Math.min(...series) || Math.max(...series.map(Math.abs)) || 1
  const problems: string[] = []
  for (let i = 0; i < forecast.length; i++) {
    const l = low[i]
    const h = high[i]
    const f = forecast[i]
    if (l === undefined || h === undefined) continue
    if (l > h) problems.push(`low>high at step ${i} (${l} > ${h})`)
    if (f < l || f > h) problems.push(`point forecast outside [low,high] at step ${i} (${f} not in [${l},${h}])`)
    const width = h - l
    if (width <= 0) problems.push(`zero-width band at step ${i}`)
    if (width > seriesRange * 6) problems.push(`absurdly wide band at step ${i} (width=${width.toFixed(1)}, series range=${seriesRange.toFixed(1)})`)
  }
  return problems.length === 0
    ? { ok: true, note: 'bounds contain the point forecast and are neither zero-width nor absurdly wide' }
    : { ok: false, note: problems.join('; ') }
}

async function runForecastCases(rows: ReportRow[]): Promise<void> {
  console.log('\n=== DataAnalyze "forecast" (chronos-t5-tiny via /forecast) ===')
  for (const c of forecastCases) {
    process.stdout.write(`  [${c.id}] running… `)
    const start = Date.now()
    try {
      const result = await DataAnalyzeTool.call(
        { operation: 'forecast', series: c.input.series, horizon: c.input.horizon },
        fakeContext(),
      )
      const latencyMs = Date.now() - start
      const forecast = result.data.forecast ?? []

      const perPoint = forecast.map((f, i) => ({
        forecast: f,
        expected: c.expectedForecast[i],
        ok: withinTolerance(f, c.expectedForecast[i], c.tolerance),
      }))
      const forecastInTolerance = perPoint.length === c.expectedForecast.length && perPoint.every(p => p.ok)
      const bounds = checkBoundsSanity(forecast, result.data.low, result.data.high, c.input.series)
      const pass = forecastInTolerance && bounds.ok

      const actualSummary = `forecast=[${forecast.join(', ')}]` +
        (result.data.low && result.data.high
          ? ` low=[${result.data.low.join(', ')}] high=[${result.data.high.join(', ')}]`
          : '')

      console.log(
        `done in ${latencyMs}ms — ${pass ? 'PASS' : 'FAIL'} (${actualSummary})`,
      )

      rows.push({
        operation: 'forecast',
        caseId: c.id,
        description: c.description,
        category: null,
        inputSummary: `series=[${c.input.series.join(', ')}], horizon=${c.input.horizon}`,
        status: 'ok',
        actual: actualSummary,
        expected: `~[${c.expectedForecast.join(', ')}] ±${c.tolerance}`,
        pass,
        latencyMs,
        notes: `tolerance check: ${forecastInTolerance ? 'pass' : 'fail'}; bounds sanity: ${bounds.note}`,
      })
    } catch (error) {
      console.log('ERROR')
      rows.push({
        operation: 'forecast',
        caseId: c.id,
        description: c.description,
        category: null,
        inputSummary: `series=[${c.input.series.join(', ')}], horizon=${c.input.horizon}`,
        status: 'error',
        actual: `ERROR: ${String(error)}`,
        expected: `~[${c.expectedForecast.join(', ')}] ±${c.tolerance}`,
        pass: false,
        latencyMs: null,
        notes: 'tool call threw',
      })
    }
  }
}

function skipAll(rows: ReportRow[]): void {
  const push = (operation: Operation, caseId: string, description: string, category: string | null, inputSummary: string, expected: string) => {
    rows.push({
      operation,
      caseId,
      description,
      category,
      inputSummary,
      status: 'skipped',
      actual: '',
      expected,
      pass: null,
      latencyMs: null,
      notes: `Model bridge unreachable at ${MODEL_BRIDGE_BASE_URL}`,
    })
  }
  for (const c of tableQACases as TableQACase[]) {
    push('question', c.id, c.description, c.category, `[${c.category}] Q: ${c.input.question}`, c.expectedSubstrings.join(' / '))
  }
  for (const c of predictCases as PredictCase[]) {
    push(
      'predict',
      c.id,
      c.description,
      null,
      `task=${c.input.task}`,
      isRegressCase(c) ? c.expectedValues.join(', ') : c.expectedLabels.join(', '),
    )
  }
  for (const c of forecastCases as ForecastCase[]) {
    push('forecast', c.id, c.description, null, `series=[${c.input.series.join(', ')}]`, c.expectedForecast.join(', '))
  }
}

function printSummaryTable(rows: ReportRow[]): void {
  console.log('\n=== Summary ===')
  const headers = ['Op', 'Case', 'Category', 'Status', 'Pass', 'Latency', 'Actual (truncated)']
  const widths = [9, 32, 12, 8, 5, 9, 50]
  const pad = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width))

  console.log(headers.map((h, i) => pad(h, widths[i])).join(' | '))
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'))

  for (const row of rows) {
    const cells = [
      row.operation,
      row.caseId,
      row.category ?? '-',
      row.status,
      row.pass === null ? '-' : row.pass ? 'PASS' : 'FAIL',
      row.latencyMs !== null ? `${row.latencyMs}ms` : '-',
      truncate(row.actual, widths[6]),
    ]
    console.log(cells.map((c, i) => pad(c, widths[i])).join(' | '))
  }

  console.log('\n--- Overall ---')
  for (const operation of ['question', 'predict', 'forecast'] as Operation[]) {
    const opRows = rows.filter(r => r.operation === operation)
    const graded = opRows.filter(r => r.pass !== null)
    const passed = graded.filter(r => r.pass).length
    const skipped = opRows.filter(r => r.status === 'skipped').length
    console.log(
      `${operation}: ${passed}/${graded.length} passed` +
        (skipped > 0 ? ` (${skipped} skipped)` : ''),
    )
  }

  const questionRows = rows.filter(r => r.operation === 'question' && r.pass !== null)
  if (questionRows.length > 0) {
    console.log('\n--- "question" (TAPAS) breakdown by category ---')
    for (const category of ['same-column', 'cross-column', 'aggregation']) {
      const catRows = questionRows.filter(r => r.category === category)
      if (catRows.length === 0) continue
      const passed = catRows.filter(r => r.pass).length
      console.log(`  ${category}: ${passed}/${catRows.length} passed`)
    }
  }
}

function writeJsonReport(path: string, rows: ReportRow[]): void {
  const byOperation = (operation: Operation) => {
    const opRows = rows.filter(r => r.operation === operation)
    const graded = opRows.filter(r => r.pass !== null)
    return {
      total: opRows.length,
      passed: graded.filter(r => r.pass).length,
      failed: graded.filter(r => r.pass === false).length,
      skipped: opRows.filter(r => r.status === 'skipped').length,
      errored: opRows.filter(r => r.status === 'error').length,
    }
  }

  const questionByCategory: Record<string, { total: number; passed: number }> = {}
  for (const category of ['same-column', 'cross-column', 'aggregation']) {
    const catRows = rows.filter(r => r.operation === 'question' && r.category === category && r.pass !== null)
    questionByCategory[category] = { total: catRows.length, passed: catRows.filter(r => r.pass).length }
  }

  const payload = {
    timestamp: new Date().toISOString(),
    summary: {
      question: byOperation('question'),
      predict: byOperation('predict'),
      forecast: byOperation('forecast'),
    },
    questionByCategory,
    rows,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\nJSON report written to ${path}`)
}

function writeMarkdownReport(path: string, rows: ReportRow[]): void {
  const lines: string[] = []
  lines.push('# DataAnalyzeTool eval report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push(
    'Every case in this harness has an objective, locally-computable ground truth (the tables/synthetic data ' +
      'were authored specifically for this eval) — unlike scripts/eval/specialistEval.ts, there is no frontier-' +
      'comparison column here; a frontier text-completion call has no meaningful role in grading tabular-ML ' +
      'operations, and the bridge is a local-only, no-cost, no-auth call regardless. See scripts/eval/README.md ' +
      'for the sibling harness this one mirrors in structure.',
  )
  lines.push('')

  for (const operation of ['question', 'predict', 'forecast'] as Operation[]) {
    const opRows = rows.filter(r => r.operation === operation)
    if (opRows.length === 0) continue
    lines.push(`## operation: "${operation}"`)
    lines.push('')

    if (operation === 'question') {
      lines.push('### Breakdown by category')
      lines.push('')
      for (const category of ['same-column', 'cross-column', 'aggregation']) {
        const catRows = opRows.filter(r => r.category === category && r.pass !== null)
        if (catRows.length === 0) continue
        const passed = catRows.filter(r => r.pass).length
        lines.push(`- **${category}**: ${passed}/${catRows.length} passed`)
      }
      lines.push('')
    }

    for (const row of opRows) {
      lines.push(`### ${row.caseId}`)
      lines.push('')
      lines.push(`- **Description**: ${row.description}`)
      if (row.category) lines.push(`- **Category**: ${row.category}`)
      lines.push(`- **Input**: ${row.inputSummary}`)
      lines.push(`- **Status**: ${row.status}`)
      lines.push(`- **Pass**: ${row.pass === null ? 'n/a' : row.pass ? 'PASS' : 'FAIL'}`)
      if (row.latencyMs !== null) lines.push(`- **Latency**: ${row.latencyMs}ms`)
      lines.push(`- **Expected**: ${row.expected}`)
      lines.push(`- **Actual**:`)
      lines.push('  ```')
      lines.push(`  ${row.actual || '(empty)'}`)
      lines.push('  ```')
      if (row.notes) lines.push(`- **Notes**: ${row.notes}`)
      lines.push('')
    }
  }

  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log(`Markdown report written to ${path}`)
}

type CliOptions = {
  operations: Set<Operation> | null
  outDir: string
  writeReport: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { operations: null, outDir: 'reports', writeReport: true }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-report') {
      options.writeReport = false
      continue
    }
    if (arg === '--operation') {
      const next = argv[i + 1]
      if (next && (next === 'question' || next === 'predict' || next === 'forecast')) {
        options.operations = options.operations ?? new Set()
        options.operations.add(next)
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
  const wantsAll = options.operations === null
  const wants = (operation: Operation) => wantsAll || options.operations!.has(operation)

  const rows: ReportRow[] = []

  const reachable = await isReachable(`${MODEL_BRIDGE_BASE_URL}/health`)
  if (!reachable) {
    console.log(
      `\n[SKIPPED] DataAnalyze: Python model bridge not reachable at ${MODEL_BRIDGE_BASE_URL}. Start it with python-bridge/start.ps1.`,
    )
    skipAll(rows)
  } else {
    if (wants('question')) await runTableQACases(rows)
    if (wants('predict')) await runPredictCases(rows)
    if (wants('forecast')) await runForecastCases(rows)
  }

  const filteredRows = wantsAll ? rows : rows.filter(r => options.operations!.has(r.operation))

  if (filteredRows.length === 0) {
    console.log('No cases ran (check --operation filter). Exiting.')
    return
  }

  printSummaryTable(filteredRows)

  if (options.writeReport) {
    const outDir = resolve(process.cwd(), options.outDir)
    mkdirSync(outDir, { recursive: true })
    writeJsonReport(resolve(outDir, 'eval-data-analyze.json'), filteredRows)
    writeMarkdownReport(resolve(outDir, 'eval-data-analyze.md'), filteredRows)
  }

  const hasFailure = filteredRows.some(r => r.status === 'error' || r.pass === false)
  if (hasFailure) {
    process.exitCode = 1
  }
}

await main()

export {}
