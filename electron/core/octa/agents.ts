import type { AgentOutcome, AgentRecord, AgentSpec, AgentTrustStage, JobAutonomy, JobGate, ModelTier, SubAgentSpec } from '../../types'
import { isModelTier } from './models'

/**
 * Agents (spec 018): a narrow, named job with an identity, a Definition of Done, the skills it
 * may use, a model tier and a trust stage. W7 proposes one; the owner approves it into being.
 *
 * Trust ladder: draft-only -> approve-each -> auto. Moving up is only ever *proposed* (after
 * PROMOTION_STREAK clean runs in a row) and needs the owner's approval. Any rejected or failed run
 * moves the agent down one stage immediately. Money, publishing and deleting stay gated at every
 * stage: `auto` only drops the per-run review gate, never an outward gate.
 */

export const AGENT_TRUST_STAGES: readonly AgentTrustStage[] = ['draft-only', 'approve-each', 'auto']
export const PROMOTION_STREAK = 10

// Letters of any script with their combining marks (Arabic shadda, tashkeel), digits, and light punctuation.
const NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._()&'-]{0,63}$/u

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function isTrustStage(value: unknown): value is AgentTrustStage {
  return typeof value === 'string' && (AGENT_TRUST_STAGES as readonly string[]).includes(value)
}

export interface AgentSpecValidation {
  valid: boolean
  errors: string[]
  spec?: AgentSpec
}

/** Validates the agent.json W7 writes (or any hand-written spec). */
export function validateAgentSpec(value: unknown): AgentSpecValidation {
  // Library persona files are long; identity keeps up to 12k characters so a full persona fits.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['Agent spec must be a JSON object.'] }
  const raw = value as Record<string, unknown>
  const errors: string[] = []
  const name = text(raw.name, 64)
  if (!NAME.test(name)) errors.push('name must be 1-64 letters, digits, spaces, dots, dashes or underscores.')
  const identity = text(raw.identity, 12_000)
  if (!identity) errors.push('identity is required (who the agent is and how it works).')
  const scope = text(raw.scope, 2_000)
  if (!scope) errors.push('scope is required (the single narrow job).')
  const definitionOfDone = text(raw.definitionOfDone ?? raw.definition_of_done, 2_000)
  if (!definitionOfDone) errors.push('definitionOfDone is required.')
  const skills = Array.isArray(raw.skills)
    ? [...new Set(raw.skills.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 12)
    : []
  const tier: ModelTier = raw.tier === undefined ? 'executor' : isModelTier(raw.tier) ? raw.tier : 'executor'
  if (raw.tier !== undefined && !isModelTier(raw.tier)) errors.push('tier must be a known model tier.')
  const trustStage: AgentTrustStage = raw.trustStage === undefined && raw.trust_stage === undefined
    ? 'draft-only'
    : isTrustStage(raw.trustStage ?? raw.trust_stage) ? (raw.trustStage ?? raw.trust_stage) as AgentTrustStage : 'draft-only'
  if ((raw.trustStage ?? raw.trust_stage) !== undefined && !isTrustStage(raw.trustStage ?? raw.trust_stage)) errors.push('trustStage must be draft-only, approve-each or auto.')
  // A new agent never starts above approve-each: auto has to be earned on the ladder.
  const startStage: AgentTrustStage = trustStage === 'auto' ? 'approve-each' : trustStage
  const department = text(raw.department, 40).toLowerCase().replace(/\s+/g, '-') || 'general'
  const schedule = text(raw.schedule, 64) || undefined
  if (schedule && !['daily', 'weekly', 'monthly'].includes(schedule)) errors.push('schedule must be daily, weekly or monthly when set.')
  const team = validateTeam(raw.team, errors)
  if (errors.length) return { valid: false, errors }
  return {
    valid: true,
    errors: [],
    spec: { name, identity, scope, definitionOfDone, skills, tier, trustStage: startStage, department, ...(schedule ? { schedule: schedule as AgentSpec['schedule'] } : {}), ...(team.length ? { team } : {}) }
  }
}

const SUB_AGENT_SLUG = /^[a-z][a-z0-9-]{1,47}$/

function stringList(value: unknown, max: number, each: number): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, each)).filter(Boolean))].slice(0, max)
    : []
}

