# Handoff reports

Point-in-time integration reports produced by sub-agents using
`.claude/contracts/handoff-report-template.md`.

Naming: `<YYYY-MM-DD>_<from-agent>-to-<to-agent>_<feature-slug>.md`
Example: `2026-07-01_api-agent-to-web-agent_checkout-flow.md`

Each file is a snapshot — don't edit or overwrite one after the fact. If the
context changes, the next agent in the chain writes a new report instead.
