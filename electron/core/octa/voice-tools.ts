import type { AgentRecord, AgentRunRecord, TaskRecord } from '../../types'
import type { WorkRequest } from '../../db/requests'
import type { CompanyInfo } from './companies'

/**
 * Tools the voice session (Gemini Live) can call so the owner can run the company by talking.
 * Workflow-first: asking for work only PROPOSES a request (the workflow, its steps and gates);
 * it starts only after the owner explicitly says yes to that request. Nothing here publishes,
 * sends, pays or deletes.
 */

export const VOICE_TOOL_DECLARATIONS = [
  {
    name: 'list_agents',
    description: 'List the agents Octa manages, by department, with their job and trust level. Call it before choosing an agent if unsure which fits.',
    parameters: { type: 'OBJECT', properties: { department: { type: 'STRING', description: 'Optional: marketing, security, sales, email, operations, planning, development.' } } }
  },
  {
    name: 'request_agent_work',
    description: 'Propose a piece of work for an agent. This does NOT start it: it creates a request with the workflow steps and approval gates. Read the returned summary back to Bedo and ask whether to start it.',
    parameters: {
      type: 'OBJECT',
      properties: {
        agent: { type: 'STRING', description: 'Agent name (or part of it) from list_agents.' },
        task: { type: 'STRING', description: 'What Bedo wants, in his words, with every detail he gave.' }
      },
      required: ['agent']
    }
  },
  {
    name: 'start_request',
    description: 'Start a proposed request. Call this ONLY when Bedo, in his latest turn, clearly said yes / start / ابدأ to that specific request after hearing its summary. Never call it on your own initiative.',
    parameters: { type: 'OBJECT', properties: { request_id: { type: 'STRING' } }, required: ['request_id'] }
  },
  {
    name: 'list_requests',
    description: 'List requests that are proposed and waiting for Bedo\'s go.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'create_task',
    description: 'Add a task to Bedo\'s Tasks page. If an agent is named, also propose a request for that agent (not started).',
    parameters: {
      type: 'OBJECT',
      properties: { title: { type: 'STRING' }, notes: { type: 'STRING' }, agent: { type: 'STRING', description: 'Optional agent to hand the task to.' } },
      required: ['title']
    }
  },
  {
    name: 'agent_status',
    description: 'What an agent did recently: its last runs and whether they were approved, rejected, failed or are waiting.',
    parameters: { type: 'OBJECT', properties: { agent: { type: 'STRING' } }, required: ['agent'] }
  },
  {
    name: 'list_companies',
    description: 'List the companies Octa works for and which one is active now.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'set_company',
    description: 'Switch which company Octa and its agents work for. Use when Bedo says to work on another company.',
    parameters: { type: 'OBJECT', properties: { company: { type: 'STRING', description: 'Company name or slug from list_companies.' } }, required: ['company'] }
  },
  {
    name: 'remember',
    description: 'Save something Bedo wants Octa and every agent to remember from now on (a preference, a decision or a fact). Call it when he says "remember / افتكري / خلي بالك إن…" or clearly states a lasting rule. Say back in one short sentence what you saved.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING', description: 'The thing to remember, in one clear sentence, in his words.' },
        kind: { type: 'STRING', description: 'preference, decision or fact.' }
      },
      required: ['text']
    }
  },
  {
    name: 'note_gap',
    description: 'Log work Bedo asked for that no agent can do yet, so the weekly review can propose a new agent or skill. Use after list_agents shows nothing fits.',
    parameters: { type: 'OBJECT', properties: { what: { type: 'STRING', description: 'What he wanted done.' } }, required: ['what'] }
  }
] as const

export interface VoiceToolDependencies {
  listAgents: () => AgentRecord[]
  agentRuns: (agentId: string) => AgentRunRecord[]
  runStatus: (runId: string) => string | undefined
  proposeRequest: (agentId: string, task: string, taskId?: string) => WorkRequest
  startRequest: (requestId: string) => WorkRequest
  listRequests: () => WorkRequest[]
  createTask: (title: string, notes: string) => TaskRecord
  listCompanies: () => { companies: CompanyInfo[]; active: string }
  setCompany: (slug: string) => { companies: CompanyInfo[]; active: string }
  /** Learning (optional so older callers keep working). */
  remember?: (text: string, kind: string) => { text: string; tag: string } | undefined
  noteGap?: (what: string) => { text: string } | undefined
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[ً-ْـ]/g, '').toLowerCase().trim()
}

/** Finds an agent by id, exact name, or a unique partial match (Arabic tashkeel ignored). */
export function findAgentByName(agents: AgentRecord[], query: string): AgentRecord | { ambiguous: string[] } | undefined {
  const wanted = normalize(query)
  if (!wanted) return undefined
  const exact = agents.find((agent) => agent.id === query || normalize(agent.name) === wanted)
  if (exact) return exact
  const partial = agents.filter((agent) => normalize(agent.name).includes(wanted) || wanted.includes(normalize(agent.name)))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) return { ambiguous: partial.map((agent) => agent.name) }
  return undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function summary(request: WorkRequest): Record<string, unknown> {
  return {
    request_id: request.id,
    title: request.title,
    company: request.company,
    steps: request.steps.map((step) => `${step.name} (${step.who})${step.gate === 'none' ? '' : ` — needs your ${step.gate}`}`),
    status: request.status
  }
}

