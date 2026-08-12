// @ts-nocheck
/**
 * Seed test cases for the DeepSolve pipeline-vs-single-shot eval
 * (scripts/eval/deepSolveEval.ts). Mirrors cases.ts's MathCase shape and
 * conventions. Includes two easy/regression cases (reused verbatim from
 * cases.ts's mathCases so the two harnesses stay comparable), two medium
 * cases, and two genuinely hard cases picked specifically because they are
 * the kind of problem a 3B model's raw mental arithmetic is likely to slip
 * on, but a short Python check can settle unambiguously — exactly the
 * profile DeepSolve's verification step is meant to help with (per
 * LOCAL_AI_MASTER_PLAN.md §11/§8 Phase 3.5's own framing).
 */

export type DeepSolveCase = {
  id: string
  description: string
  problem: string
  expectedSubstrings: string[]
  /** Marks the case as one where a 3B model plausibly gets it wrong
   * single-shot — used only for report annotation, not scoring logic. */
  hard?: boolean
}

export const deepSolveCases: DeepSolveCase[] = [
  {
    id: 'deep-1-basic-mult',
    description: 'Easy baseline — same case as specialist eval math-1, kept for cross-harness comparability',
    problem: 'What is 17 * 23? Show your final answer clearly.',
    expectedSubstrings: ['391'],
  },
  {
    id: 'deep-2-word-problem',
    description: 'Easy word problem, one step beyond raw arithmetic',
    problem:
      'A train travels at 60 miles per hour for 2.5 hours. How many miles does it travel? Show your final answer clearly.',
    expectedSubstrings: ['150'],
  },
  {
    id: 'deep-3-linear-algebra',
    description: 'Medium — multi-step linear equation, single unambiguous numeric answer',
    problem: 'Solve for x: 3(x - 2) + 5 = 2x + 7. Show your final answer clearly.',
    expectedSubstrings: ['x = 8', 'x=8', '8'],
  },
  {
    id: 'deep-4-combinatorics',
    description: 'Medium — permutations with repeated letters, easy to get the repeated-letter correction wrong',
    problem: "How many distinct ways are there to arrange all the letters in the word 'LEVEL'? Show your final answer clearly.",
    expectedSubstrings: ['30'],
  },
  {
    id: 'deep-5-modular-exponentiation',
    description:
      'Hard — modular exponentiation via Fermat\'s little theorem (7^100 mod 13 = 9). This is exactly the ' +
      'profile DeepSolve targets: a 3B model doing this by hand is prone to a silent arithmetic slip, while a ' +
      'one-line Python check (pow(7, 100, 13)) settles it unambiguously.',
    problem: 'What is the remainder when 7^100 is divided by 13? Show your final answer clearly.',
    expectedSubstrings: ['9'],
    hard: true,
  },
  {
    id: 'deep-6-classic-rate-trick',
    description:
      'Hard — the classic "two trains and a bird" rate problem (closing speed 120mph, 2.5h to meet, bird flies ' +
      '225mi) — a well-known trap for naively integrating the bird\'s back-and-forth flight instead of using ' +
      'total time x speed.',
    problem:
      'Two trains are 300 miles apart and travel toward each other, one at 70 mph and the other at 50 mph. A bird starts at the same time from one train, flying back and forth between the two trains at 90 mph, until the trains meet. How many miles does the bird fly in total? Show your final answer clearly.',
    expectedSubstrings: ['225'],
    hard: true,
  },
]
