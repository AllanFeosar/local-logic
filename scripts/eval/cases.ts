// @ts-nocheck
/**
 * Seed test cases for the specialist head-to-head eval harness
 * (scripts/eval/specialistEval.ts). See that file's header comment for how
 * to run this and README.md in this directory for the full writeup.
 *
 * Cases are adapted from each tool's own `.live.test.ts` fixture (the same
 * inputs already proven to work end-to-end against the live models), plus a
 * few additions to get 3-5 cases per specialist and at least one
 * ground-truth-checkable case beyond the original fixture.
 */

/** Any-of match: the local answer is normalized (commas stripped) and
 * checked for ANY of these substrings — covers "391" vs "the answer is 391"
 * vs "391." phrasing without over-constraining exact wording. */
export type MathCase = {
  id: string
  description: string
  input: { problem: string }
  expectedSubstrings: string[]
}

export type DocQACase = {
  id: string
  description: string
  input: { question: string; context: string }
  /** Omit for cases with no ground truth to assert against (e.g. the
   * deliberately-unanswerable probe below) — those are recorded, not graded. */
  expectedSubstring?: string
  /** True for cases where the passage does NOT contain the answer — the
   * "correct" behavior is a low confidence score, not a specific string. */
  expectLowConfidence?: boolean
}

export type CaptionCase = {
  id: string
  description: string
  input: { image_path: string }
  // No objective ground truth for open-ended captions of abstract art —
  // subjective by nature. Recorded for human/frontier review, not graded.
}

export const mathCases: MathCase[] = [
  {
    id: 'math-1-basic-mult',
    description: 'Basic two-digit multiplication (from AskMathModelTool.live.test.ts)',
    input: { problem: 'What is 17 * 23? Show your final answer clearly.' },
    expectedSubstrings: ['391'],
  },
  {
    id: 'math-2-three-digit-mult',
    description:
      'Three-digit multiplication — this exact prompt ("847 x 293") is the one that surfaced ' +
      'the Ollama /think-suffix bug documented in LOCAL_AI_STATUS.md; keeps that regression covered.',
    input: { problem: 'What is 847 x 293? Show your final answer clearly.' },
    expectedSubstrings: ['248171', '248,171'],
  },
  {
    id: 'math-3-small-mult',
    description: 'Small multiplication, referenced in LOCAL_AI_STATUS.md open items as a re-verification prompt',
    input: { problem: 'What is 12 * 7? Show your final answer clearly.' },
    expectedSubstrings: ['84'],
  },
  {
    id: 'math-4-word-problem',
    description: 'Simple rate/time word problem — one step of reasoning beyond raw arithmetic',
    input: {
      problem:
        'A train travels at 60 miles per hour for 2.5 hours. How many miles does it travel? Show your final answer clearly.',
    },
    expectedSubstrings: ['150'],
  },
]

export const docQACases: DocQACase[] = [
  {
    id: 'qa-1-sky-color',
    description: 'Original fixture from DocumentQATool.live.test.ts',
    input: {
      question: 'What color is the sky?',
      context:
        'On a clear day, the sky appears blue due to Rayleigh scattering of sunlight in the atmosphere.',
    },
    expectedSubstring: 'blue',
  },
  {
    id: 'qa-2-capital-of-france',
    description: 'Simple factual extraction',
    input: {
      question: 'What is the capital of France?',
      context:
        'Paris is the capital and most populous city of France. It sits on the Seine river in the north of the country.',
    },
    expectedSubstring: 'Paris',
  },
  {
    id: 'qa-3-numeric-span',
    description: 'Numeric/unit span extraction — checks the model can grab a measurement, not just a proper noun',
    input: {
      question: 'How tall is the Eiffel Tower?',
      context:
        'The Eiffel Tower was completed in 1889 and stands 330 metres tall, making it one of the most recognizable structures in the world.',
    },
    expectedSubstring: '330',
  },
  {
    id: 'qa-4-answer-not-present',
    description:
      'Deliberately unanswerable: the passage does not contain the answer. Correct behavior is a LOW confidence ' +
      'score, not a confident-sounding wrong span — this is the failure mode the DocumentQATool description warns about.',
    input: {
      question: 'What is the population of Mars?',
      context:
        'On a clear day, the sky appears blue due to Rayleigh scattering of sunlight in the atmosphere.',
    },
    expectLowConfidence: true,
  },
]

export const captionCases: CaptionCase[] = [
  {
    id: 'caption-1-windows11-hero',
    description: 'Original fixture from ImageCaptionTool.live.test.ts (Windows 11 default wallpaper, blue abstract)',
    input: { image_path: 'C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg' },
  },
  {
    id: 'caption-2-screensaver-blue',
    description: 'Windows Spotlight screensaver image, abstract blue swirl (different asset than case 1)',
    input: { image_path: 'C:/Windows/Web/Screen/img100.jpg' },
  },
  {
    id: 'caption-3-screensaver-warm',
    description: 'Windows Spotlight screensaver image, abstract warm-toned swirl (visually distinct color palette)',
    input: { image_path: 'C:/Windows/Web/Screen/img103.jpg' },
  },
]
