# Task: spec 018 — Octa as manager agent: model routing, agent factory, improvement loop

Status: PROPOSED — needs the owner's approval before any code is written.

## Why

Octa already has a manager/specialist shape (runtime contract §1): Fable plans, Astra critiques, Luna executes, Sol reviews, Sonnet runs Claude-tool skills, Gemini talks. Three gaps stop it from acting as a real manager:

1. **Models are hard-coded** in `electron/core/jobs/runner.ts` (`buildClaudePlanArgv` → `claude-fable-5-1`, `buildCodexExecArgv` → `gpt-5.6-luna`, …). Changing a model means a release, and when a model is unreachable the job dies with `Process exited with code 1`. The real cause was only in `log.jsonl`. Live example from 24 Sep: four planner runs failed on `401 OAuth access token is invalid` and `Claude Code 2.1.149 does not support this model; version 2.1.251 or newer is required`, and the UI showed only "exit code 1".
2. **Agents are not a thing.** W7 (scope-new-agent) scopes an agent and writes `out/agent-spec.md`, but nothing turns that spec into something that runs, has a scope, a trust level and a track record.
3. **Nothing learns from outcomes.** `workflow_stats` counts runs, but rejections, review failures and rework never flow back into prompts, skills or routing.

## Scope

### 1. Model registry (`electron/core/octa/models.ts`)
- Tiers, not model names, in code: `manager`, `critic`, `executor`, `executor-fast`, `reviewer`, `claude-tools`, `voice`. Each tier maps to `{ cli: 'claude' | 'codex' | 'gemini', model, effort }`.
- Defaults equal today's hard-coded values, so behaviour does not change on upgrade.
- Overrides are stored in `app_settings` (`modelTiers` JSON). Settings gets a "Models / النماذج" section: one row per tier, with a model field and a "test" button that runs the health ping for that tier.
- Every `build*Argv` in `runner.ts` reads its model/effort from the registry. No model string remains in `runner.ts` (a test greps for this).
- Health (spec 013) gains one check per distinct `(cli, model)` in use. It pings with `--model` so "CLI too old for this model" and "no access to this model" show up in Health, not as a failed job.

### 2. Honest failures and fallback
- When a CLI exits non-zero, the job's `error` is the last error line the CLI printed (API error / auth / version), not only `Process exited with code N`. Keep the code as a suffix.
- Known unreachable-model errors (401 auth, 400 "does not support this model", 403/404 model access) are classified as `model_unavailable`. The step retries once on the tier's `fallback` (configurable; default `critic` ↔ `manager` swap for planning, `executor-fast` for `executor`), and the planner/UI shows a warning with the fix ("run `claude update`", "sign in again").
- Never silently downgrades an outward step: if the fallback also fails, the step stops at a gate with the real error.

### 3. Per-step routing by the manager
- The plan schema (runtime contract §3.1) gains an optional `tier` per step. The planner system prompt gets a short routing rubric: judgment, planning and ambiguous briefs → `manager`; bulk research, code and file work → `executor`; cheap transforms (rewrite, translate, format) → `executor-fast`; anything needing MCP/Claude tools → `claude-tools`.
- Validation rejects unknown tiers. Astra's critique may challenge a routing choice like any other plan issue, and it lands in `debate.md`.
- When `tier` is absent, the runner's current default applies (backwards compatible with W1–W7).

### 4. Agent factory (`agents` table + Agents page)
- An agent = `{ id, name, identity (SOUL/IDENTITY/USER), narrow scope, definitionOfDone, skills[], tier, trustStage: 'draft-only' | 'approve-each' | 'auto', schedule?, createdFrom (W7 run id), stats }`.
- W7 step s4 (already gated on an explicit go) creates the agent record from `out/agent-spec.md` (schema-validated). If the agent needs a new skill, the step creates it via `skill-creator` into `skills-library/skills/<name>` and registers it in `MANIFEST.json` with `verdict: client`.
- An agent runs as a workflow step (`runner` from its tier, `skill` from its skills) or on its schedule through `recurring_jobs`. Its gates follow `trustStage`: `draft-only` never sends anything outward, `approve-each` gates every outward step, `auto` gates only what the global rules require (money, publishing, deleting stay gated at every stage).
- New sidebar page "Agents / الوكلاء": list, trust stage, last runs, success rate, and edit scope/DoD. Bilingual, RTL, same card/button classes as Workflows.

### 5. Improvement loop (approval-gated, never self-editing)
- After every agent or workflow run, record: Sol review verdict, gate decision (approved / rejected / edited + comment), retries, `model_unavailable` events.
- Promotion ladder per agent: 10 consecutive clean approvals → Octa *proposes* moving up one trust stage. Any rejection or failed review → drops one stage immediately and says why.
- A weekly recurring job "retro" (tier `manager`) reads the last 7 days of failures, rejections and gate comments. It writes concrete proposals: prompt edits to a skill's `SKILL.md`, a routing change for a tier, a new acceptance line, a workflow step change. Proposals go to the existing brain proposals queue (spec 005). Nothing is applied without the owner's approval. Applied proposals are recorded with the metric they target, and the next retro reports whether it moved.

## Acceptance
- No model id string remains in `runner.ts`; changing the `executor` tier in Settings changes the `-m` passed to `codex exec` on the next job (unit test on argv).
- A fake CLI exiting with `API Error: 400 … does not support this model` marks the job `model_unavailable`, retries once on the fallback tier, and the job's `error` contains the API message (fixtures for 401 / 400 / exit 1 with no message).
- Health shows one row per configured `(cli, model)`; a model the CLI rejects is red with the CLI's message and a fix hint.
- A plan with `tier: "executor-fast"` on a step runs that step with the `executor-fast` model; an unknown tier fails validation with a clear error.
- Running W7 end to end on a seeded brief creates exactly one `agents` row only after the s4 approval; rejecting s4 creates none.
- Agents page renders in ar/en, dark/light, at 960 px, with no English literals in `ar` (render test).
- Promotion: 10 seeded clean runs produce one pending promotion proposal; one seeded rejection demotes and records the reason.
- Retro job on seeded failures produces ≥1 proposal in the brain queue and changes no file until approved.
- `npm run typecheck && npm test` green.

## Out of scope
- Octa editing its own source code. The retro proposes; builds (spec 010) and the owner decide.
- Any autonomy that removes the money / publishing / deleting gates.
