// @ts-nocheck
/**
 * Seed prompts for the routing eval (scripts/eval/routingEval.ts). See that
 * file's header comment for how to run this, and LOCAL_AI_MASTER_PLAN.md §6
 * for why this eval exists: the specialists (scripts/eval/specialistEval.ts)
 * are proven to work once invoked directly, but nothing measured whether the
 * router (qwen3:1.7b via Ollama) actually *picks* the right tool in the
 * first place until this file. Session 2 live-testing surfaced a router that
 * hallucinated a call to a nonexistent "math" skill instead of the real
 * AskMathModel tool sitting in its own tool list — this is a tool-selection
 * problem, not a broken tool, and this eval scores exactly that, independent
 * of whether the specialist's eventual answer would have been correct.
 *
 * **Tuning vs holdout split (added session 17/18 — LOCAL_AI_MASTER_PLAN.md
 * §6 "Fix the ruler before chasing the last points").** The original 20
 * cases below (5 math / 5 DocumentQA / 5 ImageCaption / 5 no-tool-needed
 * distractors) are the `tuning` set — they were already used, repeatedly,
 * to build and measure lever F (`routerFewShot.ts`) and lever G
 * (`routerConstrainedToolSelection.ts`), so they're "spent": a model or
 * lever tuned by looking at these specific 20 prompts could be overfitting
 * to them rather than generalizing. 30 new `holdout` cases were added
 * without looking at them while building lever H (self-consistency) or
 * investigating lever I (context hygiene) — they cover the same four
 * categories, with real diversity within each (different phrasings, number
 * formats including comma-formatted numbers matching `routing-math-3`'s own
 * shape, different passage/answer types, different image files/wallpaper
 * themes, different distractor traps including two new tool-specific
 * over-delegation traps for `DataAnalyze` and `ImageCaption`). Use
 * `routingEval.ts --split holdout` to measure only the never-tuned-against
 * set, and `--split tuning` to reproduce the original 20-case numbers.
 * Omitting `--split` runs the full 50-case set (both).
 *
 * 20 original (tuning) + 30 new (holdout) = 50 fixed prompts total: 13
 * math / 12 DocumentQA / 12 ImageCaption / 13 no-tool-needed distractors —
 * catching both under-delegation/hallucination AND over-delegation.
 */

export type ExpectedTool = 'AskMathModel' | 'DocumentQA' | 'ImageCaption' | null

export type RoutingSplit = 'tuning' | 'holdout'

export type RoutingCase = {
  id: string
  category: 'math' | 'docqa' | 'caption' | 'distractor'
  description: string
  prompt: string
  /** null means: no local-AI delegation tool should be called for this prompt. */
  expectedTool: ExpectedTool
  /**
   * 'tuning' = one of the original 20 cases, already used to build/measure
   * levers F and G — treat any score on this split as "seen data".
   * 'holdout' = added session 17/18, never looked at while building lever H
   * or investigating lever I — the set to trust for an unbiased read.
   */
  split: RoutingSplit
}

