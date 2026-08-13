import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { TranscribeAndSummarizeTool } from './TranscribeAndSummarizeTool.js'

// Real end-to-end tests against the running python-bridge server. Not part
// of the fast suite — run explicitly:
//   bun test src/tools/TranscribeAndSummarizeTool/TranscribeAndSummarizeTool.live.test.ts
//
// Same self-contained audio-fixture approach as
// AudioAnalyzeTool.live.test.ts (see that file's own comment for why) —
// duplicated here rather than shared, since it's ~30 lines of test-only
// fixture code, not production logic.

function fakeContext(): ToolUseContext {
  return { abortController: new AbortController() } as unknown as ToolUseContext
}

function synthesizeSpeechWav(text: string, outPath: string): void {
  const escapeForSingleQuotedPs = (s: string) => s.replace(/'/g, "''")
  const psScript = [
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$synth.SetOutputToWaveFile('${escapeForSingleQuotedPs(outPath)}')`,
    `$synth.Speak('${escapeForSingleQuotedPs(text)}')`,
    '$synth.Dispose()',
  ].join('; ')
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { stdio: 'pipe' },
  )
}

function writeSilentWav(outPath: string, durationSeconds: number, sampleRate = 16000): void {
  const numSamples = Math.round(durationSeconds * sampleRate)
  const dataSize = numSamples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  writeFileSync(outPath, buffer)
}

let workDir: string
let speechWavPath: string
let silentWavPath: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'transcribe-summarize-live-'))
  speechWavPath = join(workDir, 'speech.wav')
  silentWavPath = join(workDir, 'silence.wav')
  synthesizeSpeechWav(
    'This is a test of the local transcription pipeline, running entirely offline.',
    speechWavPath,
  )
  writeSilentWav(silentWavPath, 2)
})

afterAll(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
})

test('real bridge: transcribes real speech and reports had_speech: true', async () => {
  const result = await TranscribeAndSummarizeTool.call(
    { audio_path: speechWavPath },
    fakeContext(),
  )
  console.error('PIPELINE RESULT (speech):', result.data)
  expect(result.data.had_speech).toBe(true)
  expect(result.data.text.toLowerCase()).toContain('transcription')
  expect(result.data.language).toBe('en')
  expect(result.data.speech_segments.length).toBeGreaterThan(0)
  expect(result.data.segments.length).toBeGreaterThan(0)
}, 150000)

test('real bridge: skips transcription and reports had_speech: false on a silent clip', async () => {
  const result = await TranscribeAndSummarizeTool.call(
    { audio_path: silentWavPath },
    fakeContext(),
  )
  console.error('PIPELINE RESULT (silence):', result.data)
  expect(result.data).toEqual({
    text: '',
    language: '',
    segments: [],
    speech_segments: [],
    had_speech: false,
  })
}, 150000)

test('real bridge: a missing file maps to a clear 404 error, not a raw status', async () => {
  await expect(
    TranscribeAndSummarizeTool.call(
      { audio_path: join(workDir, 'does-not-exist.wav') },
      fakeContext(),
    ),
  ).rejects.toThrow(/not found, unreadable, or not a supported format/)
}, 150000)
