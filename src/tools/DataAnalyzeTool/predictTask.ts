/**
 * Above this many distinct integer values, label data reads as a
 * continuous/high-cardinality target rather than a class list, regardless
 * of how much repetition there is. TabPFN-v2 (the model this feeds) targets
 * small, clean tabular data per LOCAL_AI_MASTER_PLAN.md §4 — real
 * classification tasks in that regime rarely have more distinct classes
 * than this.
 */
const MAX_PLAUSIBLE_CLASS_COUNT = 20

/**
 * Above this fraction of labels being distinct, there isn't enough
 * repetition to read as a class list even if the absolute count is small
 * (e.g. 8 samples with 8 distinct integer values has no repeats at all —
 * that's a continuous-looking sample, not 8 classes of 1 example each).
 */
const MAX_UNIQUE_RATIO_FOR_DISCRETE = 0.5

/**
 * Infers whether a "predict" operation should run as classification or
 * regression when the caller didn't specify `task` explicitly.
 *
 * Any non-numeric label makes classification unambiguous. All-numeric
 * labels are the genuinely ambiguous case in practice — 0/1 flags and
 * small class IDs are extremely common label encodings that are still
 * classification, not regression. This uses a "looks discrete" heuristic:
 * integer-valued labels with a small, repeated set of distinct values read
 * as class codes (classify); everything else — fractional values, or
 * integer values with little/no repetition such as near-unique
 * price/quantity data — reads as a continuous target (regress).
 *
 * This is a convenience default, not a guarantee: genuinely ambiguous
 * numeric-label data (e.g. a bounded integer range with heavy repetition
 * that is nonetheless a real regression target, like ages or 1-5 ratings)
 * can fool it. Callers that know which they want should pass `task`
 * explicitly rather than rely on this — see DataAnalyzeTool's prompt.ts,
 * which tells the router exactly that.
 */
export function inferPredictTask(
  labels: ReadonlyArray<string | number>,
): 'classify' | 'regress' {
  if (labels.length === 0) return 'classify'
  if (labels.some(label => typeof label === 'string')) return 'classify'

  const numericLabels = labels as number[]
  const allIntegers = numericLabels.every(value => Number.isInteger(value))
  const uniqueCount = new Set(numericLabels).size
  const uniqueRatio = uniqueCount / numericLabels.length
  const looksDiscrete =
    allIntegers &&
    uniqueCount <= MAX_PLAUSIBLE_CLASS_COUNT &&
    uniqueRatio <= MAX_UNIQUE_RATIO_FOR_DISCRETE

  return looksDiscrete ? 'classify' : 'regress'
}