/** Specialists under a lead agent; every problem is reported so the owner sees them all at once. */
export function validateTeam(value: unknown, errors: string[]): SubAgentSpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push('team must be a list of specialists.')
    return []
  }
  if (value.length > 12) errors.push('team can have at most 12 specialists.')
  const seen = new Set<string>()
  return value.slice(0, 12).flatMap((item, index): SubAgentSpec[] => {
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const label = `team[${index}]`
    const slug = text(raw.slug, 48)
    const member: SubAgentSpec = {
      slug,
      name: text(raw.name, 64),
      role: text(raw.role, 8_000),
      scope: text(raw.scope, 2_000),
      definitionOfDone: text(raw.definitionOfDone, 2_000),
      skills: stringList(raw.skills, 8, 80),
      checklist: stringList(raw.checklist, 15, 400),
      tools: raw.tools === 'research' ? 'research' : 'write'
    }
    const problems: string[] = []
    if (!SUB_AGENT_SLUG.test(slug)) problems.push(`${label}.slug must be lowercase latin letters, digits or dashes.`)
    else if (seen.has(slug)) problems.push(`${label}.slug "${slug}" is used twice.`)
    if (!member.name) problems.push(`${label}.name is required.`)
    if (!member.role) problems.push(`${label}.role is required.`)
    if (!member.scope) problems.push(`${label}.scope is required.`)
    if (!member.definitionOfDone) problems.push(`${label}.definitionOfDone is required.`)
    if (member.skills.length === 0) problems.push(`${label}.skills needs at least one skill.`)
    if (member.checklist.length === 0) problems.push(`${label}.checklist needs at least one review point.`)
    seen.add(slug)
    errors.push(...problems)
    return problems.length ? [] : [member]
  })
}

/** Gate and autonomy a run gets at each trust stage. */
export function runPolicy(stage: AgentTrustStage): { gate: JobGate; autonomy: JobAutonomy } {
  if (stage === 'draft-only') return { gate: 'review', autonomy: 'led' }
  if (stage === 'approve-each') return { gate: 'approve', autonomy: 'assisted' }
  return { gate: 'none', autonomy: 'auto' }
}

export function stageBelow(stage: AgentTrustStage): AgentTrustStage {
  return AGENT_TRUST_STAGES[Math.max(0, AGENT_TRUST_STAGES.indexOf(stage) - 1)]
}

export function stageAbove(stage: AgentTrustStage): AgentTrustStage | undefined {
  return AGENT_TRUST_STAGES[AGENT_TRUST_STAGES.indexOf(stage) + 1]
}

export interface LadderDecision {
  trustStage: AgentTrustStage
  cleanStreak: number
  pendingPromotion?: AgentTrustStage
  /** Set when this outcome moved the agent down. */
  demotedBecause?: string
}

/**
 * Applies one finished run to the ladder. Pure, so the repository and the tests share it.
 * `clean` = the run finished ok, passed review and was not rejected at its gate.
 */
export function applyOutcome(agent: Pick<AgentRecord, 'trustStage' | 'cleanStreak' | 'pendingPromotion'>, outcome: AgentOutcome): LadderDecision {
  if (outcome.result === 'clean') {
    const cleanStreak = agent.cleanStreak + 1
    const next = stageAbove(agent.trustStage)
    const pendingPromotion = agent.pendingPromotion ?? (next && cleanStreak >= PROMOTION_STREAK ? next : undefined)
    return { trustStage: agent.trustStage, cleanStreak, ...(pendingPromotion ? { pendingPromotion } : {}) }
  }
  if (outcome.result === 'pending') {
    return { trustStage: agent.trustStage, cleanStreak: agent.cleanStreak, ...(agent.pendingPromotion ? { pendingPromotion: agent.pendingPromotion } : {}) }
  }
  const reason = outcome.reason || (outcome.result === 'rejected' ? 'Output rejected at the gate.' : 'Run failed.')
  return { trustStage: stageBelow(agent.trustStage), cleanStreak: 0, demotedBecause: reason }
}

/**
 * The prompt an agent run starts from, in RCCF form (Role, Context, Command, Format) with the
 * 3-point QA. The company's master prompt and brain are added by the job runner.
 */
export function agentPrompt(agent: Pick<AgentRecord, 'name' | 'identity' | 'scope' | 'definitionOfDone'>, task: string, company?: string): string {
  return [
    `# Agent: ${agent.name}`,
    '## Role',
    agent.identity,
    '## Context',
    [
      company ? `Company: ${company} (its master prompt and brain are below; follow them).` : 'Company: the one whose brain is below.',
      `Your standing job (stay inside it): ${agent.scope}`,
      'Constraints: never send, publish, pay or delete anything; write drafts to out/ for the owner. Do not invent facts, numbers or quotes the brain does not give you; list what is missing as questions instead.'
    ].join('\n'),
    '## Command',
    [
      task.trim() || 'Run your standing job once and report.',
      'Where a choice is involved, give 3 options and say which you recommend and why. If the ask is weak, push back and offer a better path.',
      'If the task falls outside your job, stop and say so instead of doing it.'
    ].join('\n'),
    '## Format',
    [
      agent.definitionOfDone,
      'End with the single next step for the owner.',
      'Before finishing, run the 3-point QA: 1) is it simple, 2) is it useful today, 3) is the next step clear. Fix what fails.'
    ].join('\n')
  ].join('\n\n')
}
