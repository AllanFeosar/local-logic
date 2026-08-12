# Specialist head-to-head eval harness

Small, runnable eval harness for the local specialist tools (`AskMathModel`,
`DocumentQA`, `ImageCaption`). This is the "agreed next direction" flagged
in [`LOCAL_AI_STATUS.md`](../../LOCAL_AI_STATUS.md)'s open items and the
Phase 0 exit gate in [`LOCAL_AI_MASTER_PLAN.md`](../../LOCAL_AI_MASTER_PLAN.md)
§8: *"a small head-to-head eval — a handful of real test cases per
specialist, run through both the local ensemble and a single frontier-model
call, compared side by side."*

## What it does

For each specialist, it runs 3-4 real test cases (adapted from that tool's
own `*.live.test.ts` fixture) through the **actual local tool** — a real
call to Ollama (`AskMathModel`) or the Python model bridge (`DocumentQA`,
`ImageCaption`) — and records:

- the local model's answer
- latency (ms)
- confidence, where the tool exposes one (`DocumentQA`'s extraction score)
- a pass/fail against an objective ground truth, where one exists (all 4
  math cases; 3 of 4 DocumentQA cases — the 4th is a deliberately
  unanswerable passage where "correct" means a *low* confidence score, not
  a specific string)
- a **frontier reference answer** column

It prints a compact console summary table and writes a full JSON + Markdown
report to `reports/` (configurable).

Image captions have no objective ground truth — captioning an abstract
Windows wallpaper is inherently subjective. Those cases are recorded (answer
+ latency) for human/frontier review, not graded pass/fail.

## Running it

```sh
# All specialists, default local-only mode
bun run scripts/eval/specialistEval.ts

# Just one specialist
bun run scripts/eval/specialistEval.ts --specialist AskMathModel

# Console output only, skip writing reports/eval-specialists.{json,md}
bun run scripts/eval/specialistEval.ts --no-report

# Write reports somewhere else
bun run scripts/eval/specialistEval.ts --out-dir tmp/eval-out
```

Requires Ollama up on `11434` (for `AskMathModel`) and the Python bridge up
on `8756` (for `DocumentQA`/`ImageCaption` — start with
`python-bridge/start.ps1`). **If a service isn't reachable, that
specialist's cases are skipped with a clear `[SKIPPED]` message and a
`skipped` row in the report — the harness does not hard-fail.** Everything
runs directly against `src/` via `bun run` (same pattern as the other
`scripts/*.ts` — no `bun run build` / `dist/` needed for the harness
itself, though the tools it exercises obviously only reflect real behavior
if you *are* testing against a current build when that matters).

Exit code is non-zero if any case errored or failed its ground-truth check
(useful for CI/regression use later — see "Extending" below).

## The frontier-reference column — deliberately NOT live by default

Per explicit instruction: this harness must never spend the project owner's
money on a paid frontier-model API call without their say-so, and they
weren't available to confirm that's wanted when this was built.

**Default mode**: the frontier column is filled with
`(fill in manually or run with --frontier)`. The harness is immediately
useful on its own for regression-checking the local specialists, and a
human (or a separately-authorized LLM call, e.g. pasting the JSON/MD report
into a chat) can fill in the comparison column later.

**Opt-in mode**: `--frontier` turns on one live text-completion call per
graded `AskMathModel`/`DocumentQA` case, reusing this project's own
`OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY` env vars (the same
shape `AskMathModelTool` itself already uses for its local call). This is
OFF by default and does nothing unless you pass the flag. If your
environment's `OPENAI_BASE_URL` happens to be pointed at a real paid
provider when you pass `--frontier`, **this will spend real API usage** —
the harness prints a `[WARNING]` banner before doing so, but doesn't ask
for further confirmation beyond the flag itself. It fails soft (never
throws) if the env vars aren't configured for a real provider — you'll just
see `(frontier skipped: ...)` in that column instead of a real answer.

`ImageCaption` never gets a live frontier answer, `--frontier` or not — a
real comparison there needs a vision-capable multimodal call, which this
harness does not implement (see "Ambiguous/undecided design choices"
below). Its frontier column always reads a note saying so; fill it in
manually with a vision-capable frontier model if you want that comparison.

## Extending with more specialists

As Tier A/B models come online per the master plan (Qwen3-Reranker,
TabPFN, Whisper, the vision suite, etc.), add:

1. A case list to `cases.ts` (id, description, input, and an
   `expected*`/ground-truth field if the task is objectively checkable —
   see the `MathCase`/`DocQACase`/`CaptionCase` shapes there).
2. A `run<Specialist>Cases(rows, frontier)` function in
   `specialistEval.ts` following the existing three as a template:
   reachability probe → skip gracefully if down → call the tool directly
   (same `fakeContext()` pattern the `*.live.test.ts` files use) → push a
   `ReportRow`.
3. Wire the new `run...Cases` call into `main()`'s `wants(...)` block.

## Ambiguous/undecided design choices (flagged for the project owner)

- **Which "frontier model" the `--frontier` flag calls.** This project
  supports several OpenAI-compatible-shaped providers (OpenAI, Gemini,
  GitHub Models, Codex) plus the default Anthropic login flow, and the
  local-AI profile normally points `OPENAI_BASE_URL` at Ollama. Rather than
  hardcode a specific paid provider/model, `--frontier` just reuses
  whatever `OPENAI_MODEL`/`OPENAI_BASE_URL`/`OPENAI_API_KEY` are already
  set to in the calling shell — meaning by default (local-AI profile
  active) `--frontier` would just call Ollama again, not a real frontier
  model. Getting an actual GPT-5/Gemini/etc. comparison requires the user
  to explicitly export those three env vars for a real provider before
  running with `--frontier`. This seemed like the safest interpretation of
  "gate it behind an opt-in flag" without this script silently picking a
  specific paid model/vendor on the owner's behalf — but it's worth
  confirming that's the intended shape versus, say, a dedicated
  `--frontier-model`/`--frontier-base-url` pair of flags.
- **`ImageCaption` has no `--frontier` path at all** (see above) — captions
  need a multimodal call (base64 image + vision-capable model), which
  wasn't built to avoid scope creep and additional untested surface. If a
  true 3-way caption comparison matters, this needs a follow-up.
- **Ground-truth threshold for the "unanswerable passage" DocumentQA case**
  (`qa-4-answer-not-present`) uses `score < 0.5` as "low confidence enough
  to be correct behavior" — chosen to be well above DistilBERT's typical
  0.99+ confidence on a real match but below what a shaky-but-plausible
  wrong answer might score. Not validated against a large sample; may need
  tuning once more unanswerable cases are added.
- **Report file locations** default to `reports/eval-specialists.{json,md}`,
  matching the existing `doctor:report` → `reports/doctor-runtime.json`
  convention in `package.json`. `reports/` didn't exist before this harness
  and is created on demand (same as `system-check.ts` does for its own
  report).
