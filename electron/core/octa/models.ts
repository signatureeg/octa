import type { JobRunnerName, ModelTier } from '../../types'
/**
 * Which model runs each phase of Octa's build/workflow engine. Code asks for a phase, never a model id,
 * so the owner can change any phase from Settings without a release. Defaults are the models Octa
 * shipped with; an empty or invalid override falls back to them.
 */

export const MODEL_PHASES = ['plan', 'critic', 'code', 'review', 'analysis', 'skill'] as const
export type ModelPhase = (typeof MODEL_PHASES)[number]

export type PhaseCli = 'claude' | 'codex'

export interface PhaseModel {
  model: string
  effort: string
}

export type PhaseModels = Record<ModelPhase, PhaseModel>

export interface PhaseInfo {
  cli: PhaseCli
  /** Reasoning levels the CLI accepts for this phase ('' = let the CLI decide). */
  efforts: readonly string[]
  /** Models offered in the picker; any other valid id can still be typed. */
  suggestions: readonly string[]
}

const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const CODEX_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] as const
const CODEX_MODELS = ['gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.6-sol'] as const

export const PHASE_INFO: Record<ModelPhase, PhaseInfo> = {
  plan: { cli: 'claude', efforts: CLAUDE_EFFORTS, suggestions: CLAUDE_MODELS },
  critic: { cli: 'codex', efforts: CODEX_EFFORTS, suggestions: CODEX_MODELS },
  code: { cli: 'codex', efforts: CODEX_EFFORTS, suggestions: CODEX_MODELS },
  review: { cli: 'codex', efforts: CODEX_EFFORTS, suggestions: CODEX_MODELS },
  analysis: { cli: 'codex', efforts: CODEX_EFFORTS, suggestions: CODEX_MODELS },
  skill: { cli: 'claude', efforts: CLAUDE_EFFORTS, suggestions: CLAUDE_MODELS }
}

export const DEFAULT_PHASE_MODELS: PhaseModels = {
  plan: { model: 'claude-fable-5-1', effort: 'medium' },
  critic: { model: 'gpt-6-astra', effort: 'xhigh' },
  code: { model: 'gpt-5.6-luna', effort: 'max' },
  review: { model: 'gpt-5.6-sol', effort: 'high' },
  analysis: { model: 'gpt-5.6-luna', effort: 'max' },
  skill: { model: 'claude-sonnet-5', effort: '' }
}

/** Model ids go straight into CLI argv; allow only plain id characters. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,79}$/

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Clean a stored/updated value into a full, valid table. Unknown phases and bad values are dropped. */
export function normalizePhaseModels(value: unknown): PhaseModels {
  const input = record(value)
  const result = {} as PhaseModels
  for (const phase of MODEL_PHASES) {
    const entry = record(input[phase])
    const fallback = DEFAULT_PHASE_MODELS[phase]
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    const effort = typeof entry.effort === 'string' ? entry.effort.trim().toLowerCase() : fallback.effort
    result[phase] = {
      model: MODEL_ID.test(model) ? model : fallback.model,
      effort: PHASE_INFO[phase].efforts.includes(effort) ? effort : fallback.effort
    }
  }
  return result
}

let current: PhaseModels = normalizePhaseModels(DEFAULT_PHASE_MODELS)

/** Called at startup and whenever Settings change. */
export function setPhaseModels(value: unknown): PhaseModels {
  current = normalizePhaseModels(value)
  return current
}

export function phaseModel(phase: ModelPhase): PhaseModel {
  return current[phase]
}

/** `-m <model>` plus `-c model_reasoning_effort="<effort>"` for codex exec. */
export function codexModelArgs(phase: ModelPhase): string[] {
  const { model, effort } = phaseModel(phase)
  return effort ? ['-m', model, '-c', `model_reasoning_effort="${effort}"`] : ['-m', model]
}

/** `--model <model>` plus `--effort <effort>` for claude -p. */
export function claudeModelArgs(phase: ModelPhase): string[] {
  const { model, effort } = phaseModel(phase)
  return effort ? ['--model', model, '--effort', effort] : ['--model', model]
}

// ---------------------------------------------------------------------------------------------
// Tiers (local build, spec 018): roles that agents, plans and voice ask for. Each tier reads one of
// the phases above, so Settings → Models (Abdo's per-phase table) is the single place models change.
// ---------------------------------------------------------------------------------------------


export type ModelCli = PhaseCli

export interface TierModel {
  tier: ModelTier
  cli: ModelCli
  model: string
  effort: string
  /** Tried once when the tier's model is rejected (auth fine, model or CLI version not). */
  fallbackModel?: string
}

export const MODEL_TIERS: readonly ModelTier[] = ['manager', 'critic', 'executor', 'executor-fast', 'reviewer', 'claude-tools']

const TIER_PHASE: Record<ModelTier, ModelPhase> = {
  manager: 'plan',
  critic: 'critic',
  executor: 'code',
  'executor-fast': 'code',
  reviewer: 'review',
  'claude-tools': 'skill'
}

