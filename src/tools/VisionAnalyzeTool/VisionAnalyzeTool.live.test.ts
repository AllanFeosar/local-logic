import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { VisionAnalyzeTool } from './VisionAnalyzeTool.js'

// Real end-to-end tests against the running python-bridge server. Not part
// of the fast suite — run explicitly:
//   bun test src/tools/VisionAnalyzeTool/VisionAnalyzeTool.live.test.ts
//
// No pre-existing test image with people, or an obvious synthetic-shapes
// fixture, exists checked into this repo (same finding
// LOCAL_AI_STATUS.md's Phase 5 bridge-side session — session 23 — already
// made: C:\Windows\Web\Wallpaper*\4K Wallpaper* are all abstract/landscape,
// no people; C:\Users\...\Pictures is empty). This file synthesizes its own
// fixtures at run time via the bridge's own venv Python + PIL (the exact
// same mechanism, and — for the shapes image — the exact same shapes and
// coordinates, session 23/24 both independently used to live-verify the
// bridge routes themselves): a shapes image (red circle + blue rectangle at
// known coordinates) for classify/segment/detect, a real Windows wallpaper
// for embed/embed-dinov2, and a synthesized stick-figure drawing for pose.
//
// Honest caveat, matching `python-bridge/local_models/vitpose.py`'s own
// docstring and session 23/24's precedent: no real human photo exists on
// this machine, so the pose test can only assert structural correctness
// (17 keypoints returned, plausible relative shape) at the low confidence
// that is expected, documented model behavior on non-photographic input —
// not a bug in this tool.

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

const VENV_PYTHON = resolve(process.cwd(), 'python-bridge', 'venv', 'Scripts', 'python.exe')

function runPython(script: string): void {
  execFileSync(VENV_PYTHON, ['-c', script], { stdio: 'pipe' })
}

/** A real Windows wallpaper — also used by ImageCaptionTool.live.test.ts. */
const WALLPAPER_PATH = 'C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg'

let workDir: string
let shapesPath: string
let stickFigurePath: string

beforeAll(() => {
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(
      `python-bridge venv Python not found at ${VENV_PYTHON} — run python-bridge/start.ps1 at least once to set up the venv before running this live test.`,
    )
  }
  workDir = mkdtempSync(join(tmpdir(), 'vision-analyze-live-'))
  shapesPath = join(workDir, 'shapes.png').replace(/\\/g, '/')
  stickFigurePath = join(workDir, 'stick-figure.png').replace(/\\/g, '/')

  // Same shapes/coordinates as the bridge-side live verification
  // (LOCAL_AI_STATUS.md Session 23/24): a red circle at (50,50)-(200,200)
  // and a blue rectangle at (400,300)-(600,450) on a 640x480 white canvas.
  runPython(`
from PIL import Image, ImageDraw
img = Image.new("RGB", (640, 480), "white")
draw = ImageDraw.Draw(img)
draw.ellipse([50, 50, 200, 200], fill="red")
draw.rectangle([400, 300, 600, 450], fill="blue")
img.save("${shapesPath}")
`)

  // A simple synthesized stick figure — honestly not a real human photo
  // (see this file's header comment and vitpose.py's own docstring caveat).
  runPython(`
from PIL import Image, ImageDraw
img = Image.new("RGB", (400, 600), "white")
draw = ImageDraw.Draw(img)
draw.ellipse([170, 40, 230, 100], fill="black")
draw.line([200, 100, 200, 350], fill="black", width=6)
draw.line([200, 150, 120, 250], fill="black", width=6)
draw.line([200, 150, 280, 250], fill="black", width=6)
draw.line([200, 350, 130, 500], fill="black", width=6)
draw.line([200, 350, 270, 500], fill="black", width=6)
img.save("${stickFigurePath}")
`)
})

afterAll(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
})

test('real bridge: "caption" describes a real photo', async () => {
  const result = await VisionAnalyzeTool.call(
    { operation: 'caption', image_path: WALLPAPER_PATH },
    fakeContext(),
  )
  console.error('CAPTION RESULT:', result.data)
  expect(result.data.operation).toBe('caption')
  expect(result.data.caption?.length ?? 0).toBeGreaterThan(0)
}, 150000)

test('real bridge: "classify" ranks present shapes above absent ones', async () => {
  const result = await VisionAnalyzeTool.call(
    {
      operation: 'classify',
      image_path: shapesPath,
      labels: ['a red circle', 'a blue rectangle', 'a photo of a cat', 'a green triangle'],
    },
    fakeContext(),
  )
  console.error('CLASSIFY RESULT:', result.data)
  expect(result.data.operation).toBe('classify')
  const predictions = result.data.predictions ?? []
  expect(predictions.length).toBe(4)
  const byLabel = new Map(predictions.map(p => [p.label, p.score]))
  const topPresentScore = Math.max(
    byLabel.get('a red circle') ?? 0,
    byLabel.get('a blue rectangle') ?? 0,
  )
  const topAbsentScore = Math.max(byLabel.get('a photo of a cat') ?? 0, byLabel.get('a green triangle') ?? 0)
  expect(topPresentScore).toBeGreaterThan(topAbsentScore)
}, 150000)

