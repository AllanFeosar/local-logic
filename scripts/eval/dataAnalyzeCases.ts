// @ts-nocheck
/**
 * Seed test cases for the DataAnalyzeTool eval harness
 * (scripts/eval/dataAnalyzeEval.ts). See that file's header comment for how
 * to run this, and cases.ts/specialistEval.ts in this directory for the
 * sibling harness this one deliberately mirrors in shape/conventions.
 *
 * Built per LOCAL_AI_STATUS.md's Session 3b open item: "a small
 * DataAnalyze-specific eval set... to properly characterize /table-qa's
 * real accuracy rather than relying on ad hoc spot-checks." The Session 3b
 * spot-check found TabPFN/Chronos looking correct but TAPAS
 * (tapas-mini-finetuned-wtq) failing a basic cross-column conditional
 * lookup ("What is the revenue of Gadget?" returned Widget's revenue
 * instead) while a same-column echo question worked. Every case below has
 * an objective, locally-computable ground truth — no frontier call is
 * needed or used anywhere in this file (unlike specialistEval.ts's
 * `--frontier` opt-in for math/DocQA, there is no meaningful "ask a
 * frontier LLM the same tabular-ML question" comparison for predict/
 * forecast, and the question-answering ground truth here is fully
 * checkable by construction since we authored the tables ourselves).
 */

// ---------------------------------------------------------------------------
// operation "question" (TAPAS / tapas-mini-finetuned-wtq via /table-qa)
// ---------------------------------------------------------------------------

export type TableQACategory = 'same-column' | 'cross-column' | 'aggregation'

export type TableQACase = {
  id: string
  description: string
  /** Used to break down pass rate by difficulty class in the report — the
   * whole point of this harness is answering "does the cross-column/
   * aggregation weakness found in the Session 3b spot-check hold up". */
  category: TableQACategory
  input: {
    question: string
    table: { columns: string[]; rows: string[][] }
  }
  /** Case-insensitive substring match against the model's answer, comma-
   * stripped and trimmed first (mirrors specialistEval.ts's
   * normalizeForMatch). ANY of these matching counts as a pass — covers
   * "800" vs "800.0" vs "$800" style formatting variance without
   * over-constraining exact wording. */
  expectedSubstrings: string[]
}

const productsTable = {
  columns: ['Product', 'Revenue', 'Units Sold', 'Region'],
  rows: [
    ['Widget', '500', '100', 'North'],
    ['Gadget', '800', '50', 'South'],
    ['Gizmo', '300', '200', 'East'],
  ],
}

const citiesTable = {
  columns: ['City', 'Population', 'Country'],
  rows: [
    ['Springfield', '120000', 'USA'],
    ['Shelbyville', '95000', 'USA'],
    ['Ogdenville', '60000', 'USA'],
  ],
}

const employeesTable = {
  columns: ['Name', 'Department', 'Salary', 'Years'],
  rows: [
    ['Alice', 'Engineering', '95000', '5'],
    ['Bob', 'Sales', '72000', '3'],
    ['Carol', 'Engineering', '110000', '8'],
    ['Dave', 'Marketing', '68000', '2'],
  ],
}

