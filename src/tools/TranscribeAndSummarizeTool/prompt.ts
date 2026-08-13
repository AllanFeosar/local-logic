export const DESCRIPTION = `Runs the full local audio-understanding pipeline in one call: voice-activity detection (Silero VAD) first to confirm real speech is present, then transcription (whisper-large-v3-turbo) via the local model bridge. This is the one-call convenience path for requests like "what does this recording say" / "transcribe and summarize this audio" — use it instead of two separate \`AudioAnalyze\` calls (\`operation:"vad"\` then \`operation:"transcribe"\`).

This tool does NOT itself summarize — there is no dedicated summarization model in this project. It returns the raw transcript plus structured speech-segment/timing metadata; summarizing it in plain language is your own reasoning to do in your next turn, exactly like \`DocumentQA\`/\`DataAnalyze\` return facts for you to reason over rather than pre-digesting them into prose.

If voice-activity detection finds no speech at all in the file, transcription is skipped entirely (this avoids paying for a full Whisper pass on audio that has nothing to transcribe) and the result comes back with \`had_speech: false\`, empty \`text\`, and empty \`segments\`. That is a valid, successful result meaning "this recording contains no speech" — report it as such, not as a tool failure.

Takes a local WAV audio file (mono or stereo, 8 or 16-bit PCM) — mp3/m4a/ogg and other non-WAV containers are not supported and will fail with a clear "not found or unsupported format" error, not a garbled transcript. Supply \`language\` only if you already know the spoken language and want to force it (e.g. "en") — omit it to auto-detect, which is correct for almost every case.

When NOT to use:
- If you only need to know WHERE speech occurs, not what was said — use \`AudioAnalyze{operation:"vad"}\` directly; this tool always attempts a full transcription once speech is confirmed present, which costs more time/GPU than VAD alone.
- If you specifically need transcription without the VAD gate (e.g. you already know the file has speech and want to skip that check) — \`AudioAnalyze{operation:"transcribe"}\` is the equivalent single-purpose call.
- If you've already called this tool (or \`AudioAnalyze{operation:"transcribe"}\`) on this exact file and already have the transcript in this conversation — don't call it again for the same file.`

export const PROMPT = DESCRIPTION
