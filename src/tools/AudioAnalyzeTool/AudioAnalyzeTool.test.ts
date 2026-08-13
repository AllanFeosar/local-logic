import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { AudioAnalyzeTool } from './AudioAnalyzeTool.js'

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

describe('operation "transcribe" -> /transcribe', () => {
  test('mocked: sends audio_path (and no language key when omitted) and returns the parsed result', async () => {
    const { requests } = mockFetchOnce(200, {
      text: 'The quick brown fox.',
      language: 'en',
      segments: [{ text: 'The quick brown fox.', start: 0, end: 1.5 }],
    })

    const result = await AudioAnalyzeTool.call(
      { operation: 'transcribe', audio_path: 'C:/audio/clip.wav' },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/transcribe')
    expect(requests[0]?.body).toEqual({ audio_path: 'C:/audio/clip.wav' })
    expect(result.data).toEqual({
      operation: 'transcribe',
      text: 'The quick brown fox.',
      language: 'en',
      segments: [{ text: 'The quick brown fox.', start: 0, end: 1.5 }],
    })
  })

  test('mocked: forwards an explicit language', async () => {
    const { requests } = mockFetchOnce(200, {
      text: 'Bonjour.',
      language: 'fr',
      segments: [],
    })

    await AudioAnalyzeTool.call(
      { operation: 'transcribe', audio_path: 'C:/audio/clip.wav', language: 'fr' },
      fakeContext(),
    )

    expect(requests[0]?.body).toEqual({
      audio_path: 'C:/audio/clip.wav',
      language: 'fr',
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam includes language and transcript', () => {
    const block = AudioAnalyzeTool.mapToolResultToToolResultBlockParam(
      {
        operation: 'transcribe',
        text: 'Hello world.',
        language: 'en',
        segments: [{ text: 'Hello world.', start: 0, end: 1 }],
      },
      'tool_1',
    )
    expect(block.content).toContain('[language: en]')
    expect(block.content).toContain('Hello world.')
    expect(block.content).toContain('1 segment')
  })
})

describe('operation "vad" -> /vad', () => {
  test('mocked: sends audio_path and tuning params, returns speech_segments', async () => {
    const { requests } = mockFetchOnce(200, {
      segments: [{ start: 0.1, end: 2.5 }, { start: 4.0, end: 6.2 }],
    })

    const result = await AudioAnalyzeTool.call(
      {
        operation: 'vad',
        audio_path: 'C:/audio/clip.wav',
        threshold: 0.6,
        min_speech_duration_ms: 300,
      },
      fakeContext(),
    )

    expect(requests[0]?.url).toContain('/vad')
    expect(requests[0]?.body).toEqual({
      audio_path: 'C:/audio/clip.wav',
      threshold: 0.6,
      min_speech_duration_ms: 300,
    })
    expect(result.data).toEqual({
      operation: 'vad',
      speech_segments: [{ start: 0.1, end: 2.5 }, { start: 4.0, end: 6.2 }],
    })
  })

  test('mocked: mapToolResultToToolResultBlockParam reports "no speech" for an empty result', () => {
    const block = AudioAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'vad', speech_segments: [] },
      'tool_1',
    )
    expect(block.content).toBe('No speech detected in this audio.')
  })

  test('mocked: mapToolResultToToolResultBlockParam reports segment count and timestamps otherwise', () => {
    const block = AudioAnalyzeTool.mapToolResultToToolResultBlockParam(
      { operation: 'vad', speech_segments: [{ start: 0.1, end: 2.5 }] },
      'tool_1',
    )
    expect(block.content).toContain('1 speech segment detected')
    expect(block.content).toContain('0.10-2.50s')
  })
})

describe('error handling', () => {
  test('mocked: raises a clear error when the bridge is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as FetchType

    await expect(
      AudioAnalyzeTool.call(
        { operation: 'transcribe', audio_path: 'C:/audio/clip.wav' },
        fakeContext(),
      ),
    ).rejects.toThrow(/Could not reach the local model bridge/)
  })

  test('mocked: 404 maps to a clear "not found/unsupported format" error, not a raw status', async () => {
    mockFetchOnce(404, { detail: 'audio file not found or not readable' })

    await expect(
      AudioAnalyzeTool.call(
        { operation: 'transcribe', audio_path: 'C:/audio/missing.wav' },
        fakeContext(),
      ),
    ).rejects.toThrow(/not found, unreadable, or not a supported format/)
  })

  test('mocked: 404 on vad maps the same way', async () => {
    mockFetchOnce(404, { detail: 'audio file not found or not readable' })

    await expect(
      AudioAnalyzeTool.call(
        { operation: 'vad', audio_path: 'C:/audio/missing.wav' },
        fakeContext(),
      ),
    ).rejects.toThrow(/not found, unreadable, or not a supported format/)
  })

  test('mocked: 400 (unrecognized language) surfaces the bridge detail, not a raw status', async () => {
    mockFetchOnce(400, { detail: "language 'xx' not recognized" })

    await expect(
      AudioAnalyzeTool.call(
        { operation: 'transcribe', audio_path: 'C:/audio/clip.wav', language: 'xx' },
        fakeContext(),
      ),
    ).rejects.toThrow(/rejected the request: language 'xx' not recognized/)
  })

  test('mocked: call() rejects malformed input (vad threshold out of range) before touching the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as FetchType

    await expect(
      AudioAnalyzeTool.call(
        { operation: 'vad', audio_path: 'C:/audio/clip.wav', threshold: 1.5 } as never,
        fakeContext(),
      ),
    ).rejects.toThrow(/Invalid AudioAnalyze input/)
    expect(called).toBe(false)
  })

  test('mocked: call() rejects cross-operation fields (threshold with operation "transcribe") before touching the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as FetchType

    await expect(
      AudioAnalyzeTool.call(
        { operation: 'transcribe', audio_path: 'C:/audio/clip.wav', threshold: 0.5 } as never,
        fakeContext(),
      ),
    ).rejects.toThrow(/Invalid AudioAnalyze input/)
    expect(called).toBe(false)
  })

  test('validateInput: rejects a "vad" call with an out-of-range threshold', async () => {
    const result = await AudioAnalyzeTool.validateInput?.(
      { operation: 'vad', audio_path: 'C:/audio/clip.wav', threshold: 0 } as never,
    )
    expect(result?.result).toBe(false)
  })

  test('validateInput: accepts a well-formed "transcribe" call', async () => {
    const result = await AudioAnalyzeTool.validateInput?.({
      operation: 'transcribe',
      audio_path: 'C:/audio/clip.wav',
    })
    expect(result?.result).toBe(true)
  })
})