/** Executes one tool call and returns a small JSON result the voice model can speak from. */
export function executeVoiceTool(name: string, args: Record<string, unknown>, deps: VoiceToolDependencies): Record<string, unknown> {
  const agents = deps.listAgents()
  const pick = (query: string): AgentRecord | Record<string, unknown> => {
    const found = findAgentByName(agents, query)
    if (!found) return { error: `No agent matches "${query}".`, agents: agents.map((agent) => agent.name) }
    if ('ambiguous' in found) return { error: `"${query}" matches several agents; ask which one.`, candidates: found.ambiguous }
    return found
  }

  if (name === 'list_agents') {
    const department = text(args.department).toLowerCase()
    return {
      agents: agents
        .filter((agent) => !department || agent.department === department)
        .map((agent) => ({ name: agent.name, department: agent.department, trust: agent.trustStage, paused: agent.status === 'paused', job: agent.scope }))
    }
  }
  if (name === 'request_agent_work') {
    const agent = pick(text(args.agent))
    if (!('id' in agent)) return agent
    if (agent.status === 'paused') return { error: `${agent.name} is paused.` }
    const request = deps.proposeRequest(String(agent.id), text(args.task))
    return { ...summary(request), next: 'Read this back and ask Bedo whether to start it. It has NOT started.' }
  }
  if (name === 'start_request') {
    const id = text(args.request_id)
    if (!id) return { error: 'Which request? Call list_requests first.' }
    const started = deps.startRequest(id)
    return { ...summary(started), note: 'Started. The draft will wait for Bedo\'s approval in Octa before it counts.' }
  }
  if (name === 'list_requests') {
    return { waiting: deps.listRequests().map(summary) }
  }
  if (name === 'create_task') {
    const title = text(args.title)
    if (!title) return { error: 'A task needs a title.' }
    const task = deps.createTask(title, text(args.notes))
    const agentQuery = text(args.agent)
    if (!agentQuery) return { created: true, task: task.title }
    const agent = pick(agentQuery)
    if (!('id' in agent)) return { created: true, task: task.title, requested: false, ...agent }
    const request = deps.proposeRequest(String(agent.id), '', task.id)
    return { created: true, task: task.title, ...summary(request), next: 'Ask Bedo whether to start it. It has NOT started.' }
  }
  if (name === 'agent_status') {
    const agent = pick(text(args.agent))
    if (!('id' in agent)) return agent
    const recent = deps.agentRuns(String(agent.id)).slice(0, 3).map((run) => ({ started: run.startedAt, result: run.result, status: deps.runStatus(run.jobId) ?? 'unknown', reason: run.reason }))
    return { agent: agent.name, trust: agent.trustStage, runs: agent.runs, approved_clean: agent.cleanRuns, recent }
  }
  if (name === 'list_companies') {
    const state = deps.listCompanies()
    return { active: state.active, companies: state.companies.map((company) => ({ slug: company.slug, name: company.name, website: company.links.website })) }
  }
  if (name === 'set_company') {
    const wanted = normalize(text(args.company))
    const state = deps.listCompanies()
    const match = state.companies.find((company) => company.slug === wanted || normalize(company.name) === wanted)
      ?? state.companies.find((company) => normalize(company.name).includes(wanted) || company.slug.includes(wanted))
    if (!match) return { error: `No company matches "${text(args.company)}".`, companies: state.companies.map((company) => company.name) }
    const next = deps.setCompany(match.slug)
    return { active: next.active, name: match.name }
  }
  if (name === 'remember') {
    if (!deps.remember) return { error: 'Memory is unavailable.' }
    const saved = deps.remember(text(args.text), text(args.kind) || 'preference')
    return saved ? { saved: saved.text, kind: saved.tag } : { error: 'Nothing to remember.' }
  }
  if (name === 'note_gap') {
    if (!deps.noteGap) return { error: 'Gap log is unavailable.' }
    const saved = deps.noteGap(text(args.what))
    return saved ? { logged: saved.text, next: 'The weekly review will propose an agent or skill for it. Nothing was built yet.' } : { error: 'Say what was needed.' }
  }
  return { error: `Unknown tool ${name}.` }
}

export const VOICE_MANAGER_INSTRUCTION = `Your job: you run Bedo's companies with him (Signature first) through departments of AI agents: marketing, security, sales, email, operations, planning, development.
The golden rule: nothing runs without Bedo's go.
- When he asks for work, call request_agent_work (or create_task with an agent). Then tell him naturally, in one or two sentences, who will do it, what they'll do, and where his approval comes in, and ask him "أبدأ؟".
- Call start_request only after he clearly says yes to that exact request. If he changes the ask, propose a new request.
- Not sure which agent fits? call list_agents first. Unclear request? ask one short question.
- agent_status when he asks how something went; list_companies / set_company when he talks about another company.
- You learn: when he tells you to remember something or states a lasting rule, call remember and confirm in one sentence. When he asks for work no agent covers, say so honestly and call note_gap.
- Agents only draft. Publishing, sending, paying and deleting always wait for Bedo's approval in the app; never say something was published or sent.
Never read tool output or IDs aloud; turn results into a short, human sentence.`
