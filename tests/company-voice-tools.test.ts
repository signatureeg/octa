import { afterEach, describe, expect, it } from 'vitest'
import { VOICE_TOOL_DECLARATIONS as PLANNER_VOICE_TOOL_DECLARATIONS } from '../electron/core/voice/tools'
import { executeVoiceTool, findAgentByName, VOICE_TOOL_DECLARATIONS, type VoiceToolDependencies } from '../electron/core/octa/voice-tools'
import { RequestsRepository } from '../electron/db/requests'
import type { AgentRecord, TaskRecord } from '../electron/types'

let requests: RequestsRepository | undefined
afterEach(() => { requests?.close(); requests = undefined })

function agent(id: string, name: string, department = 'marketing', status: AgentRecord['status'] = 'active'): AgentRecord {
  return {
    id, name, department, status, identity: 'i', scope: `scope of ${name}`, definitionOfDone: 'd', skills: [], tier: 'executor',
    trustStage: 'draft-only', createdFrom: null, createdAt: '', updatedAt: '', cleanStreak: 0, runs: 0, cleanRuns: 0
  }
}

const AGENTS = [agent('a1', 'مخطط المحتوى'), agent('a2', 'مسوّق الأداء'), agent('a3', 'مراجع أمان الموقع', 'security'), agent('a4', 'كاتب سكريبتات الريلز')]

function deps(started: string[] = [], companies = { active: 'signature', companies: [{ slug: 'signature', name: 'Signature', links: { website: 'https://signaturee.net' }, files: [], hasMasterPrompt: true }, { slug: 'acme', name: 'Acme Clinic', links: {}, files: [], hasMasterPrompt: false }] }): VoiceToolDependencies {
  requests = new RequestsRepository(':memory:')
  const repo = requests
  let state = companies
  return {
    listAgents: () => AGENTS,
    agentRuns: () => [{ agentId: 'a1', jobId: 'run-1', startedAt: '2026-09-28T10:00:00Z', result: 'clean' }],
    runStatus: () => 'ok',
    proposeRequest: (agentId, task, taskId) => {
      const found = AGENTS.find((item) => item.id === agentId)!
      return repo.create({ title: `${found.name}: ${task || 'standing job'}`, company: state.active, workflowId: 'W9', agentId, agentName: found.name, task, taskId, source: 'voice', steps: [{ id: 's1', name: 'RCCF brief', who: 'Octa', gate: 'none' }, { id: 's2', name: 'drafts', who: found.name, gate: 'approve' }] })
    },
    startRequest: (requestId) => { started.push(requestId); return repo.markStarted(requestId, `run-${requestId}`) },
    listRequests: () => repo.list('proposed'),
    createTask: (title, notes) => ({ id: 't1', title, notes } as TaskRecord),
    listCompanies: () => state,
    setCompany: (slug) => { state = { ...state, active: slug }; return state }
  }
}

describe('voice tools (workflow-first)', () => {
  it('finds agents by partial Arabic names, ignoring tashkeel, and reports ambiguity', () => {
    expect(findAgentByName(AGENTS, 'مسوق الأداء')).toMatchObject({ id: 'a2' })
    expect(findAgentByName(AGENTS, 'مخطط')).toMatchObject({ id: 'a1' })
    expect(findAgentByName([...AGENTS, agent('a5', 'كاتب الإعلانات')], 'كاتب')).toEqual({ ambiguous: ['كاتب سكريبتات الريلز', 'كاتب الإعلانات'] })
    expect(findAgentByName(AGENTS, 'nobody')).toBeUndefined()
  })

  it('asking for work only proposes a request; it starts only on start_request', () => {
    const started: string[] = []
    const tools = deps(started)
    const proposed = executeVoiceTool('request_agent_work', { agent: 'مخطط المحتوى', task: 'خطة الأسبوع' }, tools) as { request_id: string; steps: string[]; next: string }
    expect(proposed.next).toContain('NOT started')
    expect(proposed.steps[1]).toContain('needs your approve')
    expect(started).toEqual([])
    expect((executeVoiceTool('list_requests', {}, tools) as { waiting: unknown[] }).waiting).toHaveLength(1)
    expect(executeVoiceTool('start_request', { request_id: proposed.request_id }, tools)).toMatchObject({ status: 'started' })
    expect(started).toEqual([proposed.request_id])
    expect(() => executeVoiceTool('start_request', { request_id: proposed.request_id }, tools)).toThrow(/already started/)
  })

  it('a task handed to an agent by voice is proposed, not started', () => {
    const started: string[] = []
    const result = executeVoiceTool('create_task', { title: 'راجع الموقع', agent: 'أمان' }, deps(started)) as Record<string, unknown>
    expect(result).toMatchObject({ created: true, status: 'proposed' })
    expect(started).toEqual([])
  })

  it('refuses paused agents and unknown names without proposing anything', () => {
    const tools = { ...deps(), listAgents: () => [agent('p', 'Paused one', 'marketing', 'paused')] }
    expect(executeVoiceTool('request_agent_work', { agent: 'Paused one' }, tools)).toEqual({ error: 'Paused one is paused.' })
    expect(executeVoiceTool('request_agent_work', { agent: 'ghost' }, deps())).toMatchObject({ error: 'No agent matches "ghost".' })
  })

  it('lists and switches companies by name', () => {
    const tools = deps()
    expect(executeVoiceTool('list_companies', {}, tools)).toMatchObject({ active: 'signature' })
    expect(executeVoiceTool('set_company', { company: 'acme' }, tools)).toEqual({ active: 'acme', name: 'Acme Clinic' })
    expect(executeVoiceTool('set_company', { company: 'nope' }, tools)).toMatchObject({ error: 'No company matches "nope".' })
  })
})


describe('one voice session, two tool sets', () => {
  it("Abdo's planner tools and Octa's company tools never share a name (main.ts routes by name)", () => {
    const planner = PLANNER_VOICE_TOOL_DECLARATIONS.map((tool) => tool.name as string)
    const company = VOICE_TOOL_DECLARATIONS.map((tool) => tool.name as string)
    expect(planner.filter((name) => company.includes(name))).toEqual([])
  })
})
