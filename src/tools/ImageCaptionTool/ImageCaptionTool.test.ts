import { afterEach, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { ImageCaptionTool } from './ImageCaptionTool.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}
test('mocked: sends image_path to the bridge and returns the caption', async () => {
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ caption: 'a dog on a beach' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const result = await ImageCaptionTool.call(
    { image_path: 'C:/images/dog.jpg' },
    fakeContext(),
    )

  expect(requestBody).toEqual({ image_path: 'C:/images/dog.jpg' })
  expect(result.data).toEqual({ caption: 'a dog on a beach' })
})

test('mocked: raises a clear error on 404 (file not found)', async () => {
  globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as FetchType

  await expect(
    ImageCaptionTool.call(
      { image_path: 'C:/nope.jpg' },
      fakeContext(),
      ),
  ).rejects.toThrow(/not found/)
})

test('mocked: raises a clear error when the bridge is unreachable', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as FetchType

  await expect(
    ImageCaptionTool.call(
      { image_path: 'C:/x.jpg' },
      fakeContext(),
      ),
  ).rejects.toThrow(/Could not reach the local model bridge/)
})
