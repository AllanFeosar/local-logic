import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { DataAnalyzeTool } from './DataAnalyzeTool.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

function mockFetchOnce(status: number, body: unknown): { requests: Array<{ url: string; body: unknown }> } {
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType
  return { requests }
}

describe('operation "question" -> /table-qa', () => {
  test('mocked: sends question/table to the bridge and returns the parsed answer', async () => {
    const { requests } = mockFetchOnce(200, {
      answer: '42',
      cells: [{ row: 1, column: 2 }],
    })

    const result = await DataAnalyzeTool.call(
      {
        operation: 'question',
        question: 'What is the total?',
        table: { columns: ['Item', 'Qty', 'Total'], rows: [['A', '1', '10'], ['B', '2', '42']] },
      },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/table-qa')
    expect(requests[0]?.body).toEqual({
      question: 'What is the total?',
      table: { columns: ['Item', 'Qty', 'Total'], rows: [['A', '1', '10'], ['B', '2', '42']] },
    })
    expect(result.data).toEqual({
      operation: 'question',
      answer: '42',
      cells: [{ row: 1, column: 2 }],
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam flags an ungrounded answer', () => {
    const block = DataAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'question', answer: 'unclear', cells: [] },
      'tool_1',
    )
    expect(block.content).toContain('did not ground')
  })

  test('mocked: mapToolResultToToolResultBlockParam reports grounded cell count otherwise', () => {
    const block = DataAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'question', answer: '42', cells: [{ row: 1, column: 2 }] },
      'tool_1',
    )
    expect(block.content).toBe('42 (grounded in 1 cell)')
  })
})

describe('operation "predict" -> /tabular-predict', () => {
  test('mocked: sends explicit task through to the bridge as "operation"', async () => {
    const { requests } = mockFetchOnce(200, {
      predictions: ['yes', 'no'],
      probabilities: [[0.9, 0.1], [0.2, 0.8]],
    })

    const result = await DataAnalyzeTool.call(
      {
        operation: 'predict',
        task: 'classify',
        train_features: [[1, 2], [3, 4]],
        train_labels: ['yes', 'no'],
        test_features: [[5, 6], [7, 8]],
      },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/tabular-predict')
    expect(requests[0]?.body).toEqual({
      operation: 'classify',
      train_features: [[1, 2], [3, 4]],
      train_labels: ['yes', 'no'],
      test_features: [[5, 6], [7, 8]],
    })
    expect(result.data).toEqual({
      operation: 'predict',
      task: 'classify',
      predictions: ['yes', 'no'],
      probabilities: [[0.9, 0.1], [0.2, 0.8]],
    })
  })

  test('mocked: infers "regress" for near-unique numeric labels when task is omitted', async () => {
    const { requests } = mockFetchOnce(200, { predictions: [123.4] })

    const result = await DataAnalyzeTool.call(
      {
        operation: 'predict',
        train_features: [[1], [2], [3], [4], [5], [6], [7], [8]],
        train_labels: [150000, 210000, 305000, 98000, 415000, 260000, 175000, 330000],
        test_features: [[9]],
      },
      fakeContext(),
    )

    expect(requests[0]?.body).toMatchObject({ operation: 'regress' })
    expect(result.data.task).toBe('regress')
  })

  test('mocked: infers "classify" for binary numeric labels when task is omitted', async () => {
    const { requests } = mockFetchOnce(200, { predictions: [1] })
    const trainLabels = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0 : 1))

    const result = await DataAnalyzeTool.call(
      {
        operation: 'predict',
        train_features: trainLabels.map((_, i) => [i]),
        train_labels: trainLabels,
        test_features: [[99]],
      },
      fakeContext(),
    )

    expect(requests[0]?.body).toMatchObject({ operation: 'classify' })
    expect(result.data.task).toBe('classify')
  })

  test('mocked: mapToolResultToToolResultBlockParam includes task and predictions', () => {
    const block = DataAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'predict', task: 'regress', predictions: [123.4] },
      'tool_1',
    )
    expect(block.content).toContain('Task: regress')
    expect(block.content).toContain('123.4')
  })
})

describe('operation "forecast" -> /forecast', () => {
  test('mocked: sends series/horizon to the bridge and returns the parsed forecast', async () => {
    const { requests } = mockFetchOnce(200, {
      forecast: [10, 11, 12],
      low: [8, 9, 10],
      high: [12, 13, 14],
    })

    const result = await DataAnalyzeTool.call(
      { operation: 'forecast', series: [5, 6, 7, 8, 9], horizon: 3 },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/forecast')
    expect(requests[0]?.body).toEqual({ series: [5, 6, 7, 8, 9], horizon: 3 })
    expect(result.data).toEqual({
      operation: 'forecast',
      forecast: [10, 11, 12],
      low: [8, 9, 10],
      high: [12, 13, 14],
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam includes the range when bounds are present', () => {
    const block = DataAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'forecast', forecast: [10, 11], low: [8, 9], high: [12, 13] },
      'tool_1',
    )
    expect(block.content).toContain('Forecast:')
    expect(block.content).toContain('Range:')
  })
})

describe('error handling', () => {
  test('mocked: raises a clear error when the bridge is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    await expect(
      DataAnalyzeTool.call(
        { operation: 'forecast', series: [1, 2, 3], horizon: 1 },
        fakeContext(),
      ),
    ).rejects.toThrow(/Could not reach the local model bridge/)
  })

  test('mocked: raises a clear error on a non-ok bridge response', async () => {
    mockFetchOnce(400, { detail: 'inconsistent row lengths' })

    await expect(
      DataAnalyzeTool.call(
        {
          operation: 'question',
          question: 'x',
          table: { columns: ['a'], rows: [['1']] },
        },
        fakeContext(),
      ),
    ).rejects.toThrow(/DataAnalyze request to \/table-qa failed: 400/)
  })

  test('mocked: call() rejects malformed input (predict missing train_labels) before touching the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as FetchType

    await expect(
      DataAnalyzeTool.call(
        {
          operation: 'predict',
          train_features: [[1, 2]],
          test_features: [[3, 4]],
        } as never,
        fakeContext(),
      ),
    ).rejects.toThrow(/Invalid DataAnalyze input/)
    expect(called).toBe(false)
  })

  test('validateInput: rejects a "question" call missing the table', async () => {
    const result = await DataAnalyzeTool.validateInput?.(
      { operation: 'question', question: 'What is this?' } as never,
    )
    expect(result?.result).toBe(false)
  })

  test('validateInput: accepts a well-formed "forecast" call', async () => {
    const result = await DataAnalyzeTool.validateInput?.({
      operation: 'forecast',
      series: [1, 2, 3],
      horizon: 2,
    })
    expect(result?.result).toBe(true)
  })
})
