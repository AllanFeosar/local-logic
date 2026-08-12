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
      'total time x speed. Session 11 found this does NOT force simulation-shaped verification in practice — ' +
      'VibeThinker independently produced a closed-form check (closing speed x time), which fits Tier 1\'s ' +
      'restricted grammar fine. Kept as-is (still a genuine solving-step trap); deep-9 below was added ' +
      'specifically because this one turned out not to exercise the "narrows what\'s checkable" cost.',
    problem:
      'Two trains are 300 miles apart and travel toward each other, one at 70 mph and the other at 50 mph. A bird starts at the same time from one train, flying back and forth between the two trains at 90 mph, until the trains meet. How many miles does the bird fly in total? Show your final answer clearly.',
    expectedSubstrings: ['225'],
    hard: true,
  },
  {
    id: 'deep-7-rate-with-drain',
    description:
      'Hard — combined-rate trap with a drain, not just fill rates: pipe A fills in 4h, pipe B fills in 6h, ' +
      'drain C empties in 12h, all three open at once from empty. The trap is treating C as another fill rate ' +
      '(added instead of subtracted) or mishandling the LCD (12) — ground truth verified independently via ' +
      'direct computation (1/4 + 1/6 - 1/12 = 1/3 tank/hour -> 3 hours), not taken on faith.',
    problem:
      'Pipe A fills a tank in 4 hours. Pipe B fills the same tank in 6 hours. Pipe C is a drain that can empty a ' +
      'full tank in 12 hours. If all three are open at once starting from an empty tank, how many hours until ' +
      'the tank is full? Show your final answer clearly.',
    expectedSubstrings: ['3'],
    hard: true,
  },
  {
    id: 'deep-8-committee-restriction',
    description:
      'Hard — combinatorics trap: choosing a committee of 3 from 10 people where two specific people (A and B) ' +
      'refuse to serve together. The trap is forgetting to subtract the A-and-B-together cases at all, or ' +
      'double-subtracting. Ground truth verified independently: C(10,3) - C(8,1) = 120 - 8 = 112, not taken on ' +
      'faith. Verifiable in Tier 1\'s grammar via the factorial-ratio binomial-coefficient formula.',
    problem:
      'A committee of 3 people is chosen from a group of 10 people. Two of the people, Alex and Bailey, refuse ' +
      'to serve on the committee together (a committee containing both of them is not allowed). How many valid ' +
      'committees are possible? Show your final answer clearly.',
    expectedSubstrings: ['112'],
    hard: true,
  },
  {
    id: 'deep-9-collatz-forces-simulation',
    description:
      'Hard, and specifically added (Session 13) to close the gap Session 11/12 flagged: every existing "hard" ' +
      'case turned out to have a closed-form verification check that fits Tier 1\'s restricted grammar, so the ' +
      'grammar\'s own documented "narrows what\'s checkable — no loops, no simulation" cost (LOCAL_AI_MASTER_PLAN.md ' +
      '§11) had never actually been observed happening. The Collatz step count has no known closed-form formula ' +
      '(a famous open property of the conjecture itself) — the only way to compute or verify it is to actually ' +
      'simulate the sequence step by step, which Tier 1\'s grammar cannot express at all (no loops, no ' +
      'iteration, no mutable state). Expect this case to correctly route to \'inconclusive\' (grammar-rejected or ' +
      'no snippet offered, per the rewritten generateCandidates.ts prompt\'s explicit permission to omit an ' +
      'unexpressable check) rather than \'code-verified\' — that outcome is the case succeeding at its purpose, ' +
      'not the harness failing. Ground truth independently computed (a plain step-by-step simulation in Python, ' +
      'not taken from memory): starting from 27, applying "if even, halve; if odd, 3n+1" repeatedly reaches 1 ' +
      'after exactly 111 steps.',
    problem:
      'Starting from the number 27, repeatedly apply this rule: if the number is even, divide it by 2; if it is ' +
      'odd, multiply it by 3 and add 1. Keep applying the rule until you reach 1. How many steps does it take to ' +
      'reach 1? Show your final answer clearly.',
    expectedSubstrings: ['111'],
    hard: true,
  },
]
