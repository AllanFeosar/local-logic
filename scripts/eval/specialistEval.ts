// @ts-nocheck
/**
 * Specialist head-to-head eval harness.
 *
 * This is the "agreed next direction" flagged in LOCAL_AI_STATUS.md's open
 * items and LOCAL_AI_MASTER_PLAN.md §8 (Phase 0 exit gate): a small,
 * runnable eval — a handful of real test cases per specialist, run through
 * the actual local tool, with a column reserved for a frontier-model
 * reference answer for human (or explicitly-authorized) comparison.
 *
 * See README.md in this directory for the full writeup. Quick start:
 *
 *   bun run scripts/eval/specialistEval.ts
 *   bun run scripts/eval/specialistEval.ts --specialist AskMathModel
 *   bun run scripts/eval/specialistEval.ts --out-dir reports --no-report
 *   bun run scripts/eval/specialistEval.ts --frontier   # costs real API usage — see README
 *
 * IMPORTANT — this makes LIVE calls to Ollama (http://127.0.0.1:11434) and
 * the Python model bridge (http://127.0.0.1:8756) by default. It does NOT
 * call any paid cloud/frontier model API unless you pass --frontier
 * explicitly (see getFrontierAnswer() below and README.md).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.ts'
import { AskMathModelTool } from '../../src/tools/AskMathModelTool/AskMathModelTool.ts'
import { MATH_MODEL_BASE_URL } from '../../src/tools/AskMathModelTool/constants.ts'
import { DocumentQATool } from '../../src/tools/DocumentQATool/DocumentQATool.ts'
import { ImageCaptionTool } from '../../src/tools/ImageCaptionTool/ImageCaptionTool.ts'
import { MODEL_BRIDGE_BASE_URL } from '../../src/tools/shared/localModelBridge.ts'
import { captionCases, docQACases, mathCases } from './cases.ts'

const FRONTIER_PLACEHOLDER = '(fill in manually or run with --frontier)'
const FRONTIER_CAPTION_NOTE =
  '(vision frontier calls are not wired up in this harness — captions have no text-only frontier equivalent; fill in manually)'

type GroundTruth = 'pass' | 'fail' | 'n/a'

type ReportRow = {
  specialist: 'AskMathModel' | 'DocumentQA' | 'ImageCaption'
  caseId: string
  description: string
  inputSummary: string
  status: 'ok' | 'error' | 'skipped'
  localAnswer: string
  latencyMs: number | null
  confidence: number | null
  groundTruth: GroundTruth
  frontierAnswer: string
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

function isLocalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

function truncate(text: string, max = 400): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * Optional, opt-in-only frontier reference call. OFF by default — only runs
 * when --frontier is passed. Reuses this project's own OpenAI-compatible
 * env vars (OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY), the same shape
 * AskMathModelTool itself already uses for its local call — see README.md
 * for why this design was chosen and what it does NOT cover (vision/captions).
 *
 * Fails soft: any missing config or request failure returns an explanatory
 * string in the frontier column rather than throwing, so --frontier can
 * never crash the harness or silently look like a real answer.
 */
async function getFrontierAnswer(prompt: string): Promise<string> {
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const model = process.env.OPENAI_MODEL
  const apiKey = process.env.OPENAI_API_KEY

  if (!model) {
    return '(frontier skipped: OPENAI_MODEL is not set)'
  }
  if (!apiKey && !isLocalUrl(baseUrl)) {
    return '(frontier skipped: OPENAI_API_KEY is not set for a non-local provider)'
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return `(frontier call failed: ${response.status} ${response.statusText} ${truncate(body, 200)})`
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content?.trim()
    return content && content.length > 0 ? content : '(frontier call returned empty content)'
  } catch (error) {
    return `(frontier call errored: ${String(error)})`
  }
}

function normalizeForMatch(text: string): string {
  return text.replace(/,/g, '')
}

