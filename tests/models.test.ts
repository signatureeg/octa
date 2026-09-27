import { afterEach, describe, expect, it } from 'vitest'
import { buildClaudePlanArgv, buildClaudeSkillArgv, buildCodexCriticArgv, buildCodexExecArgv, buildCodexReviewArgv } from '../electron/core/jobs/runner'
import { buildReviewArgv } from '../electron/core/octa/review'
import { DEFAULT_PHASE_MODELS, normalizePhaseModels, phaseModel, setPhaseModels } from '../electron/core/octa/models'
import { nextStartTime, PLAYBACK_LEAD_SECONDS } from '../src/audio/voice-player'

const context = { workspace: 'C:\\Octa\\jobs\\j1', skillPath: 'C:\\skills\\s1' }
const after = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

afterEach(() => { setPhaseModels(DEFAULT_PHASE_MODELS) })

describe('models per phase', () => {
  it('defaults to the models Octa shipped with', () => {
    expect(after(buildClaudePlanArgv(context), '--model')).toBe('claude-fable-5-1')
    expect(after(buildClaudePlanArgv(context), '--effort')).toBe('medium')
    expect(after(buildCodexExecArgv(context), '-m')).toBe('gpt-5.6-luna')
    expect(buildCodexExecArgv(context)).toContain('model_reasoning_effort="max"')
    expect(after(buildCodexCriticArgv(context), '-m')).toBe('gpt-6-astra')
    expect(after(buildCodexReviewArgv(context), '-m')).toBe('gpt-5.6-sol')
    expect(after(buildReviewArgv('C:\\w'), '-m')).toBe('gpt-5.6-sol')
    const skill = buildClaudeSkillArgv(context)
    expect(after(skill, '--model')).toBe('claude-sonnet-5')
    expect(skill).not.toContain('--effort')
  })

  it('changes only the phase the owner edited', () => {
    setPhaseModels({ ...DEFAULT_PHASE_MODELS, code: { model: 'gpt-6-astra', effort: 'high' }, plan: { model: 'claude-opus-5-5', effort: 'high' } })
    const exec = buildCodexExecArgv(context)
    expect(after(exec, '-m')).toBe('gpt-6-astra')
    expect(exec).toContain('model_reasoning_effort="high"')
    expect(after(buildClaudePlanArgv(context), '--model')).toBe('claude-opus-5-5')
    expect(after(buildCodexCriticArgv(context), '-m')).toBe('gpt-6-astra')
    expect(after(buildCodexReviewArgv(context), '-m')).toBe('gpt-5.6-sol')
  })

  it('leaves the reasoning flag out when the level is "default"', () => {
    setPhaseModels({ review: { model: 'gpt-5.6-sol', effort: '' } })
    expect(buildCodexReviewArgv(context).join(' ')).not.toContain('model_reasoning_effort')
  })

  it('falls back per phase on empty, unsafe or unknown values', () => {
    const models = normalizePhaseModels({
      plan: { model: '', effort: 'medium' },
      code: { model: 'gpt-5.6-luna" -c sandbox="danger', effort: 'high' },
      review: { model: 'gpt-5.6-sol', effort: 'ultra"' },
      bogus: { model: 'x', effort: 'high' }
    })
    expect(models.plan.model).toBe(DEFAULT_PHASE_MODELS.plan.model)
    expect(models.code.model).toBe(DEFAULT_PHASE_MODELS.code.model)
    expect(models.review.effort).toBe(DEFAULT_PHASE_MODELS.review.effort)
    expect(Object.keys(models)).not.toContain('bogus')
    expect(normalizePhaseModels(undefined)).toEqual(DEFAULT_PHASE_MODELS)
    expect(phaseModel('analysis')).toEqual(DEFAULT_PHASE_MODELS.analysis)
  })
})

describe('voice playback scheduling', () => {
  it('queues chunks back to back and gives the first chunk after a gap a short lead', () => {
    expect(nextStartTime(10, 10.5)).toBe(10.5)
    expect(nextStartTime(10, 9.9)).toBeCloseTo(10 + PLAYBACK_LEAD_SECONDS)
    expect(nextStartTime(10, 0)).toBeCloseTo(10 + PLAYBACK_LEAD_SECONDS)
  })
})
