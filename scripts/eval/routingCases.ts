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
 * 20 fixed prompts: 5 should route to AskMathModel, 5 to DocumentQA, 5 to
 * ImageCaption, and 5 are deliberate no-tool-needed distractors (trivial
 * arithmetic below AskMathModelTool's own delegation threshold, or plain
 * conversational/general-knowledge questions with no supplied passage) —
 * catching both under-delegation/hallucination AND over-delegation.
 */

export type ExpectedTool = 'AskMathModel' | 'DocumentQA' | 'ImageCaption' | null

export type RoutingCase = {
  id: string
  category: 'math' | 'docqa' | 'caption' | 'distractor'
  description: string
  prompt: string
  /** null means: no local-AI delegation tool should be called for this prompt. */
  expectedTool: ExpectedTool
}

export const routingCases: RoutingCase[] = [
  // --- math: should route to AskMathModel (3+ digit operands / multi-step,
  // matching AskMathModelTool's own "when to use" threshold) ---
  {
    id: 'routing-math-1',
    category: 'math',
    description: 'Three-digit multiplication — the exact shape that surfaced the /think-suffix bug',
    prompt: 'What is 847 x 293?',
    expectedTool: 'AskMathModel',
  },
  {
    id: 'routing-math-2',
    category: 'math',
    description: 'Three-digit multiplication, different operands',
    prompt: 'What is 512 times 768?',
    expectedTool: 'AskMathModel',
  },
  {
    id: 'routing-math-3',
    category: 'math',
    description: 'Multi-step word problem with 4-digit figures',
    prompt:
      'A theater sold 3,842 tickets on Friday and 2,957 tickets on Saturday. How many tickets did it sell in total across both days?',
    expectedTool: 'AskMathModel',
  },
  {
    id: 'routing-math-4',
    category: 'math',
    description: 'Division with a 4-digit dividend',
    prompt: 'What is 6734 divided by 29?',
    expectedTool: 'AskMathModel',
  },
  {
    id: 'routing-math-5',
    category: 'math',
    description: 'Three-digit multiplication phrased as a bare computation',
    prompt: 'Compute 123 * 456.',
    expectedTool: 'AskMathModel',
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
  },
  {
    id: 'routing-docqa-2',
    category: 'docqa',
    description: 'Passage + factual question, noun-phrase answer',
    prompt:
      'Here is a passage: "Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce glucose and oxygen." Question: What two things do plants produce through photosynthesis? Answer using only the passage.',
    expectedTool: 'DocumentQA',
  },
  {
    id: 'routing-docqa-3',
    category: 'docqa',
    description: 'Passage + factual question, numeric span answer',
    prompt:
      'Here is a passage: "The Amazon River flows for approximately 4,000 miles through South America and discharges more water than any other river in the world." Question: Approximately how long is the Amazon River? Answer using only the passage.',
    expectedTool: 'DocumentQA',
  },
  {
    id: 'routing-docqa-4',
    category: 'docqa',
    description: 'Passage + factual question, numeric span with unit',
    prompt:
      'Here is a passage: "Mount Everest, located in the Himalayas, stands at 29,032 feet, making it the tallest mountain above sea level on Earth." Question: How tall is Mount Everest? Answer using only the passage.',
    expectedTool: 'DocumentQA',
  },
  {
    id: 'routing-docqa-5',
    category: 'docqa',
    description: 'Passage + factual question, business/finance framing',
    prompt:
      'Here is a passage from a company report: "In its most recent quarter, Acme Corp reported revenue of $42.5 million, a 12% increase over the prior quarter." Question: What was Acme Corp\'s revenue in its most recent quarter? Answer using only the passage.',
    expectedTool: 'DocumentQA',
  },

  // --- caption: should route to ImageCaption (a real local image path is
  // supplied and a description is requested) ---
  {
    id: 'routing-caption-1',
    category: 'caption',
    description: 'Windows 11 default wallpaper',
    prompt: "Can you describe what's shown in this image: C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg",
    expectedTool: 'ImageCaption',
  },
  {
    id: 'routing-caption-2',
    category: 'caption',
    description: 'Windows 4K wallpaper, different asset',
    prompt: "What's in this picture? C:/Windows/Web/4K/Wallpaper/Windows/img19_1920x1200.jpg",
    expectedTool: 'ImageCaption',
  },
  {
    id: 'routing-caption-3',
    category: 'caption',
    description: 'Windows Spotlight screensaver image',
    prompt: 'Please generate a caption for this image file: C:/Windows/Web/Screen/img100.jpg',
    expectedTool: 'ImageCaption',
  },
  {
    id: 'routing-caption-4',
    category: 'caption',
    description: 'Windows Spotlight screensaver image, different asset',
    prompt: "I have an image at C:/Windows/Web/Screen/img103.jpg — what does it show?",
    expectedTool: 'ImageCaption',
  },
  {
    id: 'routing-caption-5',
    category: 'caption',
    description: 'Windows default (non-4K) wallpaper',
    prompt: 'Describe the contents of C:/Windows/Web/Wallpaper/Windows/img0.jpg for me.',
    expectedTool: 'ImageCaption',
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
  },
  {
    id: 'routing-distractor-2',
    category: 'distractor',
    description: 'Plain conversational greeting, no task at all',
    prompt: "Hi there! How's it going?",
    expectedTool: null,
  },
  {
    id: 'routing-distractor-3',
    category: 'distractor',
    description: 'Trivial single-digit-ish addition, below the math delegation threshold',
    prompt: 'What is 9 + 16?',
    expectedTool: null,
  },
  {
    id: 'routing-distractor-4',
    category: 'distractor',
    description:
      'General-knowledge factual question with NO passage supplied — tests over-delegation to DocumentQA, ' +
      'which needs a passage to extract from and should not be called on bare general knowledge',
    prompt: 'What is the capital of France?',
    expectedTool: null,
  },
  {
    id: 'routing-distractor-5',
    category: 'distractor',
    description: 'Open-ended conversational request with no math/document/image involved',
    prompt: 'Can you give me a fun fact about octopuses?',
    expectedTool: null,
  },
]