async function runMathCases(rows: ReportRow[], frontier: boolean): Promise<void> {
  const reachable = await isReachable(`${MATH_MODEL_BASE_URL}/models`)
  if (!reachable) {
    console.log(
      `\n[SKIPPED] AskMathModel: Ollama not reachable at ${MATH_MODEL_BASE_URL}. Is it running?`,
    )
    for (const c of mathCases) {
      rows.push({
        specialist: 'AskMathModel',
        caseId: c.id,
        description: c.description,
        inputSummary: c.input.problem,
        status: 'skipped',
        localAnswer: '',
        latencyMs: null,
        confidence: null,
        groundTruth: 'n/a',
        frontierAnswer: '',
        notes: `Ollama unreachable at ${MATH_MODEL_BASE_URL}`,
      })
    }
    return
  }

  console.log('\n=== AskMathModel (VibeThinker-3B via Ollama) ===')
  for (const c of mathCases) {
    process.stdout.write(`  [${c.id}] running… `)
    try {
      const result = await AskMathModelTool.call(c.input, fakeContext())
      const normalized = normalizeForMatch(result.data.answer)
      const passed = c.expectedSubstrings.some(exp => normalized.includes(exp))
      console.log(`done in ${result.data.durationMs}ms — ${passed ? 'PASS' : 'FAIL'}`)

      rows.push({
        specialist: 'AskMathModel',
        caseId: c.id,
        description: c.description,
        inputSummary: c.input.problem,
        status: 'ok',
        localAnswer: result.data.answer,
        latencyMs: result.data.durationMs,
        confidence: null,
        groundTruth: passed ? 'pass' : 'fail',
        frontierAnswer: frontier ? await getFrontierAnswer(c.input.problem) : FRONTIER_PLACEHOLDER,
        notes: result.data.truncated ? 'local response may be truncated (cut off before a clean answer)' : '',
      })
    } catch (error) {
      console.log('ERROR')
      rows.push({
        specialist: 'AskMathModel',
        caseId: c.id,
        description: c.description,
        inputSummary: c.input.problem,
        status: 'error',
        localAnswer: `ERROR: ${String(error)}`,
        latencyMs: null,
        confidence: null,
        groundTruth: 'fail',
        frontierAnswer: frontier ? await getFrontierAnswer(c.input.problem) : FRONTIER_PLACEHOLDER,
        notes: 'tool call threw',
      })
    }
  }
}

async function runDocQACases(rows: ReportRow[], frontier: boolean): Promise<void> {
  const reachable = await isReachable(`${MODEL_BRIDGE_BASE_URL}/health`)
  if (!reachable) {
    console.log(
      `\n[SKIPPED] DocumentQA: Python model bridge not reachable at ${MODEL_BRIDGE_BASE_URL}. Start it with python-bridge/start.ps1.`,
    )
    for (const c of docQACases) {
      rows.push({
        specialist: 'DocumentQA',
        caseId: c.id,
        description: c.description,
        inputSummary: `Q: ${c.input.question}`,
        status: 'skipped',
        localAnswer: '',
        latencyMs: null,
        confidence: null,
        groundTruth: 'n/a',
        frontierAnswer: '',
        notes: `Model bridge unreachable at ${MODEL_BRIDGE_BASE_URL}`,
      })
    }
    return
  }

  console.log('\n=== DocumentQA (DistilBERT-SQuAD via Python bridge) ===')
  for (const c of docQACases) {
    process.stdout.write(`  [${c.id}] running… `)
    const start = Date.now()
    try {
      const result = await DocumentQATool.call(c.input, fakeContext())
      const latencyMs = Date.now() - start

      let groundTruth: GroundTruth = 'n/a'
      let notes = ''
      if (c.expectedSubstring) {
        const passed = result.data.answer.toLowerCase().includes(c.expectedSubstring.toLowerCase())
        groundTruth = passed ? 'pass' : 'fail'
      } else if (c.expectLowConfidence) {
        const lowAsExpected = result.data.score < 0.5
        groundTruth = lowAsExpected ? 'pass' : 'fail'
        notes = `expected low confidence for an unanswerable passage; score=${result.data.score.toFixed(3)}`
      }
      console.log(`done in ${latencyMs}ms — ${groundTruth === 'n/a' ? 'recorded' : groundTruth.toUpperCase()}`)

      const frontierPrompt = `Answer the question using only the passage below.\n\nPassage: """${c.input.context}"""\n\nQuestion: ${c.input.question}\n\nAnswer concisely, using only what's in the passage.`

      rows.push({
        specialist: 'DocumentQA',
        caseId: c.id,
        description: c.description,
        inputSummary: `Q: ${c.input.question}`,
        status: 'ok',
        localAnswer: result.data.answer,
        latencyMs,
        confidence: result.data.score,
        groundTruth,
        frontierAnswer: frontier ? await getFrontierAnswer(frontierPrompt) : FRONTIER_PLACEHOLDER,
        notes,
      })
    } catch (error) {
      console.log('ERROR')
      rows.push({
        specialist: 'DocumentQA',
        caseId: c.id,
        description: c.description,
        inputSummary: `Q: ${c.input.question}`,
        status: 'error',
        localAnswer: `ERROR: ${String(error)}`,
        latencyMs: null,
        confidence: null,
        groundTruth: 'fail',
        frontierAnswer: FRONTIER_PLACEHOLDER,
        notes: 'tool call threw',
      })
    }
  }
}

