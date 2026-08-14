// @ts-nocheck
/**
 * Seed test cases for the DeepSolve pipeline-vs-single-shot eval
 * (scripts/eval/deepSolveEval.ts). Mirrors cases.ts's MathCase shape and
 * conventions.
 *
 * 21 cases (was 9) — grown past the LOCAL_AI_MASTER_PLAN.md §8 Phase 3.5
 * exit gate's ">=20-problem" bar in session 29. The added 12 (deep-10..21)
 * were chosen specifically for the "win zone" the gate actually needs to
 * probe: problems multi-step enough that a strong-but-3B solver
 * (VibeThinker, ~94 AIME) has a *real* single-shot slip probability, yet
 * whose final answer is a single distinctive closed-form number a Tier-1
 * restricted-evaluator check can settle unambiguously (no loops, no
 * simulation — deep-9 remains the deliberate counter-example that Tier 1
 * *cannot* verify, kept on purpose). Every ground truth below was computed
 * independently in Python before being written here (session 29), never
 * taken from memory — same discipline the original 9 used. Distinctive
 * multi-digit answers were preferred over 1-2 digit ones to reduce the
 * harness's known substring-false-match risk (a bare '9' can appear in
 * reasoning that reaches a wrong final answer); a few short answers remain
 * where the problem shape earns its slot.
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

  // === session 29: 12 added to clear the >=20 gate, targeting the win zone ===
  {
    id: 'deep-10-inclusion-exclusion',
    description:
      'Hard — sum of all integers 1..200 divisible by 3 OR 5. Inclusion-exclusion trap: forgetting to subtract ' +
      'the multiples-of-15 overlap double-counts them. Closed-form (three arithmetic-series sums), Tier-1 ' +
      'verifiable. Ground truth computed in Python: 6633 + 4100 - 1365 = 9368.',
    problem:
      'What is the sum of all integers from 1 to 200 (inclusive) that are divisible by 3 or by 5? Show your final answer clearly.',
    expectedSubstrings: ['9368'],
    hard: true,
  },
  {
    id: 'deep-11-binomial',
    description:
      'Medium — a single binomial coefficient C(12,5). Slip-prone by hand (factorial ratio), unambiguous ' +
      'closed-form check. Ground truth: 792.',
    problem: 'How many ways are there to choose 5 items from a set of 12 distinct items (order does not matter)? Show your final answer clearly.',
    expectedSubstrings: ['792'],
  },
  {
    id: 'deep-12-digit-sum-power',
    description:
      'Hard — the flagship silent-slip case: the sum of the decimal digits of 2^100. There is no shortcut; a ' +
      'by-hand solver must actually carry out the 31-digit expansion of 2^100 and then add its digits, with many ' +
      'independent places to slip. A one-line check (sum of digits of pow(2,100)) settles it. Ground truth ' +
      'computed in Python: 2^100 = 1267650600228229401496703205376, digit sum = 115.',
    problem: 'What is the sum of the decimal digits of 2^100? Show your final answer clearly.',
    expectedSubstrings: ['115'],
    hard: true,
  },
  {
    id: 'deep-13-count-with-exclusion',
    description:
      'Medium — how many integers in 1..1000 are divisible by 7 but NOT by 11. Trap: forgetting the "not 11" ' +
      'exclusion (gives 142) or miscounting the multiples of 77. Ground truth: 142 - 12 = 130.',
    problem:
      'How many integers from 1 to 1000 (inclusive) are divisible by 7 but not divisible by 11? Show your final answer clearly.',
    expectedSubstrings: ['130'],
  },
  {
    id: 'deep-14-sum-odd-squares',
    description:
      'Hard — sum of the squares of the first 30 positive odd numbers (1^2 + 3^2 + ... + 59^2). A 30-term sum ' +
      'with real accumulation-error risk done by hand; closed form ((n(2n-1)(2n+1)/3) or direct) is Tier-1 ' +
      'verifiable. Ground truth computed in Python: 35990.',
    problem: 'What is the sum of the squares of the first 30 positive odd numbers (that is, 1^2 + 3^2 + 5^2 + ... + 59^2)? Show your final answer clearly.',
    expectedSubstrings: ['35990'],
    hard: true,
  },
  {
    id: 'deep-15-sum-of-cubes',
    description:
      'Hard-looking, closed-form-clean — sum of cubes 1^3 + ... + 100^3. The elegant check is (100*101/2)^2 = ' +
      '5050^2; a solver that does not recall the identity and adds by hand is very slip-prone, while the ' +
      'identity makes it trivially Tier-1 verifiable. Ground truth: 25502500.',
    problem: 'What is the value of 1^3 + 2^3 + 3^3 + ... + 100^3 (the sum of the cubes of the integers from 1 to 100)? Show your final answer clearly.',
    expectedSubstrings: ['25502500'],
    hard: true,
  },
  {
    id: 'deep-16-mixed-powers',
    description:
      'Medium — evaluate 2^10 + 3^7 + 5^4. Three independent power computations then a sum; each is a place to ' +
      'slip (3^7 especially). Ground truth: 1024 + 2187 + 625 = 3836.',
    problem: 'What is the value of 2^10 + 3^7 + 5^4? Show your final answer clearly.',
    expectedSubstrings: ['3836'],
  },
  {
    id: 'deep-17-compound-growth',
    description:
      'Hard word problem — compound growth with rounding: 5000 grown 8% per year for 3 years, rounded to the ' +
      'nearest whole number. Trap: linear (5000 + 3*8%) instead of compound, or rounding 6298.56 wrong. ' +
      'Ground truth: 5000 * 1.08^3 = 6298.56 -> 6299.',
    problem:
      'A population starts at 5000 and grows by exactly 8% each year. What is the population after 3 years, rounded to the nearest whole number? Show your final answer clearly.',
    expectedSubstrings: ['6299'],
    hard: true,
  },
  {
    id: 'deep-18-polygon-angles',
    description:
      'Medium word problem — sum of interior angles of a 15-sided polygon. Formula (n-2)*180; trap is using ' +
      'n*180 or the exterior-angle 360. Ground truth: 13 * 180 = 2340.',
    problem: 'What is the sum of the interior angles of a polygon with 15 sides, in degrees? Show your final answer clearly.',
    expectedSubstrings: ['2340'],
  },
  {
    id: 'deep-19-percentage-chain',
    description:
      'Medium word problem — chained percentages: of 300 students, 60% are girls, and 25% of the girls play a ' +
      'sport. Trap: taking 25% of all 300, or 60%*25% applied to the wrong base. Ground truth: 300*0.6*0.25 = 45.',
    problem:
      'A school has 300 students. 60% of them are girls. Of the girls, 25% play a sport. How many girls play a sport? Show your final answer clearly.',
    expectedSubstrings: ['45'],
  },
  {
    id: 'deep-20-handshakes',
    description:
      'Medium — classic handshake count for 25 people (each pair shakes once): C(25,2). Trap: 25*25 or 25*24 ' +
      'without halving. Ground truth: 25*24/2 = 300.',
    problem: 'At a party of 25 people, every person shakes hands with every other person exactly once. How many handshakes happen in total? Show your final answer clearly.',
    expectedSubstrings: ['300'],
  },
  {
    id: 'deep-21-modular-power',
    description:
      'Hard — modular exponentiation 13^99 mod 100 (the last two digits of 13^99). A by-hand solver must find ' +
      'the cycle of 13^k mod 100 (period 20) and reduce 99 mod 20 = 19 correctly; many slip points. A one-line ' +
      'pow(13,99,100) settles it. Ground truth computed in Python: 77.',
    problem: 'What are the last two digits of 13^99 (equivalently, 13^99 mod 100)? Show your final answer clearly.',
    expectedSubstrings: ['77'],
    hard: true,
  },
]
