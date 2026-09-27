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