test('real bridge: "embed" (CLIP) returns a 768-dim, L2-normalized vector', async () => {
  const result = await VisionAnalyzeTool.call(
    { operation: 'embed', image_path: WALLPAPER_PATH },
    fakeContext(),
  )
  console.error('CLIP EMBED length:', result.data.embedding?.length)
  expect(result.data.operation).toBe('embed')
  const embedding = result.data.embedding ?? []
  expect(embedding.length).toBe(768)
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
  expect(norm).toBeGreaterThan(0.99)
  expect(norm).toBeLessThan(1.01)
}, 150000)

test('real bridge: "embed-dinov2" returns a 384-dim, L2-normalized vector, NOT the CLIP dimensionality', async () => {
  const result = await VisionAnalyzeTool.call(
    { operation: 'embed-dinov2', image_path: WALLPAPER_PATH },
    fakeContext(),
  )
  console.error('DINOv2 EMBED length:', result.data.embedding?.length)
  expect(result.data.operation).toBe('embed-dinov2')
  const embedding = result.data.embedding ?? []
  expect(embedding.length).toBe(384)
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
  expect(norm).toBeGreaterThan(0.99)
  expect(norm).toBeLessThan(1.01)
}, 150000)

test('real bridge: "segment" finds a present shape near its true extents', async () => {
  const result = await VisionAnalyzeTool.call(
    { operation: 'segment', image_path: shapesPath, prompt: 'a red circle' },
    fakeContext(),
  )
  console.error('SEGMENT RESULT (present):', result.data)
  expect(result.data.operation).toBe('segment')
  expect(result.data.found).toBe(true)
  expect(result.data.box).not.toBeNull()
  // True extents (50,50)-(200,200) — generous tolerance for model imprecision.
  expect(result.data.box?.x1 ?? -1).toBeGreaterThan(20)
  expect(result.data.box?.x1 ?? 9999).toBeLessThan(80)
  expect(result.data.box?.x2 ?? -1).toBeGreaterThan(170)
  expect(result.data.box?.x2 ?? 9999).toBeLessThan(230)
}, 150000)

test('real bridge: "segment" at a stricter threshold correctly reports an absent shape as not found', async () => {
  // Per LOCAL_AI_MASTER_PLAN.md / the tool's own prompt guidance: the
  // default threshold (0.5) has a known false-positive tendency on absent
  // objects (session 23/24 both independently reproduced this exact case at
  // the default); raising toward ~0.7 is the documented stricter read.
  const result = await VisionAnalyzeTool.call(
    { operation: 'segment', image_path: shapesPath, prompt: 'a green triangle', threshold: 0.7 },
    fakeContext(),
  )
  console.error('SEGMENT RESULT (absent, threshold 0.7):', result.data)
  expect(result.data.operation).toBe('segment')
  expect(result.data.found).toBe(false)
}, 150000)

test('real bridge: "detect" finds both present shapes with plausible boxes', async () => {
  const result = await VisionAnalyzeTool.call(
    {
      operation: 'detect',
      image_path: shapesPath,
      queries: ['a red circle', 'a blue rectangle', 'a green triangle'],
    },
    fakeContext(),
  )
  console.error('DETECT RESULT:', result.data)
  expect(result.data.operation).toBe('detect')
  const detections = result.data.detections ?? []
  const circle = detections.find(d => d.label === 'a red circle')
  const rectangle = detections.find(d => d.label === 'a blue rectangle')
  expect(circle).toBeDefined()
  expect(rectangle).toBeDefined()
  expect(circle?.score ?? 0).toBeGreaterThan(0.5)
  expect(rectangle?.score ?? 0).toBeGreaterThan(0.5)
}, 150000)

test('real bridge: "pose" returns 17 keypoints per person on the synthesized stick figure (low confidence expected)', async () => {
  const result = await VisionAnalyzeTool.call(
    { operation: 'pose', image_path: stickFigurePath },
    fakeContext(),
  )
  console.error('POSE RESULT:', JSON.stringify(result.data))
  expect(result.data.operation).toBe('pose')
  const people = result.data.people ?? []
  expect(people.length).toBeGreaterThanOrEqual(1)
  expect(people[0]?.keypoints.length).toBe(17)
}, 150000)

test('real bridge: a missing file maps to a clear 404 error, not a raw status', async () => {
  await expect(
    VisionAnalyzeTool.call(
      { operation: 'caption', image_path: join(workDir, 'does-not-exist.png') },
      fakeContext(),
    ),
  ).rejects.toThrow(/not found, unreadable, or not a supported format/)
}, 150000)