export const routingCases: RoutingCase[] = [
  // ===========================================================================
  // TUNING SPLIT — the original 20 cases (already used to build/measure F/G)
  // ===========================================================================

  // --- math: should route to AskMathModel (3+ digit operands / multi-step,
  // matching AskMathModelTool's own "when to use" threshold) ---
  {
    id: 'routing-math-1',
    category: 'math',
    description: 'Three-digit multiplication — the exact shape that surfaced the /think-suffix bug',
    prompt: 'What is 847 x 293?',
    expectedTool: 'AskMathModel',
    split: 'tuning',
  },
  {
    id: 'routing-math-2',
    category: 'math',
    description: 'Three-digit multiplication, different operands',
    prompt: 'What is 512 times 768?',
    expectedTool: 'AskMathModel',
    split: 'tuning',
  },
  {
    id: 'routing-math-3',
    category: 'math',
    description: 'Multi-step word problem with 4-digit figures',
    prompt:
      'A theater sold 3,842 tickets on Friday and 2,957 tickets on Saturday. How many tickets did it sell in total across both days?',
    expectedTool: 'AskMathModel',
    split: 'tuning',
  },
  {
    id: 'routing-math-4',
    category: 'math',
    description: 'Division with a 4-digit dividend',
    prompt: 'What is 6734 divided by 29?',
    expectedTool: 'AskMathModel',
    split: 'tuning',
  },
  {
    id: 'routing-math-5',
    category: 'math',
    description: 'Three-digit multiplication phrased as a bare computation',
    prompt: 'Compute 123 * 456.',
    expectedTool: 'AskMathModel',
    split: 'tuning',
  },

  // --- docqa: should route to DocumentQA (a passage is supplied, question is
  // answerable directly from it) ---
  {
    id: 'routing-docqa-1',
    category: 'docqa',
    description: 'Passage + factual question, numeric span answer',
    prompt:
      'Here is a passage: "The Great Wall of China is over 13,000 miles long and was built over many centuries to protect against invasions." Question: How long is the Great Wall of China? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'tuning',
  },
  {
    id: 'routing-docqa-2',
    category: 'docqa',
    description: 'Passage + factual question, noun-phrase answer',
    prompt:
      'Here is a passage: "Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce glucose and oxygen." Question: What two things do plants produce through photosynthesis? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'tuning',
  },
  {
    id: 'routing-docqa-3',
    category: 'docqa',
    description: 'Passage + factual question, numeric span answer',
    prompt:
      'Here is a passage: "The Amazon River flows for approximately 4,000 miles through South America and discharges more water than any other river in the world." Question: Approximately how long is the Amazon River? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'tuning',
  },
  {
    id: 'routing-docqa-4',
    category: 'docqa',
    description: 'Passage + factual question, numeric span with unit',
    prompt:
      'Here is a passage: "Mount Everest, located in the Himalayas, stands at 29,032 feet, making it the tallest mountain above sea level on Earth." Question: How tall is Mount Everest? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'tuning',
  },
  {
    id: 'routing-docqa-5',
    category: 'docqa',
    description: 'Passage + factual question, business/finance framing',
    prompt:
      'Here is a passage from a company report: "In its most recent quarter, Acme Corp reported revenue of $42.5 million, a 12% increase over the prior quarter." Question: What was Acme Corp\'s revenue in its most recent quarter? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'tuning',
  },

  // --- caption: should route to ImageCaption (a real local image path is
  // supplied and a description is requested) ---
  {
    id: 'routing-caption-1',
    category: 'caption',
    description: 'Windows 11 default wallpaper',
    prompt: "Can you describe what's shown in this image: C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg",
    expectedTool: 'ImageCaption',
    split: 'tuning',
  },
  {
    id: 'routing-caption-2',
    category: 'caption',
    description: 'Windows 4K wallpaper, different asset',
    prompt: "What's in this picture? C:/Windows/Web/4K/Wallpaper/Windows/img19_1920x1200.jpg",
    expectedTool: 'ImageCaption',
    split: 'tuning',
  },
  {
    id: 'routing-caption-3',
    category: 'caption',
    description: 'Windows Spotlight screensaver image',
    prompt: 'Please generate a caption for this image file: C:/Windows/Web/Screen/img100.jpg',
    expectedTool: 'ImageCaption',
    split: 'tuning',
  },
  {
    id: 'routing-caption-4',
    category: 'caption',
    description: 'Windows Spotlight screensaver image, different asset',
    prompt: "I have an image at C:/Windows/Web/Screen/img103.jpg — what does it show?",
    expectedTool: 'ImageCaption',
    split: 'tuning',
  },
  {
    id: 'routing-caption-5',
    category: 'caption',
    description: 'Windows default (non-4K) wallpaper',
    prompt: 'Describe the contents of C:/Windows/Web/Wallpaper/Windows/img0.jpg for me.',
    expectedTool: 'ImageCaption',
    split: 'tuning',
  },

  // --- distractor: no local-AI delegation tool should be called ---
  {
    id: 'routing-distractor-1',
    category: 'distractor',
    description:
      'Trivial two-digit multiplication — explicitly BELOW AskMathModelTool\'s own delegation threshold ' +
      '("both operands 2 digits or fewer" -> do not delegate)',
    prompt: 'What is 12 * 7?',
    expectedTool: null,
    split: 'tuning',
  },
  {
    id: 'routing-distractor-2',
    category: 'distractor',
    description: 'Plain conversational greeting, no task at all',
    prompt: "Hi there! How's it going?",
    expectedTool: null,
    split: 'tuning',
  },
  {
    id: 'routing-distractor-3',
    category: 'distractor',
    description: 'Trivial single-digit-ish addition, below the math delegation threshold',
    prompt: 'What is 9 + 16?',
    expectedTool: null,
    split: 'tuning',
  },
  {
    id: 'routing-distractor-4',
    category: 'distractor',
    description:
      'General-knowledge factual question with NO passage supplied — tests over-delegation to DocumentQA, ' +
      'which needs a passage to extract from and should not be called on bare general knowledge',
    prompt: 'What is the capital of France?',
    expectedTool: null,
    split: 'tuning',
  },
  {
    id: 'routing-distractor-5',
    category: 'distractor',
    description: 'Open-ended conversational request with no math/document/image involved',
    prompt: 'Can you give me a fun fact about octopuses?',
    expectedTool: null,
    split: 'tuning',
  },

  // ===========================================================================
  // HOLDOUT SPLIT — 30 new cases (session 17/18), never looked at while
  // building lever H or investigating lever I
  // ===========================================================================

  // --- math (8) ---
  {
    id: 'holdout-math-1',
    category: 'math',
    description: 'Comma-formatted 4-digit subtraction word problem, phrased as "how much more"',
    prompt:
      'A charity raised $4,127 in the spring drive and $1,986 in the fall drive. How much more did the spring drive raise than the fall drive?',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-2',
    category: 'math',
    description: 'Three-digit multiplication, phrased as "multiplied by" rather than "x"/"times"',
    prompt: 'What is 908 multiplied by 34?',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-3',
    category: 'math',
    description:
      'Comma-formatted 4-digit addition word problem — same shape as routing-math-3 (ticket sales across two days), new numbers',
    prompt:
      'A conference sold 5,614 tickets on the first day and 3,289 tickets on the second day. How many tickets were sold in total?',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-4',
    category: 'math',
    description: 'Percentage of a comma-formatted 4-digit number',
    prompt: 'What is 18% of 4,250?',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-5',
    category: 'math',
    description: 'Division with a 4-digit dividend, phrased as "Divide X by Y"',
    prompt: 'Divide 9,408 by 42.',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-6',
    category: 'math',
    description: 'Three-digit subtraction word problem, no comma formatting (numbers under 1,000)',
    prompt: 'A bakery baked 640 cupcakes and sold 275 of them. How many cupcakes are left?',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-7',
    category: 'math',
    description: 'Three-digit multiplication phrased as a bare computation, different operands than routing-math-5',
    prompt: 'Compute 356 * 789.',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },
  {
    id: 'holdout-math-8',
    category: 'math',
    description: 'Multi-step addition with dollar amounts, one comma-formatted 4-digit figure and one 2-digit figure',
    prompt: 'A laptop costs $1,249 and a mouse costs $37. What is the total cost of both items?',
    expectedTool: 'AskMathModel',
    split: 'holdout',
  },

  // --- docqa (7) ---
  {
    id: 'holdout-docqa-1',
    category: 'docqa',
    description: 'Passage + factual question, numeric year answer',
    prompt:
      'Here is a passage: "The first successful powered flight by the Wright brothers took place in 1903, near Kitty Hawk, North Carolina, and lasted just 12 seconds." Question: In what year did the Wright brothers\' first successful powered flight take place? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },
  {
    id: 'holdout-docqa-2',
    category: 'docqa',
    description: 'Passage + factual question, descriptive-phrase answer, biology topic',
    prompt:
      'Here is a passage: "Honeybees communicate the location of food sources to other bees through a series of movements known as the waggle dance." Question: How do honeybees communicate the location of food sources? Answer based only on the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },
  {
    id: 'holdout-docqa-3',
    category: 'docqa',
    description: 'Passage + factual question, comma-formatted numeric answer, business framing (headcount, not revenue)',
    prompt:
      'Here is a passage from a company report: "TechNova Inc. reported having 8,450 employees across 12 countries at the end of last fiscal year." Question: How many employees did TechNova Inc. report at the end of last fiscal year? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },
  {
    id: 'holdout-docqa-4',
    category: 'docqa',
    description: 'Passage + factual question, large numeric span with unit, geography topic',
    prompt:
      'Here is a passage: "Tokyo is the most populous metropolitan area in the world, with over 37 million residents." Question: What is the population of the Tokyo metropolitan area, according to the passage? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },
  {
    id: 'holdout-docqa-5',
    category: 'docqa',
    description: 'Passage + factual question, two-item list answer, biography topic',
    prompt:
      'Here is a passage: "Marie Curie, born in Warsaw in 1867, was the first person to win Nobel Prizes in two different scientific fields: physics and chemistry." Question: In which two scientific fields did Marie Curie win Nobel Prizes? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },
  {
    id: 'holdout-docqa-6',
    category: 'docqa',
    description: 'Passage + factual question, comma-formatted numeric answer plus a reason clause, product-recall framing',
    prompt:
      'Here is a passage: "Acme Motors issued a recall of 214,000 vehicles due to a faulty brake sensor discovered during a routine safety audit." Question: How many vehicles did Acme Motors recall, and why? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },
  {
    id: 'holdout-docqa-7',
    category: 'docqa',
    description: 'Passage + factual question, comma-formatted numeric span with unit, animal-facts topic',
    prompt:
      'Here is a passage: "The Arctic tern completes an annual migration of more than 44,000 miles round trip, the longest of any known animal." Question: According to the passage, how long is the Arctic tern\'s round-trip migration? Answer using only the passage.',
    expectedTool: 'DocumentQA',
    split: 'holdout',
  },

  // --- caption (7) — different files/wallpaper theme folders than the
  // tuning split's cases, and different prompt phrasings ---
  {
    id: 'holdout-caption-1',
    category: 'caption',
    description: 'Windows Spotlight screensaver image, different asset than routing-caption-3/-4',
    prompt: "Can you describe what's shown in this image: C:/Windows/Web/Screen/img101.jpg",
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },
  {
    id: 'holdout-caption-2',
    category: 'caption',
    description: 'Windows Spotlight screensaver image, yet another asset',
    prompt: "What's in this picture? C:/Windows/Web/Screen/img104.jpg",
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },
  {
    id: 'holdout-caption-3',
    category: 'caption',
    description: 'Windows wallpaper theme folder (ThemeA), not previously used',
    prompt: 'Please generate a caption for this image file: C:/Windows/Web/Wallpaper/ThemeA/img20.jpg',
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },
  {
    id: 'holdout-caption-4',
    category: 'caption',
    description: 'Windows wallpaper theme folder (ThemeB), not previously used',
    prompt: 'I have an image at C:/Windows/Web/Wallpaper/ThemeB/img24.jpg — what does it show?',
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },
  {
    id: 'holdout-caption-5',
    category: 'caption',
    description: 'Windows wallpaper theme folder (ThemeC), not previously used',
    prompt: 'Describe the contents of C:/Windows/Web/Wallpaper/ThemeC/img28.jpg for me.',
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },
  {
    id: 'holdout-caption-6',
    category: 'caption',
    description: 'Windows Spotlight wallpaper folder (distinct from the Screen/ screensaver folder), casual phrasing',
    prompt: 'Take a look at C:/Windows/Web/Wallpaper/Spotlight/img14.jpg and tell me what it depicts.',
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },
  {
    id: 'holdout-caption-7',
    category: 'caption',
    description: 'Windows wallpaper theme folder (ThemeD), not previously used, "short description" phrasing',
    prompt: 'Give me a short description of the image at C:/Windows/Web/Wallpaper/ThemeD/img32.jpg.',
    expectedTool: 'ImageCaption',
    split: 'holdout',
  },

  // --- distractor (8) — includes two new tool-specific over-delegation
  // traps (DataAnalyze without any table data; ImageCaption without any
  // real file path) alongside trivial-math and no-passage/no-context traps ---
  {
    id: 'holdout-distractor-1',
    category: 'distractor',
    description: 'Trivial two-digit subtraction — below the math delegation threshold',
    prompt: 'What is 45 - 22?',
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-2',
    category: 'distractor',
    description: 'Plain conversational opener, no task at all',
    prompt: "Good morning! What's new?",
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-3',
    category: 'distractor',
    description: 'Trivial percentage of two 2-digit-or-fewer numbers — below the math delegation threshold',
    prompt: 'How much is 30% of 50?',
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-4',
    category: 'distractor',
    description: 'General-knowledge factual question with no passage supplied — over-delegation trap for DocumentQA',
    prompt: 'Who wrote the play Romeo and Juliet?',
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-5',
    category: 'distractor',
    description: 'Open-ended conversational request with no math/document/image involved',
    prompt: 'Tell me an interesting fact about black holes.',
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-6',
    category: 'distractor',
    description:
      'Mentions "data" and "table" but supplies no actual table data — over-delegation trap for DataAnalyze, ' +
      'which needs real rows/columns to operate on, mirroring routing-distractor-4\'s DocumentQA-no-passage shape',
    prompt: 'Can you analyze the sales data table for me?',
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-7',
    category: 'distractor',
    description:
      'Mentions an image conversationally with no real file path supplied — over-delegation trap for ImageCaption',
    prompt: 'I saw a beautiful sunset today, isn\'t that nice?',
    expectedTool: null,
    split: 'holdout',
  },
  {
    id: 'holdout-distractor-8',
    category: 'distractor',
    description: 'Trivial single-digit addition, different phrasing ("plus" instead of "+") — below the math delegation threshold',
    prompt: "What's 7 plus 8?",
    expectedTool: null,
    split: 'holdout',
  },
]
