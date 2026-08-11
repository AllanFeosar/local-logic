# Cross-Agent Handoff Report — Template

Used by any sub-agent in this project's `.claude/agents/` roster to hand off a
finished piece of integration work to whichever agent builds on it next.

**Save each report to:** `.claude/contracts/handoffs/<YYYY-MM-DD>_<from-agent>-to-<to-agent>_<feature-slug>.md`
Never overwrite a previous report — each handoff is its own file, so the chain stays auditable.

---

## Protocol for the receiving agent (do this before writing any code)
1. **Check completeness first** — run the Required fields checklist below against the report. A report failing any item is incomplete, not just unverified: stop and report back "blocked, incomplete handoff: `<missing item>`" to the orchestrator for re-dispatch to the sender, rather than filling the gap with an assumption.
2. **Check the report's claims** — read it fully; don't take any claimed field, status, or "done" marker at face value.
3. **Check the project structure** — open the actual files it references (routers, models, stores, schema, infra config, etc.) and confirm the change is still real: not already done, not stale, not conflicting with what's actually there.
4. **Decide if it's worth doing** — if the check shows the change is unnecessary, already satisfied, or contradicts current architecture, stop and say so instead of implementing; if it holds up, proceed.
5. **Do the work.**
6. **Run your Self-verification check** (defined in your agent file) and make it pass before writing the completion report — a handoff report for unverified work poisons the whole chain. If the check still fails after your attempt budget, the report must say so in Known gaps, not claim done.
7. **On completion, produce a new report** in this same format — run the Required fields checklist against your own report before saving it — and route it to whichever agent owns the next dependency — that may be the original sender, a different agent, or nobody if the chain ends here. The orchestrator dispatches whichever agent is named.

---

## Required fields (completion criterion — check before sending, and before accepting)
A report isn't ready to send, and isn't ready to accept, until every item below is true. This is checkable, not aspirational — a missing or placeholder value fails the item:
- [ ] Project context has no unfilled `[bracketed placeholder]` left
- [ ] Section 1 lists every endpoint/component/table this side owns, each with an explicit ✅ / ⚠️ / ❌ status — not a prose summary standing in for the list
- [ ] Section 2 gives exact field names and types for every touchpoint named in Section 1 — no "similar to before" or "unchanged" shortcuts that skip restating them
- [ ] Section 4 either lists at least one gap with Severity/Owner/Fix, or explicitly states "No known gaps" — an empty section with no statement either way fails this item
- [ ] Both "Next action for [SENDING AGENT]" and "Next action for [RECEIVING AGENT]" lines are present and name a concrete next step, not "continue as planned"

A report that fails this checklist is incomplete — treat it exactly like a failed self-verification check, not a lesser issue to route around.

---

## Report body

You are the **[SENDING AGENT]** on a cross-team integration.
Generate a structured handoff report for **[RECEIVING AGENT]**.

### Project context
- Project: [project name]
- Feature: [feature name]
- Branch: [branch name]
- Date: [date]

### 1. What this side has implemented
List every endpoint / component / store slice / table that is ready.
For each: method, URL or name, request shape, response shape, status (✅ done / ⚠️ partial / ❌ missing).

### 2. Exact field-level contract
For every API endpoint or schema touchpoint, list:
- Request: exact field names, types, required/optional, source (body / route / query)
- Response: exact field names, types, nesting structure (e.g. `response.data.data.data`)
- Any field-name mismatches between store / DTO / schema on either side

### 3. Confirmed correct — do not change
List anything already verified working on both sides so the receiving agent doesn't re-investigate it.

### 4. Known gaps / blockers
List each gap with:
- Severity: BREAKING / HIGH / MEDIUM / LOW
- Owner: [name of the agent that owns the fix]
- Exact fix required (SQL, code snippet, or config change)

### 5. Prerequisites before integration testing
List in order: migrations to run, services to deploy, env vars to set, store/hook wiring needed.

### 6. Open questions for the receiving agent
List only genuine unknowns the other side must answer — not assumptions.

## Format rules
- Use tables where comparing fields side by side
- Use ✅ / ❌ / ⚠️ for status
- Include exact field names and types — no vague descriptions
- Keep each section under 20 lines
- End with: "Next action for [SENDING AGENT]:" and "Next action for [RECEIVING AGENT]:" — one sentence each
