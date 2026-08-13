import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { VisionAnalyzeTool } from './VisionAnalyzeTool.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

function mockFetchOnce(
  status: number,
  body: unknown,
): { requests: Array<{ url: string; body: unknown }> } {
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType
  return { requests }
}

describe('operation "caption" -> /image-caption', () => {
  test('mocked: sends image_path and returns the caption', async () => {
    const { requests } = mockFetchOnce(200, { caption: 'a dog on a beach' })

    const result = await VisionAnalyzeTool.call(
      { operation: 'caption', image_path: 'C:/images/dog.jpg' },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/image-caption')
    expect(requests[0]?.body).toEqual({ image_path: 'C:/images/dog.jpg' })
    expect(result.data).toEqual({ operation: 'caption', caption: 'a dog on a beach' })
  })

  test('mocked: mapToolResultToToolResultBlockParam returns the raw caption', () => {
    const block = VisionAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'caption', caption: 'a dog on a beach' },
      'tool_1',
    )
    expect(block.content).toBe('a dog on a beach')
  })
})

describe('operation "classify" -> /clip-classify', () => {
  test('mocked: sends image_path and labels, returns ranked predictions', async () => {
    const { requests } = mockFetchOnce(200, {
      predictions: [
        { label: 'a cat', score: 0.9 },
        { label: 'a dog', score: 0.1 },
      ],
    })

    const result = await VisionAnalyzeTool.call(
      { operation: 'classify', image_path: 'C:/images/cat.jpg', labels: ['a cat', 'a dog'] },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/clip-classify')
    expect(requests[0]?.body).toEqual({ image_path: 'C:/images/cat.jpg', labels: ['a cat', 'a dog'] })
    expect(result.data).toEqual({
      operation: 'classify',
      predictions: [
        { label: 'a cat', score: 0.9 },
        { label: 'a dog', score: 0.1 },
      ],
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam lists label:score pairs', () => {
    const block = VisionAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'classify', predictions: [{ label: 'a cat', score: 0.9 }] },
      'tool_1',
    )
    expect(block.content).toBe('a cat: 0.900')
  })
})

describe('operation "embed" -> /clip-embed', () => {
  test('mocked: sends image_path and returns the embedding', async () => {
    const { requests } = mockFetchOnce(200, { embedding: [0.1, 0.2, 0.3] })

    const result = await VisionAnalyzeTool.call(
      { operation: 'embed', image_path: 'C:/images/x.jpg' },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/clip-embed')
    expect(requests[0]?.body).toEqual({ image_path: 'C:/images/x.jpg' })
    expect(result.data).toEqual({ operation: 'embed', embedding: [0.1, 0.2, 0.3] })
  })
})

describe('operation "embed-dinov2" -> /dinov2-embed', () => {
  test('mocked: sends image_path and returns the embedding, NOT the CLIP route', async () => {
    const { requests } = mockFetchOnce(200, { embedding: [0.4, 0.5] })

    const result = await VisionAnalyzeTool.call(
      { operation: 'embed-dinov2', image_path: 'C:/images/x.jpg' },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/dinov2-embed')
    expect(requests[0]?.url).not.toContain('/clip-embed')
    expect(result.data).toEqual({ operation: 'embed-dinov2', embedding: [0.4, 0.5] })
  })
})

describe('operation "segment" -> /clipseg-segment', () => {
  test('mocked: sends image_path, prompt, and threshold; returns found/box/confidence/coverage', async () => {
    const { requests } = mockFetchOnce(200, {
      found: true,
      box: { x1: 50, y1: 50, x2: 200, y2: 200 },
      confidence: 0.7,
      coverage: 0.12,
    })

    const result = await VisionAnalyzeTool.call(
      { operation: 'segment', image_path: 'C:/images/shapes.png', prompt: 'a red circle', threshold: 0.7 },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/clipseg-segment')
    expect(requests[0]?.body).toEqual({
      image_path: 'C:/images/shapes.png',
      prompt: 'a red circle',
      threshold: 0.7,
    })
    expect(result.data).toEqual({
      operation: 'segment',
      found: true,
      box: { x1: 50, y1: 50, x2: 200, y2: 200 },
      confidence: 0.7,
      coverage: 0.12,
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam reports "not found" when found is false', () => {
    const block = VisionAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'segment', found: false, box: null },
      'tool_1',
    )
    expect(block.content).toBe('Not found above the threshold.')
  })
})

describe('operation "detect" -> /owlv2-detect', () => {
  test('mocked: sends image_path, queries, and threshold; returns ranked detections', async () => {
    const { requests } = mockFetchOnce(200, {
      detections: [
        { label: 'a red circle', score: 0.94, box: { x1: 50, y1: 50, x2: 200, y2: 200 } },
      ],
    })

    const result = await VisionAnalyzeTool.call(
      {
        operation: 'detect',
        image_path: 'C:/images/shapes.png',
        queries: ['a red circle', 'a blue rectangle'],
        threshold: 0.2,
      },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/owlv2-detect')
    expect(requests[0]?.body).toEqual({
      image_path: 'C:/images/shapes.png',
      queries: ['a red circle', 'a blue rectangle'],
      threshold: 0.2,
    })
    expect(result.data).toEqual({
      operation: 'detect',
      detections: [{ label: 'a red circle', score: 0.94, box: { x1: 50, y1: 50, x2: 200, y2: 200 } }],
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam reports "no detections" for an empty result', () => {
    const block = VisionAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'detect', detections: [] },
      'tool_1',
    )
    expect(block.content).toBe('No detections found.')
  })
})

describe('operation "pose" -> /vitpose-pose', () => {
  test('mocked: sends image_path (no boxes key when omitted), returns people/keypoints', async () => {
    const { requests } = mockFetchOnce(200, {
      people: [
        {
          box: { x1: 0, y1: 0, x2: 400, y2: 600 },
          keypoints: [{ name: 'L_Shoulder', x: 100, y: 120, score: 0.3 }],
        },
      ],
    })

    const result = await VisionAnalyzeTool.call(
      { operation: 'pose', image_path: 'C:/images/person.png' },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/vitpose-pose')
    expect(requests[0]?.body).toEqual({ image_path: 'C:/images/person.png' })
    expect(result.data.operation).toBe('pose')
    expect(result.data.people?.length).toBe(1)
  })

  test('mocked: forwards explicit boxes', async () => {
    const { requests } = mockFetchOnce(200, { people: [] })

    await VisionAnalyzeTool.call(
      { operation: 'pose', image_path: 'C:/images/person.png', boxes: [[90, 30, 220, 480]] },
      fakeContext(),
    )

    expect(requests[0]?.body).toEqual({
      image_path: 'C:/images/person.png',
      boxes: [[90, 30, 220, 480]],
    })
  })
})

describe('error handling', () => {
  test('mocked: raises a clear error when the bridge is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    await expect(
      VisionAnalyzeTool.call({ operation: 'caption', image_path: 'C:/images/x.jpg' }, fakeContext()),
    ).rejects.toThrow(/Could not reach the local model bridge/)
  })

  test('mocked: 404 maps to a clear "not found/unsupported format" error, not a raw status', async () => {
    mockFetchOnce(404, { detail: 'image file not found or not readable' })

    await expect(
      VisionAnalyzeTool.call({ operation: 'caption', image_path: 'C:/images/missing.jpg' }, fakeContext()),
    ).rejects.toThrow(/not found, unreadable, or not a supported format/)
  })

  test('mocked: 404 on classify maps the same way', async () => {
    mockFetchOnce(404, { detail: 'image file not found or not readable' })

    await expect(
      VisionAnalyzeTool.call(
        { operation: 'classify', image_path: 'C:/images/missing.jpg', labels: ['a cat'] },
        fakeContext(),
      ),
    ).rejects.toThrow(/not found, unreadable, or not a supported format/)
  })

  test('mocked: 400 surfaces the bridge detail, not a raw status', async () => {
    // A client-side-well-formed request (passes zod) that the bridge still
    // rejects for a server-side reason not caught client-side (e.g. a
    // caller-supplied label the bridge's own model can't tokenize) —
    // mirrors AudioAnalyzeTool.test.ts's equivalent "language 'xx'" case.
    mockFetchOnce(400, { detail: "label rejected by the model" })

    await expect(
      VisionAnalyzeTool.call(
        { operation: 'classify', image_path: 'C:/images/x.jpg', labels: ['a cat'] },
        fakeContext(),
      ),
    ).rejects.toThrow(/rejected the request: label rejected by the model/)
  })

  test('mocked: call() rejects malformed input (classify with empty labels array) before touching the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as FetchType

    await expect(
      VisionAnalyzeTool.call(
        { operation: 'classify', image_path: 'C:/images/x.jpg', labels: [] } as never,
        fakeContext(),
      ),
    ).rejects.toThrow(/Invalid VisionAnalyze input/)
    expect(called).toBe(false)
  })

  test('mocked: call() rejects cross-operation fields (labels with operation "caption") before touching the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as FetchType

    await expect(
      VisionAnalyzeTool.call(
        { operation: 'caption', image_path: 'C:/images/x.jpg', labels: ['a cat'] } as never,
        fakeContext(),
      ),
    ).rejects.toThrow(/Invalid VisionAnalyze input/)
    expect(called).toBe(false)
  })

  test('mocked: call() rejects an out-of-range segment threshold before touching the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as FetchType

    await expect(
      VisionAnalyzeTool.call(
        {
          operation: 'segment',
          image_path: 'C:/images/x.jpg',
          prompt: 'a red circle',
          threshold: 1.5,
        } as never,
        fakeContext(),
      ),
    ).rejects.toThrow(/Invalid VisionAnalyze input/)
    expect(called).toBe(false)
  })

  test('validateInput: rejects a "detect" call with missing queries', async () => {
    const result = await VisionAnalyzeTool.validateInput?.(
      { operation: 'detect', image_path: 'C:/images/x.jpg' } as never,
    )
    expect(result?.result).toBe(false)
  })

  test('validateInput: accepts a well-formed "pose" call with no boxes', async () => {
    const result = await VisionAnalyzeTool.validateInput?.({
      operation: 'pose',
      image_path: 'C:/images/x.jpg',
    })
    expect(result?.result).toBe(true)
  })
})