export const tableQACases: TableQACase[] = [
  // --- same-column lookups: the kind that worked in the Session 3b spot-check ---
  {
    id: 'q-1-same-column-echo-product',
    description:
      'Same-column echo lookup (the style that worked in the Session 3b spot-check): the question names a ' +
      'value already present in the Product column and asks to identify that same row by it.',
    category: 'same-column',
    input: { question: 'Which product is Gizmo?', table: productsTable },
    expectedSubstrings: ['gizmo'],
  },
  {
    id: 'q-2-same-column-echo-city',
    description: 'Same-column echo lookup on a different table, to check the pattern generalizes beyond one fixture.',
    category: 'same-column',
    input: { question: 'Which city is Springfield?', table: citiesTable },
    expectedSubstrings: ['springfield'],
  },

  // --- cross-column lookups: the kind that failed in the Session 3b spot-check ---
  {
    id: 'q-3-cross-column-revenue-of-gadget',
    description:
      'Exact replica of the Session 3b spot-check failure: "What is the revenue of Gadget?" incorrectly ' +
      'returned Widget\'s revenue (a different row) instead of Gadget\'s.',
    category: 'cross-column',
    input: { question: 'What is the revenue of Gadget?', table: productsTable },
    expectedSubstrings: ['800'],
  },
  {
    id: 'q-4-cross-column-population-of-shelbyville',
    description: 'Cross-column lookup on a different table/column pair (City -> Population).',
    category: 'cross-column',
    input: { question: 'What is the population of Shelbyville?', table: citiesTable },
    expectedSubstrings: ['95000', '95,000'],
  },
  {
    id: 'q-5-cross-column-reverse-region-to-product',
    description:
      'Cross-column lookup in the reverse direction from case 3 (filter by Region, return Product) — checks ' +
      'whether the failure is specific to one column-pair direction or general.',
    category: 'cross-column',
    input: { question: 'Which product is in the South region?', table: productsTable },
    expectedSubstrings: ['gadget'],
  },
  {
    id: 'q-6-cross-column-department-of-carol',
    description: 'Cross-column lookup on a third, unrelated table (Name -> Department).',
    category: 'cross-column',
    input: { question: 'What department is Carol in?', table: employeesTable },
    expectedSubstrings: ['engineering'],
  },

  // --- aggregation: the exact failure case named in the master plan/status doc ---
  {
    id: 'q-7-aggregation-max-revenue',
    description:
      'Aggregation (max) — this exact question ("which product has the highest revenue") is named directly in ' +
      'LOCAL_AI_STATUS.md/LOCAL_AI_MASTER_PLAN.md as a case worth checking; the tool\'s own prompt.ts lists ' +
      '"which row has the highest revenue" as an in-scope example use case.',
    category: 'aggregation',
    input: { question: 'Which product has the highest revenue?', table: productsTable },
    expectedSubstrings: ['gadget'],
  },
  {
    id: 'q-8-aggregation-count-filtered',
    description: 'Aggregation (count) with a filter condition — a harder aggregation shape than a plain max/min.',
    category: 'aggregation',
    input: { question: 'How many employees work in Engineering?', table: employeesTable },
    expectedSubstrings: ['2'],
  },
]

// ---------------------------------------------------------------------------
// operation "predict" (TabPFN-v2 via /tabular-predict)
// ---------------------------------------------------------------------------

export type PredictClassifyCase = {
  id: string
  description: string
  input: {
    task: 'classify'
    train_features: number[][]
    train_labels: Array<string | number>
    test_features: number[][]
  }
  /** One expected label per test_features row, same order. Test points are
   * deliberately placed well inside each cluster (not near the decision
   * boundary) so the ground truth is unambiguous. */
  expectedLabels: Array<string | number>
}

export type PredictRegressCase = {
  id: string
  description: string
  input: {
    task: 'regress'
    train_features: number[][]
    train_labels: number[]
    test_features: number[][]
  }
  /** One expected value per test_features row, same order — computed from
   * the exact (noiseless) linear relationship the training data was
   * generated from. */
  expectedValues: number[]
  /** Absolute tolerance per prediction. Training data is a perfect line, so
   * these are kept tight but not exact-match — TabPFN is a zero-shot
   * approximator, not a closed-form solver. */
  tolerance: number
}

export type PredictCase = PredictClassifyCase | PredictRegressCase

function classifyRange(count: number, start: number, step: number): number[][] {
  return Array.from({ length: count }, (_, i) => [start + i * step])
}

