import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { TranscribeAndSummarizeTool } from './TranscribeAndSummarizeTool.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

function mockRoutedFetch(
  routes: Record<string, { status: number; body: unknown }>,
): { requests: Array<{ url: string; body: unknown }> } {
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url, body })
    const match = Object.entries(routes).find(([path]) => url.includes(path))
    if (!match) throw new Error(`Unexpected fetch to ${url} in test`)
    const [, response] = match
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType
  return { requests }
}

describe('speech present: calls /vad then /transcribe', () => {
  test('mocked: forwards audio_path/language and returns the combined result', async () => {
    const { requests } = mockRoutedFetch({
      '/vad': { status: 200, body: { segments: [{ start: 0.1, end: 3.4 }] } },
      '/transcribe': {
        status: 200,
        body: {
          text: 'Hello, this is a test.',
          language: 'en',
          segments: [{ text: 'Hello, this is a test.', start: 0.1, end: 3.4 }],
        },
      },
    })

    const result = await TranscribeAndSummarizeTool.call(
      { audio_path: 'C:/audio/clip.wav', language: 'en' },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/vad')
    expect(requests[0]?.body).toEqual({ audio_path: 'C:/audio/clip.wav' })
    expect(requests[1]?.url).toContain('/transcribe')
    expect(requests[1]?.body).toEqual({ audio_path: 'C:/audio/clip.wav', language: 'en' })

    expect(result.data).toEqual({
      text: 'Hello, this is a test.',
      language: 'en',
      segments: [{ text: 'Hello, this is a test.', start: 0.1, end: 3.4 }],
      speech_segments: [{ start: 0.1, end: 3.4 }],
      had_speech: true,
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam includes language and transcript', () => {
    const block = TranscribeAndSummarizeTool.mapToolResultToToolResultBlockParam(
      {
        text: 'Hello world.',
        language: 'en',
        segments: [{ text: 'Hello world.', start: 0, end: 1 }],
        speech_segments: [{ start: 0, end: 1 }],
        had_speech: true,
      },
      'tool_1',
    )
    expect(block.content).toBe('[language: en]\nHello world.')
  })
})

describe('no speech: /transcribe is never called', () => {
  test('mocked: returns had_speech: false with empty fields, skipping /transcribe entirely', async () => {
    const { requests } = mockRoutedFetch({
      '/vad': { status: 200, body: { segments: [] } },
    })

    const result = await TranscribeAndSummarizeTool.call(
      { audio_path: 'C:/audio/silence.wav' },
      fakeContext(),
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/vad')
    expect(result.data).toEqual({
      text: '',
      language: '',
      segments: [],
      speech_segments: [],
      had_speech: false,
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam reports "no speech" rather than an empty transcript', () => {
    const block = TranscribeAndSummarizeTool.mapToolResultToToolResultBlockParam(
      { text: '', language: '', segments: [], speech_segments: [], had_speech: false },
      'tool_1',
    )
    expect(block.content).toBe('No speech detected in this audio — nothing to transcribe.')
  })
})

describe('error handling', () => {
  test('mocked: raises a clear error when the bridge is unreachable on the vad step', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    await expect(
      TranscribeAndSummarizeTool.call({ audio_path: 'C:/audio/clip.wav' }, fakeContext()),
    ).rejects.toThrow(/Could not reach the local model bridge/)
  })

  test('mocked: 404 on /vad maps to a clear error and never calls /transcribe', async () => {
    const { requests } = mockRoutedFetch({
      '/vad': { status: 404, body: { detail: 'audio file not found or not readable' } },
    })

    await expect(
      TranscribeAndSummarizeTool.call({ audio_path: 'C:/audio/missing.wav' }, fakeContext()),
    ).rejects.toThrow(/not found, unreadable, or not a supported format/)
    expect(requests).toHaveLength(1)
  })

  test('mocked: 400 (unrecognized language) on /transcribe after a successful /vad surfaces the bridge detail', async () => {
    mockRoutedFetch({
      '/vad': { status: 200, body: { segments: [{ start: 0, end: 1 }] } },
      '/transcribe': { status: 400, body: { detail: "language 'xx' not recognized" } },
    })

    await expect(
      TranscribeAndSummarizeTool.call(
        { audio_path: 'C:/audio/clip.wav', language: 'xx' },
        fakeContext(),
      ),
    ).rejects.toThrow(/rejected the request: language 'xx' not recognized/)
  })
})