async function runCaptionCases(rows: ReportRow[]): Promise<void> {
  const reachable = await isReachable(`${MODEL_BRIDGE_BASE_URL}/health`)
  if (!reachable) {
    console.log(
      `\n[SKIPPED] ImageCaption: Python model bridge not reachable at ${MODEL_BRIDGE_BASE_URL}. Start it with python-bridge/start.ps1.`,
    )
    for (const c of captionCases) {
      rows.push({
        specialist: 'ImageCaption',
        caseId: c.id,
        description: c.description,
        inputSummary: c.input.image_path,
        status: 'skipped',
        localAnswer: '',
        latencyMs: null,
        confidence: null,
        groundTruth: 'n/a',
        frontierAnswer: '',
        notes: `Model bridge unreachable at ${MODEL_BRIDGE_BASE_URL}`,
      })
    }
    return
  }

  console.log('\n=== ImageCaption (BLIP via Python bridge) ===')
  for (const c of captionCases) {
    process.stdout.write(`  [${c.id}] running… `)
    const start = Date.now()
    try {
      const result = await ImageCaptionTool.call(c.input, fakeContext())
      const latencyMs = Date.now() - start
      console.log(`done in ${latencyMs}ms`)

      rows.push({
        specialist: 'ImageCaption',
        caseId: c.id,
        description: c.description,
        inputSummary: c.input.image_path,
        status: 'ok',
        localAnswer: result.data.caption,
        latencyMs,
        confidence: null,
        groundTruth: 'n/a',
        frontierAnswer: FRONTIER_CAPTION_NOTE,
        notes: 'no objective ground truth for open-ended captions — subjective, for human/frontier review',
      })
    } catch (error) {
      console.log('ERROR')
      rows.push({
        specialist: 'ImageCaption',
        caseId: c.id,
        description: c.description,
        inputSummary: c.input.image_path,
        status: 'error',
        localAnswer: `ERROR: ${String(error)}`,
        latencyMs: null,
        confidence: null,
        groundTruth: 'n/a',
        frontierAnswer: FRONTIER_CAPTION_NOTE,
        notes: 'tool call threw',
      })
    }
  }
}

function printSummaryTable(rows: ReportRow[]): void {
  console.log('\n=== Summary ===')
  const headers = ['Specialist', 'Case', 'Status', 'GT', 'Conf', 'Latency', 'Local answer (truncated)']
  const widths = [13, 22, 8, 5, 6, 9, 60]

  const pad = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width))

  console.log(headers.map((h, i) => pad(h, widths[i])).join(' | '))
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'))

  for (const row of rows) {
    const cells = [
      row.specialist,
      row.caseId,
      row.status,
      row.groundTruth,
      row.confidence !== null ? row.confidence.toFixed(2) : '-',
      row.latencyMs !== null ? `${row.latencyMs}ms` : '-',
      truncate(row.localAnswer, widths[6]),
    ]
    console.log(cells.map((c, i) => pad(c, widths[i])).join(' | '))
  }

  const graded = rows.filter(r => r.groundTruth === 'pass' || r.groundTruth === 'fail')
  const passed = graded.filter(r => r.groundTruth === 'pass').length
  const skipped = rows.filter(r => r.status === 'skipped').length
  console.log(
    `\n${passed}/${graded.length} graded cases passed` +
      (skipped > 0 ? ` (${skipped} case(s) skipped — see [SKIPPED] messages above)` : ''),
  )
}

