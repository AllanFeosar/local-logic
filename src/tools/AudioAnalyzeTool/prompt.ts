export const DESCRIPTION = `Delegates audio-understanding tasks to local specialist models (whisper-large-v3-turbo for transcription, Silero VAD for voice-activity detection) via the local model bridge. This is ONE tool with two operations, not two tools — pick exactly one operation per call and only supply the fields that operation needs. Both operations take a local WAV audio file (mono or stereo, 8 or 16-bit PCM) — mp3/m4a/ogg and other non-WAV containers are not supported and will fail with a clear "not found or unsupported format" error, not a garbled result.

operation "transcribe" — converts the speech in an audio file into text, e.g.:
- "What does this recording say?"
- "Transcribe this voice memo."
Returns the full text plus per-segment timestamps and the detected (or supplied) language. Supply \`language\` only if you already know the spoken language and want to force it (e.g. "en") — omit it to auto-detect, which is correct for almost every case; an unrecognized \`language\` value is rejected with a clear error rather than silently ignored.

operation "vad" — detects WHERE speech occurs in an audio file (segment start/end times in seconds) WITHOUT transcribing anything, e.g.:
- "Does this recording actually contain any speech, or is it just noise/silence?"
- "How many separate speech segments are in this clip, and when do they start and stop?"
This never returns any words. \`threshold\`/\`min_speech_duration_ms\`/\`min_silence_duration_ms\`/\`speech_pad_ms\` are optional tuning knobs (defaults 0.5/250/100/30) — leave them unset unless you have a specific reason to tune sensitivity.

When NOT to use this tool:
- If the request is "transcribe this" / "what does this say" / "transcribe and summarize this recording" — prefer \`TranscribeAndSummarize\` instead. It's the one-call convenience path: it runs voice-activity detection first (so it doesn't pay for a full transcription pass on audio that turns out to have no speech at all) and then transcribes, in a single tool call, returning the same transcript plus speech-segment metadata. Calling \`AudioAnalyze{operation:"transcribe"}\` directly still works, but always runs the full transcription unconditionally.
- Do NOT call operation "vad" just because the user wants a transcript — it returns timestamps only, never words. Reach for it only when the actual question is about speech presence or timing, not content.
- Non-speech audio understanding (music genre, sound/event classification, speaker identification) — neither operation does this; there is no specialist for it in this project yet.

Output: \`text\`/\`language\`/\`segments\` are only present for operation "transcribe"; \`speech_segments\` is only present for operation "vad". An empty \`speech_segments\` list is a real, useful finding ("this recording has no speech in it"), not a failure — report it as such.`

export const PROMPT = DESCRIPTION
