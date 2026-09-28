import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ BrowserWindow: class {}, app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import { RequestsRepository } from '../electron/db/requests'
import { AgentsRepository } from '../electron/db/agents'
import { createLaunchWorkflowHandler } from '../electron/core/octa/launch-handlers'
import { LAUNCH_WORKFLOWS, validateWorkflow, type WorkflowStepExecution, type WorkflowStepRunRequest } from '../electron/core/octa/workflows'

const cleanup: Array<() => void> = []
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step() })

const steps = [{ id: 's1', name: 'RCCF brief', who: 'Octa', gate: 'none' as const }, { id: 's2', name: 'drafts', who: 'Agent', gate: 'approve' as const }]

describe('work requests', () => {
  it('are proposed, start once, and cannot start after cancel', () => {
    const repo = new RequestsRepository(':memory:')
    cleanup.push(() => repo.close())
    const one = repo.create({ title: 'Content plan', company: 'signature', workflowId: 'W9', agentId: 'a1', agentName: 'Planner', task: 'next week', source: 'app', steps })
    expect(one).toMatchObject({ status: 'proposed', runId: null, steps })
    expect(repo.list('proposed').map((item) => item.id)).toEqual([one.id])
    expect(repo.markStarted(one.id, 'run-1')).toMatchObject({ status: 'started', runId: 'run-1' })
    expect(() => repo.markStarted(one.id, 'run-2')).toThrow(/already started/)
    expect(() => repo.cancel(one.id)).toThrow(/Only a proposed request/)

    const two = repo.create({ title: 'Audit', company: 'signature', workflowId: 'W9', source: 'voice', steps })
    expect(repo.cancel(two.id).status).toBe('cancelled')
    expect(() => repo.markStarted(two.id, 'run-3')).toThrow(/already started or cancelled/)
    expect(() => repo.create({ title: ' ', company: 'signature', workflowId: 'W9', source: 'app', steps })).toThrow(/title/)
    expect(() => repo.create({ title: 'x', company: 'signature', workflowId: 'W9', source: 'app', steps: [] })).toThrow(/step/)
  })
})

describe('W9 agent-task workflow', () => {
  it('is a valid workflow whose agent step waits for the owner', () => {
    const w9 = LAUNCH_WORKFLOWS.find((workflow) => workflow.id === 'W9')!
    expect(validateWorkflow(w9).valid).toBe(true)
    expect(w9.steps.map((step) => [step.id, step.gate])).toEqual([['s1', 'none'], ['s2', 'approve']])
  })

  it('writes the RCCF brief, then hands it to the agent runner', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octa-w9-'))
    const folder = join(home, 'workflows', 'run-9')
    mkdirSync(folder, { recursive: true })
    const agents = new AgentsRepository(':memory:')
    cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => agents.close())
    const agent = agents.create({ name: 'Content Planner', identity: 'Plans content.', scope: 'Weekly plan.', definitionOfDone: 'out/plan.md', skills: ['content-strategy'], tier: 'executor', trustStage: 'draft-only' })
    const seen: Array<{ brief: string; company: string }> = []
    const handler = createLaunchWorkflowHandler({
      homePath: home,
      agents,
      agentJobRunner: async ({ brief, company, request }) => { seen.push({ brief, company }); return { status: 'ok', output: { done: true }, folder: request.folder, jobId: request.jobId, payload: 'draft ready' } as WorkflowStepExecution }
    })
    const w9 = LAUNCH_WORKFLOWS.find((workflow) => workflow.id === 'W9')!
    const request = (stepId: string, input: unknown = {}): WorkflowStepRunRequest => ({
      runId: 'run-9', workflow: w9, step: w9.steps.find((step) => step.id === stepId)!, input,
      brief: { agentId: agent.id, task: 'plan next week', company: 'signature' }, attempt: 1, folder, jobId: `run-9-${stepId}-a1`
    })

    const brief = await handler(request('s1')) as WorkflowStepExecution & { output: { brief: string } }
    expect(brief.status).toBe('ok')
    expect(readFileSync(join(folder, 'out', 'brief.md'), 'utf8')).toContain('## Command\n\nplan next week')
    const work = await handler(request('s2', { brief: brief.output })) as WorkflowStepExecution & { payload: string }
    expect(work.payload).toBe('draft ready')
    expect(seen).toEqual([{ brief: brief.output.brief, company: 'signature' }])
  })
})
