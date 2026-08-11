import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { ImageCaptionTool } from './ImageCaptionTool.js'

// Real end-to-end test against the running python-bridge server. Not part
// of the fast suite — run explicitly:
//   bun test src/tools/ImageCaptionTool/ImageCaptionTool.live.test.ts

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}
test('real bridge: captions a real local image file', async () => {
  const result = await ImageCaptionTool.call(
    { image_path: 'C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg' },
    fakeContext(),
    )
  console.error('CAPTION:', result.data.caption)
  expect(result.data.caption.length).toBeGreaterThan(0)
}, 60000)
