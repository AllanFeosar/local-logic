import { afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../../Tool.js'
import { ASK_MATH_MODEL_TOOL_NAME } from '../../tools/AskMathModelTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import {
  applySemanticToolPreFilter,
  CORE_TOOL_NAMES,
  shouldApplyToolPreFilter,
  TOOL_PREFILTER_TOP_K,
} from './toolPreFilter.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeTool(name: string, description = name): Tool {
  return {
    name,
    prompt: async () => description,
  } as unknown as Tool
}

const promptOptions = {
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  tools: [] as unknown as Tools,
  agents: [],
}

function mockEmbedFetch(vectors: number[][]): FetchType {
  return (async () => {
    return new Response(JSON.stringify({ embeddings: vectors }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType
}

describe('shouldApplyToolPreFilter', () => {
  test('true only for the openai provider talking to a local base URL', () => {
    expect(shouldApplyToolPreFilter('openai', 'http://localhost:11434/v1')).toBe(true)
    expect(shouldApplyToolPreFilter('openai', 'http://127.0.0.1:11434/v1')).toBe(true)
  })

  test('false for a non-local base URL, even on the openai provider', () => {
    expect(shouldApplyToolPreFilter('openai', 'https://api.openai.com/v1')).toBe(false)
  })

  test('false for every non-openai provider, even with a local-looking base URL — the exact cross-provider leakage this feature must never cause (see this module comment on resolveProviderRequest reading OPENAI_BASE_URL unconditionally)', () => {
    expect(shouldApplyToolPreFilter('firstParty', 'http://localhost:11434/v1')).toBe(false)
    expect(shouldApplyToolPreFilter('bedrock', 'http://localhost:11434/v1')).toBe(false)
    expect(shouldApplyToolPreFilter('vertex', 'http://localhost:11434/v1')).toBe(false)
    expect(shouldApplyToolPreFilter('foundry', 'http://localhost:11434/v1')).toBe(false)
    expect(shouldApplyToolPreFilter('gemini', 'http://localhost:11434/v1')).toBe(false)
    expect(shouldApplyToolPreFilter('github', 'http://localhost:11434/v1')).toBe(false)
    expect(shouldApplyToolPreFilter('codex', 'http://localhost:11434/v1')).toBe(false)
  })

  test('false when baseUrl is undefined', () => {
    expect(shouldApplyToolPreFilter('openai', undefined)).toBe(false)
  })
})

describe('applySemanticToolPreFilter', () => {
  test('returns the input unchanged, with no network call, when the discretionary tail already fits under TOOL_PREFILTER_TOP_K', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error('should not be called')
    }) as unknown as FetchType

    const tools: Tools = [fakeTool(BASH_TOOL_NAME), fakeTool('SomeDiscretionaryTool')]
    const result = await applySemanticToolPreFilter(
      tools,
      'do something',
      promptOptions,
      new AbortController().signal,
    )

    expect(called).toBe(false)
    expect(result).toEqual(tools)
  })

  test('returns the input unchanged when there is no real query text to rank against', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error('should not be called')
    }) as unknown as FetchType

    const discretionary = Array.from({ length: TOOL_PREFILTER_TOP_K + 3 }, (_, i) =>
      fakeTool(`Discretionary${i}`),
    )
    const tools: Tools = [fakeTool(BASH_TOOL_NAME), ...discretionary]
    const result = await applySemanticToolPreFilter(
      tools,
      '   ',
      promptOptions,
      new AbortController().signal,
    )

    expect(called).toBe(false)
    expect(result).toEqual(tools)
  })

  test('always keeps core tools and ToolSearch, ranks the discretionary tail by similarity, and keeps only the top K', async () => {
    const discretionary = Array.from({ length: TOOL_PREFILTER_TOP_K + 3 }, (_, i) =>
      fakeTool(`Discretionary${i}`, `discretionary tool number ${i}`),
    )
    const tools: Tools = [
      fakeTool(BASH_TOOL_NAME),
      fakeTool(ASK_MATH_MODEL_TOOL_NAME),
      fakeTool(TOOL_SEARCH_TOOL_NAME),
      ...discretionary,
    ]

    // query=[1,0]; the first TOOL_PREFILTER_TOP_K discretionary tools are an
    // exact match (sim 1), the rest are orthogonal (sim 0).
    const vectors = [
      [1, 0],
      ...discretionary.map((_, i) => (i < TOOL_PREFILTER_TOP_K ? [1, 0] : [0, 1])),
    ]
    globalThis.fetch = mockEmbedFetch(vectors)

    const result = await applySemanticToolPreFilter(
      tools,
      'relevant query',
      promptOptions,
      new AbortController().signal,
    )
    const resultNames = result.map(t => t.name)

    expect(resultNames).toContain(BASH_TOOL_NAME)
    expect(resultNames).toContain(ASK_MATH_MODEL_TOOL_NAME)
    expect(resultNames).toContain(TOOL_SEARCH_TOOL_NAME)

    const keptDiscretionary = resultNames.filter(n => n.startsWith('Discretionary'))
    expect(keptDiscretionary).toHaveLength(TOOL_PREFILTER_TOP_K)
    for (let i = 0; i < TOOL_PREFILTER_TOP_K; i++) {
      expect(keptDiscretionary).toContain(`Discretionary${i}`)
    }
  })

  test('fails open (returns the unfiltered list) when the embedding endpoint errors', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as unknown as FetchType

    const discretionary = Array.from({ length: TOOL_PREFILTER_TOP_K + 5 }, (_, i) =>
      fakeTool(`Discretionary${i}`),
    )
    const tools: Tools = [fakeTool(BASH_TOOL_NAME), ...discretionary]
    const result = await applySemanticToolPreFilter(
      tools,
      'query',
      promptOptions,
      new AbortController().signal,
    )

    expect(result).toEqual(tools)
  })

  test('fails open when fetch throws (e.g. connection refused)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    const discretionary = Array.from({ length: TOOL_PREFILTER_TOP_K + 5 }, (_, i) =>
      fakeTool(`Discretionary${i}`),
    )
    const tools: Tools = [fakeTool(BASH_TOOL_NAME), ...discretionary]
    const result = await applySemanticToolPreFilter(
      tools,
      'query',
      promptOptions,
      new AbortController().signal,
    )

    expect(result).toEqual(tools)
  })

  test('preserves the original relative order among survivors', async () => {
    const discretionary = Array.from({ length: TOOL_PREFILTER_TOP_K + 2 }, (_, i) =>
      fakeTool(`Discretionary${i}`),
    )
    const tools: Tools = [
      discretionary[0]!,
      fakeTool(BASH_TOOL_NAME),
      discretionary[1]!,
      fakeTool(ASK_MATH_MODEL_TOOL_NAME),
      ...discretionary.slice(2),
    ]
    globalThis.fetch = mockEmbedFetch([[1, 0], ...discretionary.map(() => [1, 0])])

    const result = await applySemanticToolPreFilter(
      tools,
      'query',
      promptOptions,
      new AbortController().signal,
    )
    const resultNames = result.map(t => t.name)
    const survivorNamesInOriginalOrder = tools
      .map(t => t.name)
      .filter(n => resultNames.includes(n))
    expect(resultNames).toEqual(survivorNamesInOriginalOrder)
  })

  test('CORE_TOOL_NAMES includes the built-ins and local-AI specialists the task spec lists', () => {
    for (const name of [
      BASH_TOOL_NAME,
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'TodoWrite',
      'AskUserQuestion',
      ASK_MATH_MODEL_TOOL_NAME,
      'DocumentQA',
      'ImageCaption',
      'DataAnalyze',
    ]) {
      expect(CORE_TOOL_NAMES.has(name)).toBe(true)
    }
  })
})
