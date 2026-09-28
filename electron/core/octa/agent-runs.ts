import type { AgentRecord, JobStartRequest } from '../../types'
import { runPolicy } from './agents'

/** Skills like performance-marketer ship dozens of reference files; the 300k default cut runs short. */
export const AGENT_INPUT_TOKEN_BUDGET = 1_500_000

/**
 * The one place an agent's work becomes a job (used by W9 step s2 in the app and by the terminal
 * test command, so both run exactly the same thing).
 *
 * - Claude tiers (manager, claude-tools): the first skill is the agent's system prompt and every other
 *   skill is mounted as a Claude Code sub-agent the agent can delegate to.
 * - Codex tiers (executor, executor-fast): every skill is inlined; the sandbox may reach the network
 *   so research and site checks work.
 * Nothing here sends or publishes: the draft waits at the W9 approval gate.
 */
/** What the independent reviewer checks on a lead agent's run with a team (strong review, owner rule). */
export function teamAcceptance(agent: Pick<AgentRecord, 'definitionOfDone'>): string[] {
  return [
    agent.definitionOfDone,
    'out/diagnosis.md exists: the lead decided persona, awareness stage, offer, message and 3C stage before briefing anyone.',
    'out/review-log.md exists and shows every specialist draft checked point by point against its checklist, with what was sent back and why.',
    'The final deliverable contains only work that passed the review; nothing contradicts the company brain, its lessons or the owner memory.',
    'No invented numbers, prices, client stories, quotes or results; missing facts are listed as questions.',
    'Nothing was published, sent, paid or deleted.'
  ]
}

export function agentJobSpec(
  agent: Pick<AgentRecord, 'name' | 'skills' | 'tier' | 'trustStage' | 'department'> & Partial<Pick<AgentRecord, 'team' | 'definitionOfDone'>>,
  brief: string,
  company: string,
  extra: Partial<JobStartRequest> = {}
): JobStartRequest {
  const [primary, ...others] = agent.skills
  const team = agent.team ?? []
  // Specialists only exist as Claude sub-agents, so a lead with a team always runs on Claude.
  const claude = Boolean(primary) && (agent.tier === 'manager' || agent.tier === 'claude-tools' || team.length > 0)
  return {
    runner: claude ? 'claude-skill' : 'codex-exec',
    tier: agent.tier,
    ...(primary ? { skill: primary } : {}),
    ...(others.length ? { extraSkills: others } : {}),
    prompt: brief,
    company,
    input: { agent: agent.name, skills: agent.skills },
    department: agent.department,
    workflow: `agent:${agent.name}`,
    gate: 'none',
    autonomy: runPolicy(agent.trustStage).autonomy,
    network: true,
    // A lead with a team gets the independent review on top of its own review of the specialists.
    ...(team.length
      ? { team, skipReview: false, acceptance: teamAcceptance({ definitionOfDone: agent.definitionOfDone ?? 'The deliverable meets the task.' }) }
      : { skipReview: true }),
    inputTokenBudget: AGENT_INPUT_TOKEN_BUDGET,
    ...extra
  }
}