/** A Claude fallback keeps planning alive when the planner model needs a newer CLI; Codex has none by default. */
const TIER_FALLBACK: Partial<Record<ModelTier, string>> = {
  manager: 'claude-sonnet-5'
}

/** Tier each runner uses when the plan does not name one. */
export const RUNNER_DEFAULT_TIER: Partial<Record<JobRunnerName, ModelTier>> = {
  'claude-plan': 'manager',
  'claude-skill': 'claude-tools',
  'codex-exec': 'executor',
  'codex-scout': 'executor',
  'codex-critic': 'critic',
  'codex-review': 'reviewer'
}

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

export function tierPhase(tier: ModelTier): ModelPhase {
  return TIER_PHASE[tier]
}

/** The model a tier runs on right now (from the phase table), with its fallback. */
export function resolveTier(tier: ModelTier, phases: PhaseModels = current): TierModel {
  const phase = TIER_PHASE[tier]
  const { model, effort } = phases[phase]
  const fallbackModel = TIER_FALLBACK[tier]
  return {
    tier,
    cli: PHASE_INFO[phase].cli,
    model,
    // The fast executor is the code phase's model with light reasoning.
    effort: tier === 'executor-fast' ? 'low' : effort,
    ...(fallbackModel && fallbackModel !== model ? { fallbackModel } : {})
  }
}

/** Tier defaults, independent of the owner's Settings (tests and argv defaults). */
export function defaultTierModel(tier: ModelTier): TierModel {
  return resolveTier(tier, DEFAULT_PHASE_MODELS)
}

/**
 * The tier a job runs on. A requested tier is honoured only when it uses the same CLI as the
 * runner (a Codex runner cannot take a Claude model); otherwise the runner's default applies.
 */
export function tierForRunner(runner: JobRunnerName, requested?: ModelTier): ModelTier | undefined {
  const fallback = RUNNER_DEFAULT_TIER[runner]
  if (!fallback) return undefined
  if (requested && PHASE_INFO[TIER_PHASE[requested]].cli === PHASE_INFO[TIER_PHASE[fallback]].cli) return requested
  return fallback
}

/** Distinct (cli, model) pairs the phases use, for the health check. */
export function modelsInUse(phases: PhaseModels = current): Array<{ cli: ModelCli; model: string; phases: ModelPhase[] }> {
  const byKey = new Map<string, { cli: ModelCli; model: string; phases: ModelPhase[] }>()
  for (const phase of MODEL_PHASES) {
    const cli = PHASE_INFO[phase].cli
    const { model } = phases[phase]
    const entry = byKey.get(`${cli}:${model}`) ?? { cli, model, phases: [] }
    entry.phases.push(phase)
    byKey.set(`${cli}:${model}`, entry)
  }
  return [...byKey.values()]
}

export type CliFailureKind = 'auth' | 'model_unavailable' | 'cli_outdated' | 'rate_limit'

export interface CliFailure {
  kind: CliFailureKind
  /** The CLI's own line, trimmed. */
  message: string
  fix: string
}

const FAILURE_PATTERNS: Array<{ kind: CliFailureKind; pattern: RegExp; fix: string }> = [
  {
    kind: 'cli_outdated',
    pattern: /does not support this model|version [\d.]+ or newer is required|please (?:update|upgrade)/i,
    fix: 'Update the CLI (claude update / npm i -g @openai/codex) and try again. / حدّث الأداة وجرّب تاني.'
  },
  {
    kind: 'auth',
    pattern: /failed to authenticate|oauth access token is invalid|not logged in|please (?:log|sign) ?in|invalid api key|\b401\b|unauthori[sz]ed/i,
    fix: 'Sign in again (claude /login or codex login). / سجّل الدخول تاني.'
  },
  {
    kind: 'model_unavailable',
    pattern: /model[^.\n]{0,80}(?:not found|does not exist|not available|no access|not supported)|invalid model|unknown model|\b404\b[^\n]{0,40}model|\b403\b[^\n]{0,40}model|permission[^\n]{0,40}model/i,
    fix: 'Pick another model for this tier in Settings → Models. / اختار موديل تاني للدور ده من الإعدادات.'
  },
  {
    kind: 'rate_limit',
    pattern: /rate limit|\b429\b|overloaded|usage limit/i,
    fix: 'Wait a few minutes, or switch the tier to another model. / استنى شوية أو غيّر الموديل.'
  }
]

/** Recognises the CLI error lines behind "Process exited with code 1". */
export function classifyCliFailure(text: string | undefined): CliFailure | undefined {
  if (!text) return undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    for (const candidate of FAILURE_PATTERNS) {
      if (candidate.pattern.test(trimmed)) return { kind: candidate.kind, message: trimmed.slice(0, 400), fix: candidate.fix }
    }
  }
  return undefined
}

/** Failures a different model can get around (the CLI works, this model does not). */
export function fallbackCanHelp(failure: CliFailure | undefined): boolean {
  return failure?.kind === 'model_unavailable' || failure?.kind === 'cli_outdated'
}
