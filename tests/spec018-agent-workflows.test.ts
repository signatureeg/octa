import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))

import { LAUNCH_WORKFLOWS, type WorkflowGateApprovalRequest, type WorkflowStepExecution, type WorkflowStepRunRequest } from '../electron/core/octa/workflows'
import { createLaunchWorkflowGateApprovalHandler, createLaunchWorkflowHandler } from '../electron/core/octa/launch-handlers'
import { AgentsRepository } from '../electron/db/agents'
import { JobsRepository } from '../electron/db/jobs'
import { TaskRepository } from '../electron/db/tasks'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step()
})

function setup(): { home: string; folder: string; agents: AgentsRepository; jobs: JobsRepository; tasks: TaskRepository } {
  const home = mkdtempSync(join(tmpdir(), 'octa-spec-018-'))
  const folder = join(home, 'workflows', 'run-1')
  mkdirSync(folder, { recursive: true })
  const agents = new AgentsRepository(':memory:')
  const jobs = new JobsRepository(':memory:')
  const tasks = new TaskRepository(':memory:')
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => agents.close(), () => jobs.close())
  return { home, folder, agents, jobs, tasks }
}

function request(workflowId: string, stepId: string, folder: string, input: unknown = {}): WorkflowStepRunRequest {
  const workflow = LAUNCH_WORKFLOWS.find((item) => item.id === workflowId)!
  return {
    runId: 'run-1',
    workflow,
    step: workflow.steps.find((item) => item.id === stepId)!,
    input,
    brief: { text: 'test' },
    attempt: 1,
    folder,
    jobId: `run-1-${stepId}-a1`,
    language: 'ar-EG'
  }
}

function approval(workflowId: string, stepId: string, folder: string, output: unknown): WorkflowGateApprovalRequest {
  return {
    runId: 'run-1',
    workflowId,
    workflow: workflowId,
    stepId,
    folder,
    brief: {},
    state: { id: stepId, status: 'waiting_gate', attempt: 1, reviewAttempts: 0, reviewRetries: 0, output, result: output } as WorkflowGateApprovalRequest['state'],
    approvedAt: '2026-09-28T10:00:00.000Z',
    approvedBy: 'owner'
  }
}

const agentJson = {
  name: 'Lead replier',
  identity: 'Drafts first replies to new leads in Egyptian Arabic.',
  scope: 'One first reply per new lead.',
  definitionOfDone: 'A draft per lead in out/replies.md.',
  skills: ['copywriting'],
  tier: 'executor-fast',
  trustStage: 'auto'
}

describe('W7: scope a new agent', () => {
  it('reads agent.json from step s3, reads it back, and registers the agent only after approval', async () => {
    const { home, folder, agents } = setup()
    const s3Out = join(home, 'jobs', 'run-1-s3-a1', 'out')
    mkdirSync(s3Out, { recursive: true })
    writeFileSync(join(s3Out, 'agent.json'), JSON.stringify(agentJson))
    const handler = createLaunchWorkflowHandler({ homePath: home, agents })
    const execution = await handler(request('W7', 's4', folder)) as WorkflowStepExecution & { payload: string }

    expect(execution.status).toBe('ok')
    expect(execution.payload).toContain('الوكيل: Lead replier')
    // a new agent never starts at auto
    expect(execution.payload).toContain('approve-each')
    expect(agents.list()).toHaveLength(0)

    await createLaunchWorkflowGateApprovalHandler({ homePath: home, agents })(approval('W7', 's4', folder, execution.output))
    expect(agents.list()).toEqual([expect.objectContaining({ name: 'Lead replier', trustStage: 'approve-each', createdFrom: 'run-1' })])
  })

  it('fails the step with the validation errors when s3 wrote no usable spec', async () => {
    const { home, folder, agents } = setup()
    const execution = await createLaunchWorkflowHandler({ homePath: home, agents })(request('W7', 's4', folder, { spec: 'no json here' })) as WorkflowStepExecution

    expect(execution.status).toBe('failed')
    expect(execution.notes).toMatch(/No valid out\/agent\.json/)
    expect(agents.list()).toHaveLength(0)
  })
})

describe('W8: weekly retro', () => {
  it('gathers the week, reads proposals back, and turns them into tasks only after approval', async () => {
    const { home, folder, agents, jobs, tasks } = setup()
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString()
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000).toISOString()
    jobs.createJob({ id: 'j-fail', runner: 'claude-plan', status: 'failed', startedAt: recent, input: {} })
    jobs.updateJob('j-fail', { error: 'Failed to authenticate. API Error: 401 (exit code 1).' })
    jobs.createJob({ id: 'j-ok', runner: 'codex-exec', status: 'ok', startedAt: recent, input: {} })
    jobs.createJob({ id: 'j-old', runner: 'codex-exec', status: 'failed', startedAt: old, input: {} })
    const handler = createLaunchWorkflowHandler({ homePath: home, agents, jobs, tasks })

    const evidence = await handler(request('W8', 's1', folder)) as WorkflowStepExecution
    expect(evidence.output).toMatchObject({ totals: { runs: 2, ok: 1, problems: 1 } })
    expect(JSON.stringify(evidence.output)).toContain('API Error: 401')

    const s2Out = join(home, 'jobs', 'run-1-s2-a1', 'out')
    mkdirSync(s2Out, { recursive: true })
    writeFileSync(join(s2Out, 'proposals.json'), JSON.stringify({ proposals: [
      { target: 'setup', change: 'Sign Claude Code in again', why: 'j-fail: API Error: 401', metric: 'No 401 failures next week' },
      { target: 'skill:x', why: 'missing change is dropped' }
    ] }))
    const readback = await handler(request('W8', 's3', folder)) as WorkflowStepExecution & { payload: string }
    expect(readback.payload).toContain('[setup] Sign Claude Code in again')
    expect(tasks.list({})).toHaveLength(0)

    await createLaunchWorkflowGateApprovalHandler({ homePath: home, agents, jobs, tasks })(approval('W8', 's3', folder, readback.output))
    expect(tasks.list({})).toEqual([expect.objectContaining({ title: '[setup] Sign Claude Code in again', project: 'Octa improvements' })])
  })
})