export const predictCases: PredictCase[] = [
  {
    id: 'predict-1-classify-2class-2d',
    description:
      'Binary classification, well-separated 2D clusters (centroids ~10 units apart). Test points are placed ' +
      'close to their cluster centroid, not near the midpoint, so the correct side of the decision boundary is unambiguous.',
    input: {
      task: 'classify',
      train_features: [
        [0, 0], [0, 1], [1, 0], [1, 1], [0.5, 0.5],
        [10, 10], [10, 11], [11, 10], [11, 11], [10.5, 10.5],
      ],
      train_labels: ['low', 'low', 'low', 'low', 'low', 'high', 'high', 'high', 'high', 'high'],
      test_features: [[0.2, 0.3], [10.8, 10.6], [0.9, 0.4], [9.6, 10.9]],
    },
    expectedLabels: ['low', 'high', 'low', 'high'],
  },
  {
    id: 'predict-2-classify-3class-1d',
    description: '3-class classification along a single well-separated axis (three clusters ~10 units apart).',
    input: {
      task: 'classify',
      train_features: [
        ...classifyRange(4, 0, 1),
        ...classifyRange(4, 10, 1),
        ...classifyRange(4, 20, 1),
      ],
      train_labels: [
        'small', 'small', 'small', 'small',
        'medium', 'medium', 'medium', 'medium',
        'large', 'large', 'large', 'large',
      ],
      test_features: [[1.5], [11.5], [21.5], [2.5]],
    },
    expectedLabels: ['small', 'medium', 'large', 'small'],
  },
  {
    id: 'predict-3-regress-linear-1feature',
    description: 'Single-feature linear regression on a noiseless line: y = 2x + 1.',
    input: {
      task: 'regress',
      train_features: [[1], [2], [3], [4], [5], [6], [7], [8]],
      train_labels: [3, 5, 7, 9, 11, 13, 15, 17],
      test_features: [[9], [12], [15]],
    },
    expectedValues: [19, 25, 31],
    tolerance: 3,
  },
  {
    id: 'predict-4-regress-linear-2feature',
    description: 'Two-feature linear regression on a noiseless plane: y = 3*x1 + 2*x2 + 1, trained on a full 4x4 grid.',
    input: {
      task: 'regress',
      train_features: [0, 1, 2, 3].flatMap(x1 => [0, 1, 2, 3].map(x2 => [x1, x2])),
      train_labels: [0, 1, 2, 3].flatMap(x1 => [0, 1, 2, 3].map(x2 => 3 * x1 + 2 * x2 + 1)),
      test_features: [[3.5, 3.5], [1, 2.5], [0, 0]],
    },
    expectedValues: [18.5, 9, 1],
    tolerance: 3,
  },
]

// ---------------------------------------------------------------------------
// operation "forecast" (Chronos-t5-tiny via /forecast)
// ---------------------------------------------------------------------------

export type ForecastCase = {
  id: string
  description: string
  input: { series: number[]; horizon: number }
  /** Expected continuation, length = horizon. */
  expectedForecast: number[]
  /** Absolute tolerance per forecasted point for the "right ballpark" check. */
  tolerance: number
}

export const forecastCases: ForecastCase[] = [
  {
    id: 'forecast-1-linear-trend-short',
    description: 'Short, clean arithmetic progression (step +2) — same shape as DataAnalyzeTool.live.test.ts\'s fixture.',
    input: { series: [10, 12, 14, 16, 18, 20], horizon: 3 },
    expectedForecast: [22, 24, 26],
    tolerance: 3,
  },
  {
    id: 'forecast-2-linear-trend-longer',
    description: 'Longer arithmetic progression (step +5, 10 points of history) — more context for the model to lock onto the trend.',
    input: { series: [100, 105, 110, 115, 120, 125, 130, 135, 140, 145], horizon: 4 },
    expectedForecast: [150, 155, 160, 165],
    tolerance: 6,
  },
  {
    id: 'forecast-3-simple-seasonality',
    description:
      'Simple repeating period-4 seasonal pattern (10, 15, 10, 5 repeating). Tolerance is looser than the trend ' +
      'cases — capturing seasonality zero-shot from a tiny model is a genuinely harder ask than a monotonic trend, ' +
      'so this checks "roughly follows the cycle", not exact reproduction.',
    input: { series: [10, 15, 10, 5, 10, 15, 10, 5, 10, 15, 10, 5], horizon: 4 },
    expectedForecast: [10, 15, 10, 5],
    tolerance: 6,
  },
]
