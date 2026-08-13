import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { AudioAnalyzeTool } from './AudioAnalyzeTool.js'

// Real end-to-end tests against the running python-bridge server. Not part
// of the fast suite — run explicitly:
//   bun test src/tools/AudioAnalyzeTool/AudioAnalyzeTool.live.test.ts
//
// Needs real audio. No pre-existing speech WAV file exists in this repo or
// an obvious Windows sample-media location (see LOCAL_AI_STATUS.md's Phase 4
// session — Windows' own C:\Windows\Media\*.wav are UI sound effects, not
// speech), so this file synthesizes its own test fixtures at run time:
// real (if synthetic) speech via Windows' built-in SAPI TTS
// (System.Speech.Synthesis, the same mechanism used to live-verify the
// bridge routes themselves), plus a small hand-rolled silent-WAV writer for
// the "no speech" case. Both are self-contained — no checked-in binary
// audio fixture needed, and nothing here depends on the bridge-side
// session's own temp files still existing.

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

/** Minimal PCM WAV writer (RIFF header + all-zero 16-bit mono samples) —
 * just enough to produce a valid, silence-only WAV for the "no speech"
 * test case, without any external dependency. */
function writeSilentWav(outPath: string, durationSeconds: number, sampleRate = 16000): void {
  const numSamples = Math.round(durationSeconds * sampleRate)
  const dataSize = numSamples * 2 // 16-bit mono, samples default-zeroed by Buffer.alloc
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20) // AudioFormat = PCM
  buffer.writeUInt16LE(1, 22) // NumChannels = mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // ByteRate
  buffer.writeUInt16LE(2, 32) // BlockAlign
  buffer.writeUInt16LE(16, 34) // BitsPerSample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  writeFileSync(outPath, buffer)
}

let workDir: string
let speechWavPath: string
let silentWavPath: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'audio-analyze-live-'))
  speechWavPath = join(workDir, 'speech.wav')
  silentWavPath = join(workDir, 'silence.wav')
  synthesizeSpeechWav('The quick brown fox jumps over the lazy dog.', speechWavPath)
  writeSilentWav(silentWavPath, 2)
})

afterAll(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
})

test('real bridge: transcribes synthesized speech correctly', async () => {
  const result = await AudioAnalyzeTool.call(
    { operation: 'transcribe', audio_path: speechWavPath },
    fakeContext(),
  )
  console.error('TRANSCRIBE RESULT:', result.data)
  expect(result.data.operation).toBe('transcribe')
  expect(result.data.text?.toLowerCase()).toContain('fox')
  expect(result.data.language).toBe('en')
}, 150000)

test('real bridge: vad finds a speech segment in synthesized speech', async () => {
  const result = await AudioAnalyzeTool.call(
    { operation: 'vad', audio_path: speechWavPath },
    fakeContext(),
  )
  console.error('VAD RESULT (speech):', result.data)
  expect(result.data.operation).toBe('vad')
  expect(result.data.speech_segments?.length ?? 0).toBeGreaterThan(0)
}, 150000)

test('real bridge: vad finds no speech in a synthesized silent clip', async () => {
  const result = await AudioAnalyzeTool.call(
    { operation: 'vad', audio_path: silentWavPath },
    fakeContext(),
  )
  console.error('VAD RESULT (silence):', result.data)
  expect(result.data.operation).toBe('vad')
  expect(result.data.speech_segments).toEqual([])
}, 150000)

test('real bridge: a missing file maps to a clear 404 error, not a raw status', async () => {
  await expect(
    AudioAnalyzeTool.call(
      { operation: 'transcribe', audio_path: join(workDir, 'does-not-exist.wav') },
      fakeContext(),
    ),
  ).rejects.toThrow(/not found, unreadable, or not a supported format/)
}, 150000)