function writeJsonReport(path: string, rows: ReportRow[]): void {
  const payload = {
    timestamp: new Date().toISOString(),
    summary: {
      total: rows.length,
      ok: rows.filter(r => r.status === 'ok').length,
      error: rows.filter(r => r.status === 'error').length,
      skipped: rows.filter(r => r.status === 'skipped').length,
      passed: rows.filter(r => r.groundTruth === 'pass').length,
      failed: rows.filter(r => r.groundTruth === 'fail').length,
    },
    rows,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\nJSON report written to ${path}`)
}

function writeMarkdownReport(path: string, rows: ReportRow[]): void {
  const lines: string[] = []
  lines.push('# Specialist head-to-head eval report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push(
    'Frontier column is left blank/marked by default — this harness never spends real API money ' +
      'unless run with `--frontier` and a frontier-model provider explicitly configured. See scripts/eval/README.md.',
  )
  lines.push('')

  const bySpecialist = new Map<string, ReportRow[]>()
  for (const row of rows) {
    const list = bySpecialist.get(row.specialist) ?? []
    list.push(row)
    bySpecialist.set(row.specialist, list)
  }

  for (const [specialist, specialistRows] of bySpecialist) {
    lines.push(`## ${specialist}`)
    lines.push('')
    for (const row of specialistRows) {
      lines.push(`### ${row.caseId}`)
      lines.push('')
      lines.push(`- **Description**: ${row.description}`)
      lines.push(`- **Input**: ${row.inputSummary}`)
      lines.push(`- **Status**: ${row.status}`)
      lines.push(`- **Ground truth**: ${row.groundTruth}`)
      if (row.confidence !== null) lines.push(`- **Confidence**: ${row.confidence.toFixed(3)}`)
      if (row.latencyMs !== null) lines.push(`- **Latency**: ${row.latencyMs}ms`)
      if (row.notes) lines.push(`- **Notes**: ${row.notes}`)
      lines.push(`- **Local answer**:`)
      lines.push('  ```')
      lines.push(`  ${row.localAnswer || '(empty)'}`)
      lines.push('  ```')
      lines.push(`- **Frontier reference answer**: ${row.frontierAnswer || FRONTIER_PLACEHOLDER}`)
      lines.push('')
    }
  }

  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log(`Markdown report written to ${path}`)
}

type CliOptions = {
  specialists: Set<string> | null
  frontier: boolean
  outDir: string
  writeReport: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    specialists: null,
    frontier: false,
    outDir: 'reports',
    writeReport: true,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--frontier') {
      options.frontier = true
      continue
    }
    if (arg === '--no-report') {
      options.writeReport = false
      continue
    }
    if (arg === '--specialist') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        options.specialists = options.specialists ?? new Set()
        options.specialists.add(next)
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

  if (options.frontier) {
    console.log(
      '[WARNING] --frontier is set: this run will attempt one live call per graded case to whatever ' +
        'model is configured via OPENAI_MODEL/OPENAI_BASE_URL/OPENAI_API_KEY. If that points at a real ' +
        'paid provider, this WILL spend real API usage. See scripts/eval/README.md.',
    )
  }

  const rows: ReportRow[] = []
  const wantsAll = options.specialists === null
  const wants = (name: string) => wantsAll || options.specialists!.has(name)

  if (wants('AskMathModel')) await runMathCases(rows, options.frontier)
  if (wants('DocumentQA')) await runDocQACases(rows, options.frontier)
  if (wants('ImageCaption')) await runCaptionCases(rows)

  if (rows.length === 0) {
    console.log('No cases ran (check --specialist filter). Exiting.')
    return
  }

  printSummaryTable(rows)

  if (options.writeReport) {
    const outDir = resolve(process.cwd(), options.outDir)
    mkdirSync(outDir, { recursive: true })
    writeJsonReport(resolve(outDir, 'eval-specialists.json'), rows)
    writeMarkdownReport(resolve(outDir, 'eval-specialists.md'), rows)
  }

  const hasFailure = rows.some(r => r.status === 'error' || r.groundTruth === 'fail')
  if (hasFailure) {
    process.exitCode = 1
  }
}

await main()

export {}
